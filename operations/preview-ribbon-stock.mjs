// Read-only reconciliation. No apply mode and no database writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
const backend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const csvPath=process.argv[2]||path.resolve(backend,'../ribbon_stock_db_sizes.csv');
if(process.argv.length>3||csvPath.startsWith('--'))throw Error('Usage: node operations/preview-ribbon-stock.mjs [csv-path]');
const raw=await fs.readFile(csvPath);
const hash=crypto.createHash('sha256').update(raw).digest('hex');
const parsed=JSON.parse(execFileSync('python3',['-c',`import csv,io,json,sys
r=csv.DictReader(io.StringIO(sys.stdin.read()))
print(json.dumps({'fields':r.fieldnames,'rows':list(r)}))`,],{input:raw,encoding:'utf8',maxBuffer:10*1024*1024}));
if(JSON.stringify(parsed.fields)!==JSON.stringify(['shelf','slot','category','size','code','qty','quality']))throw Error('Unexpected CSV headers');
const resetId='ae1-ribbon-reset-2026-10-11T10-50-52-326Z';
const resetStart=new Date('2026-10-11T10:50:52.326Z');
const output=path.join('/Users/azad/Backups/megadie','ribbon-stock-preview-'+new Date().toISOString().replaceAll(':','-'));
const issues=[],plan=[],groups=new Map();
const note=(severity,type,details)=>issues.push({severity,type,...details});
for(const [i,r] of parsed.rows.entries()){
 const line=i+2;
 if(Object.keys(r).length!==7||Object.values(r).some(v=>typeof v!=='string'||v.trim()!==v)||! /^[D-R]$/.test(r.shelf)||! /^(?:[1-9]|1[0-6])$/.test(r.slot)||!['grosgrain','satin'].includes(r.category)||!['1/2 inch','3/4 inch','1 inch'].includes(r.size)||!/^\d{3}$/.test(r.code)||!/^\d+$/.test(r.qty)||!Number.isSafeInteger(Number(r.qty))||Number(r.qty)<=0||!['A+','B+'].includes(r.quality)){
  note('blocker','invalid_csv_row',{line,row:r});continue;
 }
 const key=JSON.stringify([r.shelf,Number(r.slot),r.category,r.size,r.code,r.quality]);
 if(!groups.has(key))groups.set(key,{...r,slot:Number(r.slot),qty:0,lines:[]});
 const g=groups.get(key);g.qty+=Number(r.qty);g.lines.push(line);
 if(!Number.isSafeInteger(g.qty))throw Error('Quantity overflow');
}
dotenv.config({path:path.join(backend,'.env'),quiet:true});
await mongoose.connect(process.env.MONGO_URI,{autoIndex:false,autoCreate:false});
let data;
try{
 const db=mongoose.connection.db;if(db.databaseName!=='production-db')throw Error('Unexpected database');
 // Snapshot session gives consistent reads without creating a transaction or writing.
 const session=await mongoose.startSession({snapshot:true});
 try{
  data={};
  for(const name of ['products','categories','slots','slotitems'])data[name]=await db.collection(name).find({},{session}).toArray();
  const ribbonIds=data.products.filter(p=>p.productType==='Ribbon').map(p=>p._id);
  data.allocations=await db.collection('orderallocations').find({product:{$in:ribbonIds}},{session}).toArray();
  data.movements=await db.collection('inventorymovements').find({product:{$in:ribbonIds},$or:[{eventAt:{$gte:resetStart}},{createdAt:{$gte:resetStart}}]},{session}).toArray();
 }finally{await session.endSession();}
}finally{await mongoose.disconnect();}
const id=v=>String(v);
const products=new Map(data.products.map(p=>[id(p._id),p]));
const slots=new Map(data.slots.map(s=>[id(s._id),s]));
const target=s=>s?.store==='AE1'&&/^[D-R]$/.test(s.unit);
const targetSlots=data.slots.filter(target);
const ae1=s=>s?.store==='AE1';
const allocations=data.allocations.filter(a=>ae1(slots.get(id(a.slot)))&&a.qty>0&&(a.status==='Reserved'||a.status==null));
const targetAllocations=allocations.filter(a=>target(slots.get(id(a.slot))));
if(targetAllocations.length)note('blocker','target_reservations',{count:targetAllocations.length,qty:targetAllocations.reduce((n,a)=>n+a.qty,0)});
const resetMovements=data.movements.filter(m=>m.meta?.operationId===resetId);
if(resetMovements.length!==486)note('blocker','reset_history_mismatch',{expected:486,actual:resetMovements.length});
const touches=(m,predicate)=>[m.slot,m.fromSlot,m.toSlot].some(s=>s&&predicate(slots.get(id(s))));
const movements=data.movements.filter(m=>m.meta?.operationId!==resetId&&touches(m,ae1));
const targetMovements=movements.filter(m=>touches(m,target));
if(targetMovements.length)note('blocker','post_reset_target_activity',{count:targetMovements.length});
const targetStock=data.slotitems.filter(s=>target(slots.get(id(s.slot)))&&products.get(id(s.product))?.productType==='Ribbon'&&s.qty>0);
if(targetStock.length)note('blocker','ribbon_stock_already_present',{rows:targetStock.length,qty:targetStock.reduce((n,s)=>n+s.qty,0)});
for(const g of groups.values()){
 const cats=data.categories.filter(c=>c.productType==='Ribbon'&&c.key===g.category);
 const candidates=data.products.filter(p=>p.productType==='Ribbon'&&cats.some(c=>id(c._id)===id(p.category))&&p.catalogCode===g.code&&p.size===g.size&&p.grade===g.quality&&p.packingUnit==='100yd Roll'&&!p.variant&&(g.category==='satin'?p.finish==='Single Face':!p.finish));
 const locations=targetSlots.filter(s=>s.unit===g.shelf&&s.position===g.slot);
 if(cats.length!==1||candidates.length!==1||locations.length!==1){note('blocker','ambiguous_or_missing_match',{row:g,categoryMatches:cats.length,productMatches:candidates.length,slotMatches:locations.length});continue;}
 const p=candidates[0],s=locations[0];
 if(p.isActive===false||p.isAvailable===false||s.isActive===false||cats[0].isActive===false)note('blocker','inactive_match',{lines:g.lines,product:p.name,slot:s.label});
 const expected={'1/2 inch':0.0001,'3/4 inch':0.000175,'1 inch':0.0002}[g.size];
 if(p.cbm!==expected)note('blocker','unexpected_unit_cbm',{product:p.name,actual:p.cbm,expected});
 const existing=data.slotitems.filter(i=>id(i.product)===id(p._id)&&id(i.slot)===id(s._id));
 if(existing.length>1)note('blocker','duplicate_slot_items',{product:id(p._id),slot:s.label});
 const current=existing.reduce((n,i)=>n+i.qty,0);
 plan.push({shelf:g.shelf,slot:s.label,slotId:id(s._id),productId:id(p._id),sku:p.sku,name:p.name,sourceLines:g.lines,csvQty:g.qty,currentQty:current,proposedAddition:g.qty,hypotheticalResult:current+g.qty,action:existing.length?'increase':'create',unitCbm:p.cbm,addedCbm:g.qty*p.cbm});
}
const occupancy=[];
for(const s of targetSlots){
 const items=data.slotitems.filter(i=>id(i.slot)===id(s._id));let currentCbm=0;
 for(const item of items){const p=products.get(id(item.product));if(!p||!Number.isFinite(p.cbm)||p.cbm<0||!Number.isSafeInteger(item.qty)||item.qty<0){note('blocker','invalid_existing_slot_item',{slot:s.label,itemId:id(item._id)});continue;}currentCbm+=item.qty*p.cbm;if(Math.abs(item.cbm-item.qty*p.cbm)>1e-9)note('review','stored_item_cbm_differs',{slot:s.label,itemId:id(item._id)});}
 const additions=plan.filter(r=>r.slotId===id(s._id));const addedCbm=additions.reduce((n,r)=>n+r.addedCbm,0);const after=currentCbm+addedCbm;
 if(Math.abs((s.occupiedCbm||0)-currentCbm)>1e-9)note('review','stored_slot_occupancy_differs',{slot:s.label,stored:s.occupiedCbm,calculated:currentCbm});
 if(additions.length&&(!Number.isFinite(s.cbm)||s.cbm<=0))note('blocker','invalid_slot_capacity',{slot:s.label,capacity:s.cbm});
 const fillPercent=s.cbm>0?after/s.cbm*100:null;
 if(additions.length&&fillPercent>100+1e-7)note('review','over_capacity',{slot:s.label,capacity:s.cbm,proposedCbm:after,fillPercent});
 occupancy.push({slot:s.label,shelf:s.unit,currentCbm,addedCbm,proposedCbm:after,capacity:s.cbm,fillPercent,currentRibbonQty:items.filter(i=>products.get(id(i.product))?.productType==='Ribbon').reduce((n,i)=>n+i.qty,0),addedRibbonQty:additions.reduce((n,r)=>n+r.csvQty,0),otherProductQty:items.filter(i=>products.get(id(i.product))?.productType!=='Ribbon').reduce((n,i)=>n+i.qty,0)});
}
const shelves=[...'DEFGHIJKLMNOPQR'].map(shelf=>{const rows=occupancy.filter(o=>o.shelf===shelf);const qty=rows.reduce((n,o)=>n+o.currentRibbonQty+o.addedRibbonQty,0);return {shelf,addedQty:rows.reduce((n,o)=>n+o.addedRibbonQty,0),proposedRibbonQty:qty,emptyOfRibbons:qty===0,completelyEmpty:qty===0&&rows.every(o=>o.otherProductQty===0),slotsWithoutRibbons:rows.filter(o=>o.currentRibbonQty+o.addedRibbonQty===0).map(o=>o.slot)};});
const protectedItems=data.slotitems.filter(i=>!target(slots.get(id(i.slot)))||products.get(id(i.product))?.productType!=='Ribbon');
const summary={at:new Date().toISOString(),readOnly:true,source:path.resolve(csvPath),sha256:hash,resetId,sourceRows:parsed.rows.length,totalCsvQty:parsed.rows.reduce((n,r)=>n+Number(r.qty||0),0),groupedRows:groups.size,matchedEntries:plan.length,matchedQty:plan.reduce((n,r)=>n+r.csvQty,0),newSlotItems:plan.filter(p=>p.action==='create').length,existingSlotItemsToIncrease:plan.filter(p=>p.action==='increase').length,duplicateGroups:[...groups.values()].filter(g=>g.lines.length>1),currentTargetRibbonRows:targetStock.length,currentTargetRibbonQty:targetStock.reduce((n,i)=>n+i.qty,0),targetReservedQty:targetAllocations.reduce((n,a)=>n+a.qty,0),ae1ReservedQty:allocations.reduce((n,a)=>n+a.qty,0),postResetTargetMovements:targetMovements.length,postResetAe1Movements:movements.length,overCapacitySlots:issues.filter(i=>i.type==='over_capacity').length,blockers:issues.filter(i=>i.severity==='blocker').length,reviews:issues.filter(i=>i.severity==='review').length,shelves,protectedBaseline:{rows:protectedItems.length,sha256:crypto.createHash('sha256').update(JSON.stringify(protectedItems)).digest('hex')},note:'Addition is hypothetical until stock/activity and capacity reviews are resolved. No missing CSV row means zeroing stock. Physical movement not recorded in the database cannot be detected.'};
await fs.mkdir(output,{recursive:true});
for(const [name,value] of Object.entries({summary,issues,plan,occupancy,movements,allocations,'source-snapshot':data}))await fs.writeFile(path.join(output,name+'.json'),JSON.stringify(value,null,2)+'\n');
const columns=['shelf','slot','sku','name','sourceLines','currentQty','csvQty','proposedAddition','hypotheticalResult','action'];
const quote=v=>'"'+String(Array.isArray(v)?v.join(';'):v??'').replaceAll('"','""')+'"';
await fs.writeFile(path.join(output,'stock-preview.csv'),[columns,...plan.map(r=>columns.map(c=>r[c]))].map(r=>r.map(quote).join(',')).join('\n')+'\n');
console.log(JSON.stringify({output,...summary},null,2));
