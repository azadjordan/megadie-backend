import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import Catalog from '../models/catalogModel.js';
import CatalogEntry from '../models/catalogEntryModel.js';
import Category from '../models/categoryModel.js';
import User from '../models/userModel.js';
import routes from '../routes/catalogRoutes.js';

const cid='100000000000000000000001';
const other='100000000000000000000002';
const gids=['200000000000000000000001','200000000000000000000002'];
const match=(row,filter)=>Object.entries(filter).every(([key,value])=>{
  if(key==='$or') return value.some(f=>match(row,f));
  if(value?.$in) return value.$in.some(v=>String(v)===String(row[key]));
  if(value?.$regex!==undefined) return new RegExp(value.$regex,value.$options).test(row[key]);
  return String(row[key])===String(value);
});
const query=initial=>{
  let rows=initial,fields;
  return {select(value){fields=value.split(' ');return this;},sort(spec){rows=[...rows].sort((a,b)=>{for(const [key,direction]of Object.entries(spec)){if(a[key]<b[key])return -direction;if(a[key]>b[key])return direction;}return 0;});return this;},skip(n){rows=rows.slice(n);return this;},limit(n){rows=rows.slice(0,n);return this;},async lean(){const pick=r=>r&&fields?Object.fromEntries(fields.filter(k=>k in r).map(k=>[k,r[k]])):r;return Array.isArray(rows)?rows.map(pick):pick(rows);}};
};

