// Reconciles a reviewed CSV preview. Preview by default; apply requires explicit file hash + quantity.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
const args=process.argv.slice(2), dirs=args.filter(a=>!a.startsWith('--'));
if(dirs.length!==1||args.some(a=>a.startsWith('--')&&a!=='--apply'&&!/^--expect-sha256=[a-f0-9]{64}$/.test(a)&&!/^--expect-qty=\d+$/.test(a)))throw Error('Usage: node operations/import-ribbon-stock.mjs PREVIEW_DIR [--apply --expect-sha256=HASH --expect-qty=COUNT]');
const apply=args.includes('--apply');
const expectedHash=args.find(a=>a.startsWith('--expect-sha256='))?.slice(16);
const expectedQty=Number(args.find(a=>a.startsWith('--expect-qty='))?.slice(13));
if(apply&&(!expectedHash||!Number.isSafeInteger(expectedQty)))throw Error('Apply requires reviewed CSV hash and quantity');
const dir=path.resolve(dirs[0]);
const [summary,plan,occupancy,source,issues]=await Promise.all(['summary','plan','occupancy','source-snapshot','issues'].map(async name=>JSON.parse(await fs.readFile(path.join(dir,name+'.json')))));
const csv=await fs.readFile(summary.source);
const hash=crypto.createHash('sha256').update(csv).digest('hex');
if(hash!==summary.sha256||apply&&(expectedHash!==hash||expectedQty!==summary.matchedQty))throw Error('CSV/hash/quantity mismatch; rerun stock preview');
if(!summary.readOnly||summary.blockers!==0||summary.matchedEntries!==plan.length||summary.groupedRows!==plan.length||summary.totalCsvQty!==summary.matchedQty||plan.reduce((n,r)=>n+r.csvQty,0)!==summary.matchedQty)throw Error('Preview has blockers or inconsistent totals');
if(summary.resetId!=='ae1-ribbon-reset-2026-10-11T10-50-52-326Z')throw Error('Unexpected reset baseline');
if(summary.sourceRows!==576||summary.matchedEntries!==573)throw Error('Unexpected row count; rerun review');
const id=v=>String(v);const byId=new Map(source.products.map(p=>[id(p._id),p]));const slots=new Map(source.slots.map(s=>[id(s._id),s]));
const target=s=>s?.store==='AE1'&&/^[D-R]$/.test(s.unit);
const seen=new Set();
for(const r of plan){
 const slot=slots.get(r.slotId),product=byId.get(r.productId),key=r.slotId+'|'+r.productId;
 if(!slot||!target(slot)||!product||product.productType!=='Ribbon'||!Number.isSafeInteger(r.csvQty)||r.csvQty<=0||!Number.isFinite(product.cbm)||product.cbm<=0||seen.has(key)||r.sku!==product.sku||r.currentQty!==0||r.action!=='create'||r.hypotheticalResult!==r.csvQty||r.unitCbm!==product.cbm)throw Error('Invalid plan row: '+r.sku);
 seen.add(key);
}
if(summary.currentTargetRibbonQty!==0||summary.targetReservedQty!==0||summary.postResetTargetMovements!==0||summary.existingSlotItemsToIncrease!==0||summary.newSlotItems!==plan.length)throw Error('Expected empty target inventory has changed');
const touchedIds=new Set(plan.map(r=>r.slotId));const affected=occupancy.filter(o=>touchedIds.has(id(source.slots.find(s=>s.label===o.slot)?._id)));
if(affected.length!==touchedIds.size)throw Error('Occupancy plan does not cover all target slots');
for(const o of affected){const slot=source.slots.find(s=>s.label===o.slot);const rows=plan.filter(r=>r.slotId===id(slot._id));const added=rows.reduce((n,r)=>n+r.csvQty*r.unitCbm,0);if(Math.abs(added-o.addedCbm)>1e-9||Math.abs(o.currentCbm+added-o.proposedCbm)>1e-9||Math.abs(slot.occupiedCbm-o.currentCbm)>1e-9)throw Error('Occupancy mismatch: '+o.slot);}
const output=path.join('/Users/azad/Backups/megadie','ribbon-stock-import-'+(apply?'apply-':'dry-run-')+new Date().toISOString().replaceAll(':','-'));
await fs.mkdir(output,{recursive:true});
const batchId='ae1-ribbon-count-'+hash.slice(0,24);
const report={mode:apply?'apply':'dry-run',batchId,source:summary.source,preview:dir,csvHash:hash,quantity:summary.matchedQty,slotItems:plan.length,affectedSlots:affected.length,acceptedCapacityWarnings:issues.filter(i=>i.type==='over_capacity').length,created:0,movements:0,committed:false,success:false,issues:[]};
await fs.writeFile(path.join(output,'plan.json'),JSON.stringify({report,plan,affected},null,2));
dotenv.config({path:new URL('../.env',import.meta.url).pathname,quiet:true});
await mongoose.connect(process.env.MONGO_URI,{autoIndex:false,autoCreate:false});
try{
 const db=mongoose.connection.db;if(db.databaseName!=='production-db')throw Error('Unexpected database');
 const resetStart=new Date('2026-10-11T10:50:52.326Z');
 const read=async session=>{
  const now={};
  for(const name of ['products','categories','slots','slotitems'])now[name]=await db.collection(name).find({},{session}).toArray();
  const ribbonIds=now.products.filter(p=>p.productType==='Ribbon').map(p=>p._id);
  now.allocations=await db.collection('orderallocations').find({product:{$in:ribbonIds}},{session}).toArray();
  now.movements=await db.collection('inventorymovements').find({product:{$in:ribbonIds},$or:[{eventAt:{$gte:resetStart}},{createdAt:{$gte:resetStart}}]},{session}).toArray();
  return now;
 };
 const equal=(a,b)=>JSON.stringify(a.map(d=>JSON.stringify(d)).sort())===JSON.stringify(b.map(d=>JSON.stringify(d)).sort());
 const verifyState=now=>{for(const name of ['products','categories','slots','slotitems','allocations','movements'])if(!equal(source[name],now[name]))throw Error('Production '+name+' changed since preview; run reconciliation again');};
 const existingBatch=await db.collection('inventorymovements').countDocuments({'meta.batchId':batchId});
 if(existingBatch)throw Error('This CSV batch already appears in inventory movements; stop and reconcile');
 verifyState(await read(undefined));
 if(apply){
  const session=await mongoose.startSession();
  try{await session.withTransaction(async()=>{
   verifyState(await read(session));
   if(await db.collection('inventorymovements').countDocuments({'meta.batchId':batchId},{session}))throw Error('Batch already recorded');
   const now=new Date();
   const items=plan.map(r=>({_id:new mongoose.Types.ObjectId(),product:new mongoose.Types.ObjectId(r.productId),slot:new mongoose.Types.ObjectId(r.slotId),qty:r.csvQty,cbm:r.csvQty*r.unitCbm,createdAt:now,updatedAt:now,__v:0}));
   const moves=plan.map(r=>({_id:new mongoose.Types.ObjectId(),type:'ADJUST_IN',product:new mongoose.Types.ObjectId(r.productId),slot:new mongoose.Types.ObjectId(r.slotId),qty:r.csvQty,unitCbm:r.unitCbm,cbm:r.csvQty*r.unitCbm,note:'AE1 ribbon physical count import',meta:{batchId,csvHash:hash,sourceLines:r.sourceLines,source:'ribbon-stock-count'},eventAt:now,createdAt:now,updatedAt:now,__v:0}));
   await db.collection('slotitems').insertMany(items,{session,ordered:true});
   await db.collection('inventorymovements').insertMany(moves,{session,ordered:true});
   const slotUpdates=affected.map(o=>{const slot=source.slots.find(s=>s.label===o.slot);return {updateOne:{filter:{_id:new mongoose.Types.ObjectId(id(slot._id)),occupiedCbm:slot.occupiedCbm},update:{$set:{occupiedCbm:o.proposedCbm,fillPercent:slot.cbm>0?o.proposedCbm/slot.cbm*100:0,updatedAt:now}}}};});
   const slotResult=await db.collection('slots').bulkWrite(slotUpdates,{session,ordered:true});
   if(slotResult.matchedCount!==affected.length)throw Error('One or more slot occupancies changed');
  },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary'});}finally{await session.endSession();}
  report.committed=true;await fs.writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));
  const [items,moves]=await Promise.all([db.collection('slotitems').find({$or:plan.map(r=>({product:new mongoose.Types.ObjectId(r.productId),slot:new mongoose.Types.ObjectId(r.slotId)}))}).toArray(),db.collection('inventorymovements').find({'meta.batchId':batchId}).toArray()]);
  const got=new Map(items.map(i=>[id(i.product)+'|'+id(i.slot),i]));
  if(items.length!==plan.length||moves.length!==plan.length||moves.reduce((n,m)=>n+m.qty,0)!==summary.matchedQty||plan.some(r=>got.get(r.productId+'|'+r.slotId)?.qty!==r.csvQty))throw Error('Post-commit stock/movement verification failed');
  const currentItems=await db.collection('slotitems').find({}).toArray();
  const protectedNow=currentItems.filter(i=>{const slot=slots.get(id(i.slot));return !target(slot)||byId.get(id(i.product))?.productType!=='Ribbon';});
  const protectedBefore=source.slotitems.filter(i=>{const slot=slots.get(id(i.slot));return !target(slot)||byId.get(id(i.product))?.productType!=='Ribbon';});
  const equalProtected=(rows)=>JSON.stringify(rows.map(r=>JSON.stringify(r)).sort());
  if(equalProtected(protectedNow)!==equalProtected(protectedBefore))throw Error('Post-commit protected stock verification failed');
  const currentSlots=await db.collection('slots').find({}).toArray();
  const changedSlots=new Map(currentSlots.map(s=>[id(s._id),s]));
  for(const o of affected){const slot=source.slots.find(s=>s.label===o.slot);if(Math.abs(changedSlots.get(id(slot._id))?.occupiedCbm-o.proposedCbm)>1e-9)throw Error('Post-commit occupancy verification failed: '+o.slot);}
  if(source.slots.some(s=>!touchedIds.has(id(s._id))&&JSON.stringify(s)!==JSON.stringify(changedSlots.get(id(s._id)))))throw Error('Post-commit protected slot verification failed');
  report.created=items.length;report.movements=moves.length;report.protectedRowsVerified=protectedBefore.length;report.occupanciesVerified=affected.length;
 }
 report.success=true;console.log(JSON.stringify({output,...report},null,2));
}catch(e){report.issues.push(e.message);console.error(e.message);process.exitCode=1;}
finally{await fs.writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));await mongoose.disconnect();}
