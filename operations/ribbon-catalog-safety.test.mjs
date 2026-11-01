import test from 'node:test';import assert from 'node:assert/strict';
import {parseArgs,checkImage,parallel,requireSkuIndex,verifyImage} from './ribbon-catalog-safety.mjs';
test('preview is default; apply requires explicit count',()=>{
 assert.equal(parseArgs(['manifest.json']).apply,false);
 assert.throws(()=>parseArgs(['manifest.json','--apply']));
 assert.deepEqual(parseArgs(['manifest.json','--apply','--expect-count=819']),{manifest:'manifest.json',apply:true,expected:819});
 for(const args of [['a','b'],['a','--apply','--apply'],['a','--expect-count=1','--expect-count=2'],['a','--apply','--expect-count=-1'],['a','--unknown']])assert.throws(()=>parseArgs(args));
});
test('images must match exact material/code/color; 435 spelling exception remains explicit',()=>{
 const row={material:'satin',code:'435',color:'Thistle',images:['https://megadie.s3.eu-central-1.amazonaws.com/Plain+Satin+Ribbons/435ThristleSatin.jpg.webp']};
 checkImage(row);
 for(const changed of [{code:'434'},{color:'Red'},{material:'grosgrain'},{images:[row.images[0]+'?wrong=true']},{images:[row.images[0].replace('amazonaws.com','example.com')]}])assert.throws(()=>checkImage({...row,...changed}));
});
test('requires actual full unique SKU index',()=>{
 requireSkuIndex([{key:{sku:1},unique:true}]);
 for(const index of [{key:{sku:1}},{key:{sku:1},unique:true,sparse:true},{key:{sku:1,category:1},unique:true},{key:{sku:1},unique:true,partialFilterExpression:{isActive:true}}])assert.throws(()=>requireSkuIndex([index]));
});
test('parallel failure waits for in-flight work before returning',async()=>{
 let finished=false;
 await assert.rejects(parallel([0,1,2],async i=>{if(i===0){await new Promise(r=>setTimeout(r,5));throw Error('expected');}await new Promise(r=>setTimeout(r,20));finished=true;},2),/expected/);
 assert.equal(finished,true);
});

test('image retries recover temporary failure but never accept 404 or non-image',async()=>{
 let calls=0;
 await verifyImage('https://example.test/image',async()=>{calls++;return new Response(null,{status:calls===1?503:200,headers:{'content-type':'image/jpeg'}});},async()=>{});
 assert.equal(calls,2);
 for(const [status,type] of [[404,'text/html'],[200,'text/html']]){calls=0;await assert.rejects(verifyImage('https://example.test/image',async()=>{calls++;return new Response(null,{status,headers:{'content-type':type}});},async()=>{}));assert.equal(calls,1);}
});