test('catalog access, saved pages, literal search and selected product filters',async t=>{
 const previous=process.env.JWT_SECRET;process.env.JWT_SECRET='catalog-unit-test-only';
 const catalog={_id:cid,name:'Ribbon colors',productType:'Ribbon',layout:'color-grid',isActive:false};
 const categories=['grosgrain','satin'].map((key,i)=>({_id:gids[i],key,label:key,productType:'Ribbon',isActive:true}));
 const entries=categories.flatMap((cat,m)=>Array.from({length:196},(_,i)=>({_id:(300000000000000000000000n+BigInt(m*196+i)).toString(),catalog:cid,category:cat._id,code:String(i).padStart(3,'0'),label:i===195?'Last Color':'Color '+i,imageUrl:'https://example.com/image.jpg',page:Math.floor(i/49)+1,position:i%49+1,isActive:false})));
 t.mock.method(User,'findById',role=>({select:async()=>({_id:role,isAdmin:role==='admin',approvalStatus:role==='pending'?'Pending':'Approved'})}));
 t.mock.method(Catalog,'findOne',filter=>query([catalog].find(r=>match(r,filter))||null));
 t.mock.method(Category,'find',filter=>query(categories.filter(r=>match(r,filter))));
 t.mock.method(Category,'findOne',filter=>query(categories.find(r=>match(r,filter))||null));
 t.mock.method(CatalogEntry,'find',filter=>query(entries.filter(r=>match(r,filter))));
 t.mock.method(CatalogEntry,'findOne',filter=>query(entries.find(r=>match(r,filter))||null));
 t.mock.method(CatalogEntry,'countDocuments',async filter=>entries.filter(r=>match(r,filter)).length);
 t.mock.method(CatalogEntry,'distinct',async(field,filter)=>[...new Set(entries.filter(r=>match(r,filter)).map(r=>r[field]))]);
 const app=express();app.use(cookieParser(),routes);
 app.use((err,req,res,next)=>res.status(res.statusCode>=400?res.statusCode:500).json({message:err.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{await new Promise(r=>server.close(r));if(previous===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=previous;});
 const base=`http://127.0.0.1:${server.address().port}`;
 const request=(url,role='customer')=>fetch(base+url,{headers:role?{Cookie:`jwt=${jwt.sign({userId:role},process.env.JWT_SECRET)}`}:{}});
 assert.equal((await request('/?productType=Ribbon',null)).status,401);
 assert.equal((await request('/?productType=Ribbon','pending')).status,403);
 for(const role of ['customer','admin']) {
  for(const endpoint of ['/?productType=Ribbon',`/${cid}/entries?material=grosgrain`,`/${cid}/entries/${entries[0]._id}`])assert.equal((await request('/preview'+endpoint,role)).status,404);
  for(const suffix of ['', '&preview=true','&isActive=false'])assert.equal((await(await request('/?productType=Ribbon'+suffix,role)).json()).data,null);
  assert.equal((await request(`/${cid}/entries?material=grosgrain`,role)).status,404);
  assert.equal((await request(`/${cid}/entries/${entries[0]._id}`,role)).status,404);
 }
 // Activate fixtures only; no database is connected.
 catalog.isActive=true;entries.forEach(entry=>entry.isActive=true);
 const meta=await(await request('/?productType=Ribbon','admin')).json();assert.equal(meta.data.materials.length,2);
 assert.equal((await request('/?productType=Unknown')).status,400);
 assert.equal((await(await request('/?productType=Creasing%20Matrix')).json()).data,null);
 for(const material of ['grosgrain','satin'])for(let page=1;page<=4;page++){
  const response=await request(`/${cid}/entries?material=${material}&page=${page}`);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  const body=await response.json();assert.equal(body.data.length,49);assert.deepEqual(body.pagination.pages,[1,2,3,4]);
  assert.equal(body.data[0].code,String((page-1)*49).padStart(3,'0'));
  assert.ok(body.data.every(e=>e.category===gids[material==='satin'?1:0]&&e.page===page));
  assert.ok(body.data.every(e=>e.filters.productType==='Ribbon'&&e.filters.categoryKeys===material&&e.filters.catalogCode===e.code));
  assert.deepEqual(Object.keys(body.data[0].filters).sort(),['catalogCode','categoryKeys','productType']);
 }
 let body=await(await request(`/${cid}/entries?material=grosgrain&q=last%20color`)).json();assert.equal(body.data[0].code,'195');assert.equal(body.mode,'search');
 body=await(await request(`/${cid}/entries?material=grosgrain&q=007`)).json();assert.equal(body.data.length,1);assert.equal(body.data[0].code,'007');
 assert.deepEqual(body.data[0].filters,{productType:'Ribbon',categoryKeys:'grosgrain',catalogCode:'007'});
 body=await(await request(`/${cid}/entries?material=grosgrain&q=Color&page=2`)).json();assert.equal(body.data.length,49);assert.equal(body.pagination.total,196);
 body=await(await request(`/${cid}/entries?material=grosgrain&q=.*`)).json();assert.equal(body.data.length,0);
 for(const suffix of ['material=unknown','material=grosgrain&page=0','material=grosgrain&page=1.5','material=grosgrain&page=1x','material=grosgrain&q='+ 'a'.repeat(101),'material=grosgrain&q[x]=1'])assert.equal((await request(`/${cid}/entries?${suffix}`)).status,400);
 assert.equal((await request('/bad/entries?material=grosgrain')).status,400);
 assert.equal((await request(`/${other}/entries?material=grosgrain`)).status,404);
 body=await(await request(`/${cid}/entries/${entries[7]._id}`)).json();assert.deepEqual(body.data.filters,{productType:'Ribbon',categoryKeys:'grosgrain',catalogCode:'007'});
 assert.equal('availableNow' in body.data,false);
 // Publish only fixtures: no database is connected in this test.
 catalog.isActive=true;entries.forEach(e=>e.isActive=true);entries[0].isActive=false;
 body=await(await request(`/${cid}/entries?material=grosgrain&page=1`)).json();assert.equal(body.data.length,48);assert.equal(body.data[0].code,'001');assert.equal(body.data.at(-1).code,'048');
 for(const role of ['customer','admin'])assert.equal((await request(`/${cid}/entries/${entries[0]._id}?preview=true&isActive=false`,role)).status,404);
 entries[1].catalog=other;assert.equal((await request(`/${cid}/entries/${entries[1]._id}`)).status,404);
 categories[0].isActive=false;assert.equal((await request(`/${cid}/entries/${entries[7]._id}`)).status,404);
 assert.equal((await request(`/${cid}/entries?material=grosgrain`)).status,400);
});
