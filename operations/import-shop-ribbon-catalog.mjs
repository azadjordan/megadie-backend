// Imports browsing metadata only. Does not create or modify products or stock.
// Preview: node operations/import-shop-ribbon-catalog.mjs /path/to/entries.json
// Apply: append --apply --expect-sha=<SHA256 reported by preview>
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

const [input, ...flags] = process.argv.slice(2);
if (!input || flags.some(f => f !== '--apply' && !f.startsWith('--expect-sha='))) {
  throw Error('Provide entries.json; optional --apply --expect-sha=<preview hash>');
}
const apply = flags.includes('--apply');
const bytes = await fs.readFile(input);
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
if (apply && !flags.includes('--expect-sha=' + sha)) throw Error('Apply requires matching preview SHA256');
const rows = JSON.parse(bytes);
if (!Array.isArray(rows) || rows.length !== 392) throw Error('Expected 392 reviewed entries');
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({path:path.join(backend,'.env'),quiet:true});
mongoose.set('autoCreate', false);
mongoose.set('autoIndex', false);
const {default:Catalog} = await import('../models/catalogModel.js');
const {default:CatalogEntry} = await import('../models/catalogEntryModel.js');
const output = path.join('/Users/azad/Backups/megadie', 'shop-catalog-' + (apply?'apply-':'preview-') + new Date().toISOString().replaceAll(':','-'));
await fs.mkdir(output,{recursive:true});
const report = {mode:apply?'apply':'preview',input:path.resolve(input),sha,output,committed:false};
const normalize = value => String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const metadata = entry => JSON.stringify([String(entry.category),entry.code,entry.label,entry.imageUrl,entry.page,entry.position,entry.isActive]);
await mongoose.connect(process.env.MONGO_URI,{autoCreate:false,autoIndex:false,serverSelectionTimeoutMS:20000});
try {
  const db = mongoose.connection.db;
  if(db.databaseName!=='production-db') throw Error('Unexpected database');
  const inspect = async (session) => {
    const opts = session?{session}:{};
    const categories = await db.collection('categories').find({productType:'Ribbon',key:{$in:['grosgrain','satin']}},opts).toArray();
    const catalogRows = await db.collection('catalogs').find({productType:'Ribbon'},opts).toArray();
    if(catalogRows.length>1) throw Error('Multiple Ribbon catalogs exist');
    const existing = catalogRows[0];
    if(existing && (existing.name!=='Ribbon colors'||existing.layout!=='color-grid'||existing.isActive!==false)) throw Error('Existing catalog differs; will not overwrite');
    const catalog = new Catalog({_id:existing?._id||new mongoose.Types.ObjectId(),name:'Ribbon colors',productType:'Ribbon',layout:'color-grid',isActive:false});
    await catalog.validate();
    const entries=[],pages=[];
    for(const material of ['grosgrain','satin']) {
      const cats = categories.filter(c=>c.key===material && c.isActive!==false);
      if(cats.length!==1) throw Error('Missing/ambiguous active category: '+material);
      const cat=cats[0];
      const selected=rows.filter(r=>r.material===material).sort((a,b)=>a.code.localeCompare(b.code,'en',{numeric:true}));
      if(selected.length!==196 || new Set(selected.map(r=>r.code)).size!==196) throw Error('Expected 196 distinct codes: '+material);
      const products=await db.collection('products').find({productType:'Ribbon',category:cat._id,size:'1 inch',grade:'A+',packingUnit:'100yd Roll'},{...opts,projection:{catalogCode:1,color:1,images:1,isActive:1}}).toArray();
      for(const [index,r] of selected.entries()) {
        if(typeof r.code!=='string'||!/^\d{3}$/.test(r.code)||String(cat._id)!==r.category||r.isActive!==false) throw Error('Entry outside reviewed scope');
        const matching=products.filter(p=>p.catalogCode===r.code);
        if(matching.length!==1) throw Error('Product missing/ambiguous: '+material+' '+r.code);
        const p=matching[0];
        if(String(p._id)!==r.sourceProductId || p.isActive===false || normalize(p.color)!==normalize(r.label) || p.images?.[0]!==r.imageUrl) throw Error('Source product metadata changed: '+material+' '+r.code);
        const doc=new CatalogEntry({catalog:catalog._id,category:cat._id,code:r.code,label:r.label,imageUrl:r.imageUrl,page:Math.floor(index/49)+1,position:index%49+1,isActive:false});
        await doc.validate();entries.push(doc.toObject());
      }
      for(let page=1;page<=4;page++) {
        const group=entries.filter(e=>String(e.category)===String(cat._id)&&e.page===page);
        pages.push({material,page,count:group.length,firstCode:group[0].code,lastCode:group.at(-1).code});
      }
    }
    const stored=existing?await db.collection('catalogentries').find({catalog:existing._id},opts).toArray():[];
    if(existing && (stored.length!==392 || [...stored].map(metadata).sort().join('\n')!==entries.map(metadata).sort().join('\n'))) throw Error('Existing entries differ or are incomplete; will not overwrite');
    return {catalog:catalog.toObject(),entries,pages,exists:Boolean(existing),before:{catalogs:catalogRows,entries:stored}};
  };
  const plan=await inspect();
  Object.assign(report,{catalogsToCreate:plan.exists?0:1,entriesToCreate:plan.exists?0:392,pages:plan.pages});
  await fs.writeFile(path.join(output,'before.json'),JSON.stringify(plan.before,null,2));
  await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify({catalog:plan.catalog,entries:plan.entries},null,2));
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  if(apply && !plan.exists) {
    // Create declared uniqueness indexes before the transaction; never modify
    // product, slot item, allocation, or pricing collections.
    for(const Model of [Catalog,CatalogEntry]) {
      for(const [keys,options] of Model.schema.indexes()) await Model.collection.createIndex(keys,options);
    }
    const session=await mongoose.startSession();
    try {
      await session.withTransaction(async()=>{
        const current=await inspect(session);
        if(current.exists) throw Error('Catalog appeared after preview; rerun to reconcile');
        const now=new Date();
        await db.collection('catalogs').insertOne({...plan.catalog,createdAt:now,updatedAt:now},{session});
        await db.collection('catalogentries').insertMany(plan.entries.map(e=>({...e,createdAt:now,updatedAt:now})),{session,ordered:true});
      },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'}});
      report.committed=true;
      await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
    } finally { await session.endSession(); }
    const verified=await inspect();
    if(!verified.exists) throw Error('Post-import verification failed');
    report.verifiedEntries=verified.entries.length;
  }
  report.success=true;
  console.log(JSON.stringify(report,null,2));
} catch(error) {
  report.error=error.message;
  process.exitCode=1;
  console.error(error.message);
} finally {
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  await mongoose.disconnect();
}
