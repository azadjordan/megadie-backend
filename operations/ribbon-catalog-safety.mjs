export function parseArgs(args) {
 const paths=args.filter(a=>!a.startsWith('--'));
 const counts=args.filter(a=>a.startsWith('--expect-count='));
 if(paths.length!==1||counts.length>1||args.filter(a=>a==='--apply').length>1||args.some(a=>a.startsWith('--')&&a!=='--apply'&&!/^--expect-count=\d+$/.test(a)))throw Error('Usage: manifest.json [--apply --expect-count=N]');
 const apply=args.includes('--apply'), expected=counts.length?Number(counts[0].split('=')[1]):undefined;
 if(apply&&!Number.isSafeInteger(expected))throw Error('Apply requires --expect-count=N from a reviewed preview');
 return {manifest:paths[0],apply,expected};
}
export function checkImage(row) {
 const material=row.material==='satin'?'Satin':'Grosgrain';
 const prefix=`https://megadie.s3.eu-central-1.amazonaws.com/Plain+${material}+Ribbons/`;
 if(row.images?.length!==1||!row.images[0].startsWith(prefix))throw Error('Unexpected image path');
 const filename=decodeURIComponent(row.images[0].slice(prefix.length));
 const match=filename.match(new RegExp('^(\\d{3})([A-Za-z]+)'+material+'\\.(jpg|jpeg|png|webp)(\\.webp)?$'));
 if(!match||match[1]!==row.code)throw Error('Image code/material mismatch');
 const expectedColor=row.material==='satin'&&row.code==='435'&&match[2]==='Thristle'?'Thistle':match[2];
 if(row.color!==expectedColor)throw Error('Image color does not match product');
}
export async function parallel(items, fn, concurrency=8) {
 let next=0,failed=false;
 const results=await Promise.allSettled(Array.from({length:concurrency},async()=>{
  while(!failed&&next<items.length){const item=items[next++];try{await fn(item);}catch(e){failed=true;throw e;}}
 }));
 const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;
}
export function requireSkuIndex(indexes) {
 if(!indexes.some(i=>i.unique===true&&i.key.sku===1&&Object.keys(i.key).length===1&&!i.partialFilterExpression&&!i.sparse))throw Error('Required full unique SKU index missing');
}
export async function verifyImage(url, fetcher=fetch, pause=ms=>new Promise(r=>setTimeout(r,ms))) {
 for(let attempt=0;attempt<3;attempt++){
  let response;
  try{response=await fetcher(url,{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(15000)});}
  catch(error){if(attempt===2)throw Error('Image network verification failed: '+url+' ('+error.message+')');await pause(500*(attempt+1));continue;}
  if(response.ok&&response.headers.get('content-type')?.startsWith('image/'))return;
  const temporary=[408,429,500,502,503,504].includes(response.status);
  if(!temporary||attempt===2)throw Error(`Image verification failed: ${url} (HTTP ${response.status}, ${response.headers.get('content-type')})`);
  await pause(500*(attempt+1));
 }
}
