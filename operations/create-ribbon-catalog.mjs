// Preview by default. Apply requires --apply and --expect-count=N.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import {parseArgs, checkImage, parallel, requireSkuIndex, verifyImage} from './ribbon-catalog-safety.mjs';
const {manifest,apply,expected}=parseArgs(process.argv.slice(2));
dotenv.config({path:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.env'),quiet:true});
mongoose.set('autoIndex',false);mongoose.set('autoCreate',false);
const {default:Product}=await import('../models/productModel.js');
await import('../models/categoryModel.js');
const bytes=await fs.readFile(manifest);const rows=JSON.parse(bytes);
if(!Array.isArray(rows)||!rows.length)throw Error('Empty or invalid manifest');
const output=path.join('/Users/azad/Backups/megadie','ribbon-catalog-'+(apply?'apply-':'preview-')+new Date().toISOString().replaceAll(':','-'));
await fs.mkdir(output,{recursive:true});
const report={mode:apply?'apply':'preview',manifest:path.resolve(manifest),hash:crypto.createHash('sha256').update(bytes).digest('hex'),created:[],skipped:[],issues:[],proposed:[],visibility:'Active and available products appear in product results; catalog publication is separate.'};
await mongoose.connect(process.env.MONGO_URI,{autoIndex:false,autoCreate:false});
try {
 const db=mongoose.connection.db;if(db.databaseName!=='production-db')throw Error('Unexpected database');
 const [products,categories,rules]=await Promise.all([db.collection('products').find({}).toArray(),db.collection('categories').find({productType:'Ribbon'}).toArray(),db.collection('pricerules').find({productType:'Ribbon'}).toArray()]);
 requireSkuIndex(await db.collection('products').listIndexes().toArray());
 const pending=[],seen=new Set();
 const same=(p,d)=>['productType','catalogCode','size','grade','packingUnit','color','priceRule','cbm','finish','variant'].every(k=>(p[k]??'')===(d[k]??''))&&String(p.category)===String(d.category)&&JSON.stringify(p.images)===JSON.stringify(d.images);
 for(const r of rows){
  const cats=categories.filter(c=>c.key===r.material && c.isActive!==false);
  if(cats.length!==1)throw Error('Category missing or ambiguous');
  const cat=cats[0];
  const sizeMap={'1/2 inch':['1/2INCH',0.0001],'3/4 inch':['3/4INCH',0.000175],'1 inch':['1INCH',0.0002]};
  if(!cat||!['grosgrain','satin'].includes(r.material)||!sizeMap[r.size]||r.grade!=='A+'||r.packingUnit!=='100yd Roll'||!/^\d{3}$/.test(r.code)||r.code!==r.catalogCode)throw Error('Manifest outside approved scope');
  const [sizeToken,cbm]=sizeMap[r.size];const satin=r.material==='satin';
  const priceRule=`RIB|${satin?'SAT':'GRO'}|${sizeToken}|${satin?'SF|':''}A+|100YD-ROLL`;
  const matchingRules=rules.filter(x=>x.code===priceRule);
  if(matchingRules.length!==1)throw Error('Price rule missing or ambiguous');
  const rule=matchingRules[0];
  if(!rule||rule.defaultPrice!==r.price||!Number.isFinite(r.price)||r.price<0)throw Error('Price changed or missing: '+priceRule);
  if(r.cbm!==cbm||r.priceRule!==priceRule)throw Error('Manifest CBM/rule mismatch');
  checkImage(r);
  const image=r.images[0];
  const data={productType:'Ribbon',category:cat._id,catalogCode:r.code,color:r.color,size:r.size,grade:'A+',packingUnit:'100yd Roll',priceRule,cbm,moq:1,images:[image],sort:Number(r.code),tags:[],isActive:true,isAvailable:true,isFeatured:false,featuredRank:0,...(satin?{finish:'Single Face'}:{})};
  const identity=JSON.stringify([String(cat._id),r.code,r.size,'A+','100yd Roll']);if(seen.has(identity))throw Error('Duplicate manifest variation');seen.add(identity);
  const hits=products.filter(p=>String(p.category)===String(cat._id)&&p.catalogCode===r.code&&p.size===r.size&&p.grade==='A+'&&p.packingUnit==='100yd Roll');
  if(hits.length){if(hits.length!==1||!same(hits[0],data))throw Error('Conflicting existing variation: '+identity);report.skipped.push({id:String(hits[0]._id),sku:hits[0].sku});continue;}
  pending.push({data,row:r});
 }
 await parallel(pending,async item=>{const doc=new Product(item.data);await doc.validate();if(doc.sku!==item.row.sku||doc.name!==item.row.name)throw Error('Manifest name/SKU differs from model');if(products.some(p=>p.sku===doc.sku))throw Error('SKU collision');item.doc=doc.toObject();});
 const skus=pending.map(p=>p.doc.sku);if(new Set(skus).size!==skus.length)throw Error('Duplicate proposed SKU');
 const urls=[...new Set(pending.map(p=>p.data.images[0]))];
 await parallel(urls,verifyImage);
 report.proposed=pending.map(p=>({id:String(p.doc._id),name:p.doc.name,sku:p.doc.sku,priceRule:p.doc.priceRule,cbm:p.doc.cbm}));
 report.count=pending.length;report.verifiedImages=urls.length;
 await fs.writeFile(path.join(output,'before.json'),JSON.stringify({products,categories,rules},null,2));
 await fs.writeFile(path.join(output,'plan.json'),JSON.stringify(report,null,2));
 if(apply){
  if(pending.length!==expected)throw Error('Creation count changed; review a new preview');
  const session=await mongoose.startSession();
  try{await session.withTransaction(async()=>{
   const current=await db.collection('products').find({},{session}).toArray();
   const currentCategories=await db.collection('categories').find({productType:'Ribbon'},{session}).toArray();
   const currentRules=await db.collection('pricerules').find({productType:'Ribbon'},{session}).toArray();
   const fingerprint=x=>JSON.stringify(x.map(d=>JSON.stringify(d)).sort());
   if(fingerprint(current)!==fingerprint(products)||fingerprint(currentCategories)!==fingerprint(categories)||fingerprint(currentRules)!==fingerprint(rules))throw Error('Catalog changed during preflight; rerun preview');
   if(pending.length){const now=new Date();await db.collection('products').insertMany(pending.map(p=>({...p.doc,createdAt:now,updatedAt:now,__v:0})),{session,ordered:true});}
  },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary'});}finally{await session.endSession();}
  report.committed=true;
  // Persist commit outcome before verification so a later failure is distinguishable.
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));
  const savedRows=pending.length?await db.collection('products').find({_id:{$in:pending.map(p=>p.doc._id)}}).toArray():[];
  if(savedRows.length!==pending.length)throw Error('Post-commit count mismatch');
  for(const p of pending){const saved=savedRows.find(d=>String(d._id)===String(p.doc._id));if(!saved||!same(saved,p.data)||saved.sku!==p.doc.sku||saved.name!==p.doc.name||saved.isActive!==true||saved.isAvailable!==true||saved.moq!==1)throw Error('Post-commit verification failed');report.created.push({id:String(saved._id),sku:saved.sku});}

 }
 report.success=true;
 console.log(JSON.stringify({mode:report.mode,toCreate:report.count,skipped:report.skipped.length,created:report.created.length,verifiedImages:report.verifiedImages,output},null,2));
}catch(e){report.success=false;report.issues.push(e.message);console.error(e.message);process.exitCode=1;}
finally{await fs.writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));await mongoose.disconnect();}
