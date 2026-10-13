// Read-only database audit. No server startup, saves, updates, or index creation.
// Run from backend: node operations/audit-ribbon-catalog.mjs [photos-root] [output-dir]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(backend, '.env'), quiet: true });
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
const { default: Product } = await import('../models/productModel.js');
await import('../models/categoryModel.js');
const { ribbonCatalogCodes } = await import('../constants.js');
const { buildSku, buildName } = await import('../utils/productNaming.js');
const photos = process.argv[2] || '/Users/azad/Documents/Business/Megadie Website Photos';
const output = process.argv[3] || path.join('/Users/azad/Backups/megadie', 'ribbon-catalog-audit-' + new Date().toISOString().replaceAll(':', '-'));
const issues = [], proposed = [], existing = [], images = [];
const issue = (severity, kind, details) => issues.push({ severity, kind, ...details });
const sizes = [['1/2 inch', '1/2INCH', 0.0001], ['3/4 inch', '3/4INCH', 0.000175], ['1 inch', '1INCH', 0.0002]];
const connection = await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, monitorCommands: true });
// Monitor for unexpected commands. This is detection, not database authorization;
// use a MongoDB read-only account when available for server-enforced protection.
const client = connection.connection.getClient();
const allowed = new Set(['find', 'getMore', 'killCursors', 'listIndexes', 'endSessions', 'ping']);
client.on('commandStarted', event => {
  if (!allowed.has(event.commandName)) throw new Error('Unexpected database command: ' + event.commandName);
});
try {
 const db = mongoose.connection.db;
 const [products, categories, rules, filters, indexes] = await Promise.all([
  db.collection('products').find({}).toArray(), db.collection('categories').find({productType:'Ribbon'}).toArray(),
  db.collection('pricerules').find({productType:'Ribbon'}).toArray(), db.collection('filterconfigs').find({productType:'Ribbon'}).toArray(),
  db.collection('products').listIndexes().toArray(),
 ]);
 if(!indexes.some(i=>i.unique && i.key.sku===1 && Object.keys(i.key).length===1)) issue('blocker','missing_unique_sku_index',{});
 for(const [key, material, token] of [['grosgrain','Grosgrain','GRO'], ['satin','Satin','SAT']]) {
  const cats=categories.filter(c=>c.key===key);
  if(cats.length!==1 || cats[0].isActive===false){issue('blocker','category', {key,count:cats.length});continue;}
  const category=cats[0]; const seen=new Set();
  for(const filename of (await fs.readdir(path.join(photos, 'Plain '+material+' Ribbons'))).sort()){
   if(filename.startsWith('.'))continue;
   const match=filename.match(new RegExp('^(\\d{3})(.+)'+material+'\\.(jpg|jpeg|png|webp)(\\.webp)?$','i'));
   if(!match){issue('blocker','unparsed_filename',{key,filename});continue;}
   const [,code,rawColor]=match;
   const color=key==='satin' && code==='435' && rawColor==='Thristle'?'Thistle':rawColor;
   if(color!==rawColor)issue('info','resolved_color_spelling',{key,code,filename,rawColor,proposedColor:color});
   if(seen.has(code)){issue('blocker','duplicate_image_code',{key,code,filename});continue;}seen.add(code);
   const url='https://megadie.s3.eu-central-1.amazonaws.com/Plain+'+material+'+Ribbons/'+encodeURIComponent(filename);
   images.push({key,code,filename,url});
   for(const [size,sizeToken,cbm] of sizes){
    const ruleCode=`RIB|${token}|${sizeToken}|${key==='satin'?'SF|':''}A+|100YD-ROLL`;
    const matchingRules=rules.filter(r=>r.code===ruleCode);
    const data={productType:'Ribbon',category:category._id,size,catalogCode:code,color,grade:'A+',packingUnit:'100yd Roll',priceRule:ruleCode,cbm,moq:1,images:[url],sort:Number(code),isActive:true,isAvailable:true,isFeatured:false,featuredRank:0,tags:[],...(key==='satin'?{finish:'Single Face'}:{})};
    const sku=buildSku({...data,categoryKey:key}); const name=buildName({...data,categoryLabel:category.label||key});
    const row={material:key,code,color,size,name,sku,price:matchingRules[0]?.defaultPrice,...data,category:String(category._id)};
    const hits=products.filter(p=>p.productType==='Ribbon'&&String(p.category)===String(category._id)&&p.catalogCode===code&&p.size===size&&p.grade==='A+'&&p.packingUnit==='100yd Roll');
    if(hits.length){
     existing.push({material:key,code,size,ids:hits.map(p=>String(p._id))});
     if(hits.length>1)issue('blocker','duplicate_variation',{key,code,size,ids:hits.map(p=>String(p._id))});
     for(const p of hits){
      const differences={};for(const field of ['color','variant','finish','cbm','priceRule','sku','moq'])if((p[field]||'')!==(row[field]||''))differences[field]={actual:p[field]??null,expected:row[field]??null};
      if(!(p.images||[]).includes(url))differences.images={actual:p.images,expected:[url]};
      if(p.isActive===false||p.isAvailable===false)differences.visibility={isActive:p.isActive,isAvailable:p.isAvailable};
      if(Object.keys(differences).length)issue('review','existing_product_difference',{key,code,size,id:String(p._id),differences});
     }
     continue;
    }
    row.blockers=[];
    if(matchingRules.length!==1 || !Number.isFinite(row.price)||row.price<0)row.blockers.push('invalid_price_rule');
    if(!ribbonCatalogCodes.includes(code))row.blockers.push('catalog_code_requires_backend_update');
    if(products.some(p=>p.sku===sku)||proposed.some(p=>p.sku===sku))row.blockers.push('sku_collision');
    const doc=new Product(data);
    try{await doc.validate();if(doc.sku!==sku||doc.name!==name)row.blockers.push('name_or_sku_generation_mismatch');}
    catch(e){for(const [field,error] of Object.entries(e.errors||{}))if(field!=='catalogCode')row.blockers.push('validation:'+field+':'+error.message);if(!e.errors)row.blockers.push('validation:'+e.message);}
    proposed.push(row);
   }
  }
 }
 let next=0;
 await Promise.all(Array.from({length:8},async()=>{while(next<images.length){const im=images[next++];try{const r=await fetch(im.url,{method:'HEAD',signal:AbortSignal.timeout(15000)});im.httpStatus=r.status;im.contentType=r.headers.get('content-type');im.ok=r.ok&&im.contentType?.startsWith('image/');}catch(e){im.ok=false;im.error=e.name+': '+e.message;}if(!im.ok)issue('blocker','image_unverified',im);}}));
 for(const row of proposed){if(!images.find(im=>im.key===row.material&&im.code===row.code)?.ok)row.blockers.push('image_unverified');row.status=row.blockers.length?'blocked':'ready';}
 for(const cfg of filters)for(const field of cfg.fields||[]){if(field.allowedValues?.length && ['color','catalogCode','size'].includes(field.key)){const values=[...new Set(proposed.map(p=>p[field.key==='catalogCode'?'code':field.key]))];const absent=values.filter(v=>!field.allowedValues.includes(v));if(absent.length)issue('review','filter_options_missing',{field:field.key,values:absent});}}
 const summary={at:new Date().toISOString(),database:db.databaseName,readOnly:true,photos,images:images.length,verifiedImages:images.filter(i=>i.ok).length,existingVariations:existing.length,missing:proposed.length,ready:proposed.filter(p=>p.status==='ready').length,blocked:proposed.filter(p=>p.status==='blocked').length,missingApprovedCodes:[...new Set(proposed.filter(p=>p.blockers.includes('catalog_code_requires_backend_update')).map(p=>p.code))].sort(),counts:{},rules:rules.filter(r=>r.code.includes('|A+|100YD-ROLL')).map(r=>({code:r.code,price:r.defaultPrice})),visibility:'Proposed active/available products appear in the public catalog; zero stock may display Maybe Available.',pricing:'Customer overrides are keyed by user and priceRule; proposed products reuse existing rules.',sourceFingerprint:crypto.createHash('sha256').update(JSON.stringify({products,categories,rules,filters})).digest('hex')};
 for(const key of ['grosgrain','satin'])for(const [size] of sizes)summary.counts[key+' '+size]={existing:existing.filter(p=>p.material===key&&p.size===size).length,missing:proposed.filter(p=>p.material===key&&p.size===size).length};
 await fs.mkdir(output,{recursive:true});
 for(const [name,data] of Object.entries({summary,issues,images,proposed}))await fs.writeFile(path.join(output,name+'.json'),JSON.stringify(data,null,2)+'\n');
 const columns=['status','material','code','color','size','grade','packingUnit','finish','cbm','priceRule','price','moq','isActive','isAvailable','name','sku','images','blockers'];
 const cell=v=>'"'+String(Array.isArray(v)?v.join('; '):v??'').replaceAll('"','""')+'"';
 await fs.writeFile(path.join(output,'proposed-products.csv'),[columns,...proposed.map(p=>columns.map(k=>p[k]))].map(r=>r.map(cell).join(',')).join('\n')+'\n');
 await fs.writeFile(path.join(output,'summary.txt'),JSON.stringify(summary,null,2)+'\n\nIssues: '+issues.length+'\nNo database writes performed. Re-audit before creation.\n');
 console.log(JSON.stringify({output,...summary,issues:issues.length},null,2));
}finally{await mongoose.disconnect();}
