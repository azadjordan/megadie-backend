// Disposable localhost replica set only. Never loads .env or server.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testUri=process.env.DELIVERY_INTEGRITY_TEST_URI;
test('delivery attribution, finalization, fees and legacy-event integrity', { skip: !testUri, timeout: 120000 }, async () => {
const load=async file=>(await import(pathToFileURL(path.join(repo,file))));
const mongoose=(await load('node_modules/mongoose/index.js')).default;
const express=(await load('node_modules/express/index.js')).default;
const cookieParser=(await load('node_modules/cookie-parser/index.js')).default;
process.env.JWT_SECRET='isolated-delivery-preflight';process.env.NODE_ENV='test';
const names=['User','Order','Product','Slot','SlotItem','OrderAllocation','Invoice','Payment','Quote','WorkerWork'];
const files=['userModel','orderModel','productModel','slotModel','slotItemModel','orderAllocationModel','invoiceModel','paymentModel','quoteModel','workerWorkModel'];
const model={}; for(let i=0;i<names.length;i++)model[names[i]]=(await load('models/'+files[i]+'.js')).default;
const {User,Order,Product,Slot,SlotItem,OrderAllocation,Invoice,Payment,Quote,WorkerWork}=model;
const packingRoutes=(await load('routes/packingRoutes.js')).default;
const orderRoutes=(await load('routes/orderRoutes.js')).default;
const {errorHandler}=await load('middleware/errorMiddleware.js');
const {testSessionCookies}=await load('tests/helpers/sessionCookie.mjs');
const uri=testUri;
if(!/^mongodb:\/\/127\.0\.0\.1:\d+\/megadie_delivery_integrity_test(?:\?|$)/.test(uri))throw Error('Unsafe test URI');
const checks=[]; const check=(name,expected,actual)=>checks.push({name,passed:isDeepStrictEqual(expected,actual),expected,actual});
const plain=x=>JSON.parse(JSON.stringify(x));
let server;
await mongoose.connect(uri,{autoIndex:false}); await mongoose.connection.dropDatabase();
try{
 await WorkerWork.createIndexes();await OrderAllocation.createIndexes();
 await (await load('models/inventoryMovementModel.js')).default.createCollection();
 const makeUser=(name,fields={})=>User.create({name,email:name+'@test.invalid',phoneNumber:name,password:'test-password',approvalStatus:'Approved',...fields});
 const admin=await makeUser('Owner',{isAdmin:true}), packer=await makeUser('Packer',{isWorker:true}), driver=await makeUser('Driver',{isWorker:true}), other=await makeUser('Other',{isWorker:true}), customer=await makeUser('Client');
 const app=express();app.use(express.json(),cookieParser());app.use('/api/packing',packingRoutes);app.use('/api/orders',orderRoutes);app.use(errorHandler);
 server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const cookie=testSessionCookies(), base='http://127.0.0.1:'+server.address().port+'/api';
 const api=async(url,actor=admin,method='GET',body)=>{const response=await fetch(base+url,{method,headers:{Origin:'http://localhost:5173',Cookie:await cookie(actor),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,body:await response.json()};};
 const task=async f=>{const r=await api('/packing/deliveries/'+f.order._id);if(r.status!==200)throw Error(JSON.stringify(r));return r.body.data;};
 const move=async(f,action,actor=driver,extra={})=>api('/packing/deliveries/'+f.order._id+'/movement',actor,'POST',{action,expectedRevision:(await task(f)).version,confirmedReady:true,confirmedReceived:true,confirmedReturn:true,...extra});
 let position=1;
 async function fixture(){
  const p=new mongoose.Types.ObjectId();await Product.collection.insertOne({_id:p,name:'Fixture ribbon',sku:'TEST-'+p,packingUnit:'roll',cbm:1});
  const slot=await Slot.create({store:'AE1',unit:'A',position:position++,cbm:1000,occupiedCbm:20});await SlotItem.collection.insertOne({product:p,slot:slot._id,qty:20,cbm:20});
  const packedAt=new Date(Date.now()-60000);
  const order=await Order.create({user:customer._id,status:'Shipping',orderItems:[{product:p,sku:'TEST-'+p,productName:'Fixture ribbon',qty:10,unitPrice:12}],deliveryCharge:10,extraFee:5,totalPrice:135,allocationStatus:'Allocated',packingWorker:packer._id,packingSentAt:new Date(Date.now()-120000),packedAt,packedBy:packer._id,packingActivity:[{action:'PACKED',actor:packer._id,at:packedAt}],preparationMode:'prepare_only',deliveryWorker:driver._id,deliveryDetails:{contactName:'PRIVATE RECIPIENT',phoneNumber:'+971509999999',address:'PRIVATE ADDRESS',googleMapsUrl:'https://maps.google.com/?q=private',notes:'PRIVATE NOTE'}});
  await OrderAllocation.create({order:order._id,product:p,slot:slot._id,qty:10,pickedQty:10,by:packer._id});
  const quote=await Quote.create({user:customer._id,order:order._id,status:'Confirmed',requestedItems:[{product:p,qty:10,unitPrice:12}]});
  const invoice=await Invoice.create({user:customer._id,order:order._id,amountMinor:13500,currency:'AED',minorUnitFactor:100,dueDate:new Date('2030-01-01')});
  await Payment.create({invoice:invoice._id,amountMinor:3000,paymentMethod:'Cash',receivedBy:'Company Account'});
  await Order.updateOne({_id:order._id},{$set:{quote:quote._id,invoice:invoice._id}});
  return{order,p,slot,quote,invoice};
 }
 async function completeAndFinalize(actor,label){
  const f=await fixture(), bill=plain(await Invoice.findById(f.invoice._id).lean()), payments=plain(await Payment.find({invoice:f.invoice._id}).lean());
  check(label+': departure succeeds',200,(await move(f,'departed')).status);
  const completion=await move(f,'delivered',actor);check(label+': completion succeeds',200,completion.status);
  const delivered=await Order.findById(f.order._id).lean();
  const beforeReceipt=await WorkerWork.findOne({order:f.order._id,type:'delivered',active:true}).lean();
  check(label+': assigned driver credited',String(driver._id),String(beforeReceipt?.worker));
  check(label+': confirming actor recorded',String(actor._id),String(beforeReceipt?.actor));
  check(label+': quote removed after receipt',null,await Quote.findById(f.quote._id));
  check(label+': stock unchanged at receipt',20,(await SlotItem.findOne({product:f.p})).qty);
  const finalize=await api('/orders/'+f.order._id+'/allocations/finalize',admin,'POST',{});check(label+': stock finalization succeeds',200,finalize.status);
  const after=await Order.findById(f.order._id).lean();
  check(label+': original delivery timestamp survives finalization',new Date(delivered.deliveredAt).toISOString(),new Date(after.deliveredAt).toISOString());
  check(label+': total including fees survives finalization',135,after.totalPrice);
  check(label+': fees themselves preserved',[10,5],[after.deliveryCharge,after.extraFee]);
  check(label+': invoice unchanged',true,isDeepStrictEqual(bill,plain(await Invoice.findById(f.invoice._id).lean())));
  check(label+': payments unchanged',true,isDeepStrictEqual(payments,plain(await Payment.find({invoice:f.invoice._id}).lean())));
  check(label+': stock deducted once',10,(await SlotItem.findOne({product:f.p})).qty);
  check(label+': allocation finalized','Deducted',(await OrderAllocation.findOne({order:f.order._id})).status);
  check(label+': repeat finalization succeeds safely',200,(await api('/orders/'+f.order._id+'/allocations/finalize',admin,'POST',{})).status);
  check(label+': repeat finalization does not deduct twice',10,(await SlotItem.findOne({product:f.p})).qty);
  check(label+': new work credit retained',1,await WorkerWork.countDocuments({order:f.order._id,type:'delivered',active:true}));
  const closed=await api('/packing/deliveries/'+f.order._id,driver);
  check(label+': completed task is read-only summary','recent-work',closed.body.data?.scope);
  check(label+': completed task omits contacts',false,JSON.stringify(closed.body).includes('PRIVATE'));
  check(label+': unrelated worker denied',403,(await api('/packing/deliveries/'+f.order._id,other)).status);
  return f;
 }
 const first=await completeAndFinalize(driver,'Worker confirms');
 await completeAndFinalize(admin,'Admin confirms assigned worker');
 // Exactly the current admin modal payload: blank handler, no method.
 const departed=await fixture();
 const departure=await api('/orders/'+departed.order._id+'/movement',admin,'POST',{action:'departed',handler:'',expectedRevision:(await task(departed)).version,confirmedReady:true,confirmedReceived:true,confirmedReturn:true});
 check('Admin modal departure: request accepted',200,departure.status);
 const active=await Order.findById(departed.order._id).lean();
 check('Admin modal departure: assigned worker resolves company method','company',active.deliveryMovement?.method??null);
 check('Admin modal departure: display name comes from account',driver.name,active.deliveryMovement?.handler??null);
 const driverTask=await api('/packing/deliveries/'+departed.order._id,driver);
 check('Admin modal departure: assigned worker can finish delivery',true,driverTask.body.data?.canDeliver);
 const direct=await fixture();
 const directResult=await api('/orders/'+direct.order._id+'/movement',admin,'POST',{action:'delivered',expectedRevision:(await task(direct)).version,confirmedReady:true,confirmedReceived:true,confirmedReturn:true});
 check('Admin direct receipt: request accepted',200,directResult.status);
 check('Admin direct receipt: assigned worker credited',1,await WorkerWork.countDocuments({order:direct.order._id,type:'delivered',worker:driver._id,active:true}));
 // Old endpoint: supplied courier name conflicts with an existing worker assignment.
 const legacy=await fixture();
 const legacyResult=await api('/orders/'+legacy.order._id+'/deliver',admin,'PUT',{deliveredBy:'External courier',expectedRevision:(await task(legacy)).version});
 const legacyOrder=await Order.findById(legacy.order._id).lean();
 const wrongCredit=await WorkerWork.countDocuments({order:legacy.order._id,type:'delivered',worker:driver._id,active:true});
 check('Legacy admin route: conflicting courier text cannot credit assigned worker',true,legacyResult.status>=400 || !(legacyOrder.deliveredBy==='External courier'&&wrongCredit>0));
 // Simulate an older completed order, using the real finalized order above.
 await WorkerWork.deleteMany({order:first.order._id,type:'delivered'});
 const ownHistory=await api('/packing/recent-work?period=today',driver);
 check('Legacy history: verified delivery remains visible after finalization',true,ownHistory.body.data?.some(card=>card.orderId===String(first.order._id))??false);
 const monthStart=new Date(new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Dubai'}).slice(0,7)+'-01T00:00:00+04:00');
 const realReceipt=new Date(+monthStart-300000), laterFinalization=new Date(+monthStart+3600000);
 const old=await Order.findById(first.order._id).select('+deliveryHistory');
 const event=old.deliveryHistory.filter(e=>e.action==='delivered').at(-1);
 await Order.collection.updateOne({_id:old._id},{$set:{deliveredAt:laterFinalization,'deliveryHistory':old.deliveryHistory.map(e=>({...e.toObject(),...(String(e._id)===String(event._id)?{at:realReceipt}:{} )}))}});
 const date=new Date(+realReceipt+14400000).toISOString().slice(0,10);
 const oldReport=await api('/packing/recent-work?workerId='+driver._id+'&from='+date+'&to='+date,admin);
 check('Legacy period: completed order is found by actual delivery-event date',true,oldReport.body.data?.some(card=>card.orderId===String(first.order._id))??false);
 const editable=await Order.create({user:customer._id,status:'Shipping',orderItems:[{product:first.p,sku:'EDIT-CHECK',qty:10,unitPrice:12}],deliveryCharge:10,extraFee:5,totalPrice:135});
 const edited=await api('/orders/'+editable._id,admin,'PUT',{deliveryCharge:12,extraFee:8});
 check('Genuine admin fee edits remain allowed',200,edited.status);
 check('Genuine admin fee edits recalculate the total',140,(await Order.findById(editable._id)).totalPrice);
 const unassigned=await api('/packing/deliveries/'+departed.order._id+'/assignment',driver,'POST',{workerId:String(other._id),expectedRevision:(await task(departed)).version});
 check('Worker cannot change delivery responsibility',403,unassigned.status);
 const correction=await fixture();await move(correction,'departed');await move(correction,'delivered',driver);
 check('Admin can correct mistaken receipt',200,(await move(correction,'corrected',admin,{confirmedCorrection:true,note:'Isolated check: receipt recorded by mistake'})).status);
 check('Corrected receipt excluded from valid credit',0,await WorkerWork.countDocuments({order:correction.order._id,type:'delivered',active:true}));
}finally{
 if(server)await new Promise(resolve=>server.close(resolve));
 await mongoose.connection.dropDatabase();await mongoose.disconnect();
 const report={checkedAt:new Date(),database:'Disposable localhost only',passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,checks};
 assert.equal(report.failed, 0, JSON.stringify(checks.filter(check => !check.passed), null, 2));
 console.log('Delivery integrity assertions:', checks.length);
}

});
