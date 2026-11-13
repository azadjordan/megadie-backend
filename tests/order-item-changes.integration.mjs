// Disposable named localhost replica set only; never imports server.js or .env.
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import express from "express";
import cookieParser from "cookie-parser";
import User from "../models/userModel.js";
import Order from "../models/orderModel.js";
import Product from "../models/productModel.js";
import Invoice from "../models/invoiceModel.js";
import Slot from "../models/slotModel.js";
import SlotItem from "../models/slotItemModel.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import InventoryMovement from "../models/inventoryMovementModel.js";
import orderRoutes from "../routes/orderRoutes.js";
import packingRoutes from "../routes/packingRoutes.js";
import { errorHandler } from "../middleware/errorMiddleware.js";
import { testSessionCookies } from "./helpers/sessionCookie.mjs";

const uri = process.env.ORDER_ITEMS_TEST_URI;
test("admin order item changes", { skip: !uri, timeout: 120000 }, async t => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/megadie_order_items_test(?:\?|$)/);
  process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "isolated-order-items-tests-only";
  await mongoose.connect(uri, { autoIndex: false }); await mongoose.connection.dropDatabase();
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  await OrderAllocation.createIndexes(); await InventoryMovement.createCollection();
  const createUser = (name, attrs = {}) => User.create({ name, email: name + '@test.invalid', phoneNumber: name, password: "test-password", approvalStatus: "Approved", ...attrs });
  const admin = await createUser("Owner", { isAdmin: true }), worker = await createUser("Worker", { isWorker: true }), client = await createUser("Client");
  const app = express();app.use(express.json(),cookieParser());app.use('/api/orders',orderRoutes);app.use('/api/packing',packingRoutes);app.use(errorHandler);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const cookieFor=testSessionCookies(), base='http://127.0.0.1:'+server.address().port+'/api';
  async function api(path,{actor=admin,method='GET',body,origin='http://localhost:5173'}={}) {
    const result=await fetch(base+path,{method,headers:{Cookie:await cookieFor(actor),Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:result.status,body:await result.json()};
  }
  const ok=result=>assert.equal(result.status,200,JSON.stringify(result.body));
  async function fixture({picked=6,problem=true}={}) {
    const a=new mongoose.Types.ObjectId(),b=new mongoose.Types.ObjectId();
    await Product.collection.insertMany([{_id:a,name:'Red ribbon',sku:'RED-'+a,packingUnit:'100yd Roll',isActive:true,cbm:1},{_id:b,name:'Blue ribbon',sku:'BLUE-'+b,packingUnit:'100yd Roll',isActive:true,cbm:1}]);
    const slots=await Slot.create([{store:'AE1',unit:'A',position:1,cbm:1000},{store:'AE1',unit:'B',position:2,cbm:1000},{store:'AE1',unit:'C',position:3,cbm:1000}]);
    await SlotItem.collection.insertMany([{product:a,slot:slots[0]._id,qty:20,cbm:20},{product:a,slot:slots[1]._id,qty:10,cbm:10},{product:b,slot:slots[2]._id,qty:8,cbm:8}]);
    const order=await Order.create({user:client._id,status:'Shipping',packingWorker:worker._id,packingSentAt:new Date(),assignedTo:worker.name,preparationMode:'prepare_only',deliveryCharge:5,extraFee:1,orderItems:[{product:a,sku:'RED-'+a,qty:10,unitPrice:2.5}],allocationStatus:'Allocated'});
    const allocation=await OrderAllocation.create({order:order._id,product:a,slot:slots[0]._id,qty:10,pickedQty:picked,pickProblem:problem,by:admin._id,pickedBy:worker._id});
    if(problem) await Order.updateOne({_id:order._id},{$push:{packingReports:{allocation:allocation._id,product:a,sku:'RED-'+a,slot:slots[0]._id,slotLabel:'A1-AE1',requestedQty:10,pickedQty:picked,shortQty:10-picked,by:worker._id,byName:worker.name}}});
    return {order,a,b,slots,allocation};
  }
  const sheet=async f=>{const r=await api('/orders/'+f.order._id+'/items-editor');ok(r);return r.body.data;};
  async function preview(f,items) {const s=await sheet(f);const r=await api('/orders/'+f.order._id+'/items-preview',{method:'POST',body:{expectedRevision:s.version,items}});ok(r);return {...r.body.data,version:s.version};}
  const save=(f,items,p,extra={})=>api('/orders/'+f.order._id+'/items',{method:'PUT',body:{expectedRevision:p.version,token:p.token,items,...extra}});
  const quantity=qty=>[{key:'line-0',qty}];

  await t.test('only admins from the website can preview or save item changes',async()=>{
    const f=await fixture();
    for(const actor of [worker,client]) {
      assert.equal((await api('/orders/'+f.order._id+'/items-editor',{actor})).status,403);
      assert.equal((await api('/orders/'+f.order._id+'/items-preview',{actor,method:'POST',body:{}})).status,403);
      assert.equal((await api('/orders/'+f.order._id+'/items',{actor,method:'PUT',body:{}})).status,403);
      assert.equal((await api('/orders/'+f.order._id+'/item-products?search=RED',{actor})).status,403);
    }
    assert.equal((await api('/orders/'+f.order._id+'/items-preview',{method:'POST',origin:'https://elsewhere.invalid',body:{}})).status,403);
  });
  await t.test('no-op drafts are recognized without changing the order',async()=>{
    const f=await fixture();const p=await preview(f,quantity(10));assert.equal(p.changed,false);assert.equal(p.canSave,false);
    assert.equal((await Order.findById(f.order._id).select('+reservationRevision')).reservationRevision,0);
  });
  await t.test('accepting six of ten preserves six picks, clears the shortage, and releases four without a return',async()=>{
    const f=await fixture(),items=quantity(6),p=await preview(f,items);assert.deepEqual(p.returns,[]);assert.equal(p.requiresPhysicalReturn,false);assert.equal(p.afterTotal,21);
    ok(await save(f,items,p));
    const order=await Order.findById(f.order._id).select('+itemChanges +packingReports');const row=await OrderAllocation.findById(f.allocation._id);
    assert.equal(order.orderItems[0].qty,6);assert.equal(order.totalPrice,21);assert.equal(row.qty,6);assert.equal(row.pickedQty,6);assert.equal(row.pickProblem,false);
    assert.equal(String(order.packingWorker),String(worker._id));assert.ok(order.packingSentAt);assert.equal(order.packingReports.length,1);
    assert.equal(order.itemChanges[0].before[0].qty,10);assert.equal(order.itemChanges[0].after[0].qty,6);assert.equal(order.packingSummary.needsHelp,false);
    assert.equal((await SlotItem.findOne({product:f.a,slot:f.slots[0]._id})).qty,20);
    const movement=await InventoryMovement.findOne({order:f.order._id,type:'RELEASE'});assert.equal(movement.qty,4);assert.equal(movement.meta.returnedPickedQty,0);
    const workerView=await api('/packing/orders/'+f.order._id,{actor:worker});ok(workerView);assert.equal(workerView.body.data.itemsRevision,1);assert.equal(workerView.body.data.items[0].qty,6);assert.equal(workerView.body.data.canPack,true);assert.doesNotMatch(JSON.stringify(workerView.body),/unitPrice|beforeTotal|itemChanges/);
  });
  await t.test('reducing below picked quantities needs an exact physical-return acknowledgement',async()=>{
    const f=await fixture(),items=quantity(4),p=await preview(f,items);assert.equal(p.returns[0].qty,2);assert.equal(p.returns[0].slot,'A1-AE1');
    assert.equal((await save(f,items,p)).status,400);
    assert.equal((await OrderAllocation.findById(f.allocation._id)).pickedQty,6);
    ok(await save(f,items,p,{confirmedPhysicalReturn:true}));
    const row=await OrderAllocation.findById(f.allocation._id);assert.equal(row.qty,4);assert.equal(row.pickedQty,4);
    assert.equal((await SlotItem.findOne({product:f.a,slot:f.slots[0]._id})).qty,20);
    assert.equal((await InventoryMovement.findOne({order:f.order._id})).meta.returnedPickedQty,2);
  });
  await t.test('remove and add is an atomic substitution with a new price and zero new picks',async()=>{
    const f=await fixture(),items=[{productId:String(f.b),qty:4,unitPrice:3.25}],p=await preview(f,items);assert.equal(p.returns[0].qty,6);
    ok(await save(f,items,p,{confirmedPhysicalReturn:true}));
    const order=await Order.findById(f.order._id);assert.equal(String(order.orderItems[0].product),String(f.b));assert.equal(order.totalPrice,19);
    assert.equal(await OrderAllocation.countDocuments({order:f.order._id,product:f.a}),0);
    const row=await OrderAllocation.findOne({order:f.order._id,product:f.b});assert.equal(row.qty,4);assert.equal(row.pickedQty,0);assert.equal(row.expiresAt,undefined);
    assert.equal((await SlotItem.findOne({product:f.b})).qty,8);assert.equal((await SlotItem.findOne({product:f.a,slot:f.slots[0]._id})).qty,20);
  });
  await t.test('a partial substitution keeps all six original picks without return confirmation',async()=>{
    const f=await fixture(),items=[...quantity(6),{productId:String(f.b),qty:4,unitPrice:3}],p=await preview(f,items);assert.equal(p.requiresPhysicalReturn,false);
    ok(await save(f,items,p));assert.equal((await OrderAllocation.findById(f.allocation._id)).pickedQty,6);
    assert.equal((await OrderAllocation.findOne({order:f.order._id,product:f.b})).pickedQty,0);
  });
  await t.test('insufficient stock reports the item and leaves every change unapplied',async()=>{
    const f=await fixture(),items=[...quantity(6),{productId:String(f.b),qty:9,unitPrice:3}],p=await preview(f,items);
    assert.equal(p.canSave,false);assert.match(p.issues[0].message,/1 still missing/);
    assert.equal((await save(f,items,p)).status,409);assert.equal((await Order.findById(f.order._id)).orderItems[0].qty,10);assert.equal((await OrderAllocation.findById(f.allocation._id)).qty,10);assert.equal(await InventoryMovement.countDocuments({order:f.order._id}),0);
  });
  await t.test('a competing explicit picked-total update invalidates an earlier return confirmation',async()=>{
    const f=await fixture(),items=quantity(4),p=await preview(f,items);
    ok(await api('/packing/orders/'+f.order._id+'/problem',{actor:worker,method:'POST',body:{allocationId:String(f.allocation._id),pickedQty:8,expectedRevision:0}}));
    const result=await save(f,items,p,{confirmedPhysicalReturn:true});assert.equal(result.status,409);assert.equal(result.body.refresh,true);
    assert.equal((await OrderAllocation.findById(f.allocation._id)).pickedQty,8);assert.equal((await Order.findById(f.order._id)).orderItems[0].qty,10);
  });
  await t.test('stock availability is checked again at save even when order version did not change',async()=>{
    const f=await fixture(),items=[...quantity(6),{productId:String(f.b),qty:4,unitPrice:3}],p=await preview(f,items);
    await OrderAllocation.create({order:new mongoose.Types.ObjectId(),product:f.b,slot:f.slots[2]._id,qty:6});
    assert.equal((await save(f,items,p)).status,409);assert.equal((await Order.findById(f.order._id)).orderItems[0].qty,10);assert.equal(await InventoryMovement.countDocuments({order:f.order._id}),0);
  });
  await t.test('an audit failure rolls back order, reservations, returned picks and history',async()=>{
    const f=await fixture(),items=[{productId:String(f.b),qty:4,unitPrice:3}],p=await preview(f,items),original=InventoryMovement.create;
    const audit=t.mock.method(InventoryMovement,'create',async function(...args){if(args[0]?.[0]?.type==='RESERVE')throw new Error('Test item-change audit failure');return original.apply(this,args);});
    try {assert.equal((await save(f,items,p,{confirmedPhysicalReturn:true})).status,500);} finally {audit.mock.restore();}
    const order=await Order.findById(f.order._id).select('+itemChanges +reservationRevision');assert.equal(order.orderItems[0].qty,10);assert.equal(order.reservationRevision,0);assert.equal(order.itemChanges.length,0);assert.equal((await OrderAllocation.findById(f.allocation._id)).pickedQty,6);assert.equal(await OrderAllocation.countDocuments({order:f.order._id}),1);assert.equal(await InventoryMovement.countDocuments({order:f.order._id}),0);
  });
  await t.test('invoiced, packed, delivered and finalized orders are locked',async()=>{
    for(const attrs of [{invoice:new mongoose.Types.ObjectId()},{packedAt:new Date()},{status:'Delivered'},{stockFinalizedAt:new Date()}]) {
      const f=await fixture();await Order.updateOne({_id:f.order._id},{$set:attrs});const s=await sheet(f);assert.equal(s.canEdit,false);assert.ok(s.lockReason);
      assert.equal((await api('/orders/'+f.order._id+'/items-preview',{method:'POST',body:{expectedRevision:0,items:quantity(6)}})).status,409);
    }
    const f=await fixture();await Invoice.collection.insertOne({order:f.order._id,invoiceNumber:'HIDDEN-INVOICE'});assert.match((await sheet(f)).lockReason,/Invoice/);
  });
  await t.test('an invoice created after preview blocks the save',async()=>{
    const f=await fixture(),items=quantity(6),p=await preview(f,items);await Order.updateOne({_id:f.order._id},{$set:{invoice:new mongoose.Types.ObjectId()}});
    assert.equal((await save(f,items,p)).status,409);assert.equal((await OrderAllocation.findById(f.allocation._id)).qty,10);
  });
  await t.test('removing all items explicitly cancels, preserves original history, and revokes the worker task',async()=>{
    const f=await fixture(),p=await preview(f,[]);assert.equal(p.cancelOrder,true);assert.equal(p.afterTotal,0);
    assert.equal((await save(f,[],p,{confirmedPhysicalReturn:true})).status,400);
    ok(await save(f,[],p,{confirmedPhysicalReturn:true,cancelOrder:true}));
    const order=await Order.findById(f.order._id).select('+itemChanges +packingReports');assert.equal(order.status,'Cancelled');assert.equal(order.orderItems[0].qty,10);assert.equal(order.itemChanges[0].cancelled,true);assert.equal(order.packingReports.length,1);assert.equal(order.packingSentAt,undefined);assert.equal(await OrderAllocation.countDocuments({order:f.order._id}),0);
    assert.equal((await api('/packing/orders/'+f.order._id,{actor:worker})).status,403);
  });
  await t.test('item price bypasses, duplicated additions and generic edits stay rejected',async()=>{
    const f=await fixture();
    for(const items of [[{key:'line-0',qty:6,unitPrice:1}],[...quantity(6),{productId:String(f.a),qty:1,unitPrice:1}],[{productId:String(f.b),qty:1,unitPrice:1.234}],[{key:'line-0',qty:0}],[{key:'line-0',qty:6},{key:'line-00',qty:4}]]) {
      assert.equal((await api('/orders/'+f.order._id+'/items-preview',{method:'POST',body:{expectedRevision:0,items}})).status,400);
    }
    assert.equal((await api('/orders/'+f.order._id,{method:'PUT',body:{orderItems:[]}})).status,400);
  });
  await t.test('legacy duplicate product lines retain their own prices while sharing a picking target',async()=>{
    const f=await fixture();await Order.updateOne({_id:f.order._id},{$set:{orderItems:[{product:f.a,sku:'SAME',qty:6,unitPrice:1},{product:f.a,sku:'SAME',qty:4,unitPrice:2}]}});
    const items=[{key:'line-0',qty:4},{key:'line-1',qty:2}],p=await preview(f,items);assert.equal(p.returns.length,0);ok(await save(f,items,p));
    const order=await Order.findById(f.order._id);assert.deepEqual(order.orderItems.map(i=>[i.qty,i.unitPrice]),[[4,1],[2,2]]);assert.equal((await OrderAllocation.findById(f.allocation._id)).pickedQty,6);
  });
  await t.test('old records require no item-change or revision backfill',async()=>{
    const f=await fixture({picked:0,problem:false});await Order.collection.updateOne({_id:f.order._id},{$unset:{reservationRevision:'',itemChanges:'',packingActivity:'',packingReports:''}});
    const items=quantity(8),p=await preview(f,items);ok(await save(f,items,p));assert.equal((await Order.findById(f.order._id)).orderItems[0].qty,8);
  });
  await t.test('unrelated reservations and their shortage reports remain untouched',async()=>{
    const f=await fixture();
    await Order.updateOne({_id:f.order._id},{$push:{orderItems:{product:f.b,sku:'BLUE-'+f.b,qty:3,unitPrice:3}}});
    const held=await OrderAllocation.create({order:f.order._id,product:f.b,slot:f.slots[2]._id,qty:3,pickedQty:1,pickProblem:true,pickedBy:worker._id});
    const before=await OrderAllocation.findById(held._id).lean();
    const items=[...quantity(6),{key:'line-1',qty:3}],p=await preview(f,items);ok(await save(f,items,p));
    assert.deepEqual(await OrderAllocation.findById(held._id).lean(),before);
    const order=await Order.findById(f.order._id);assert.equal(order.packingSummary.needsHelp,true);assert.equal(order.totalPrice,30);
  });
  await t.test('an increase reserves new units without increasing picked totals',async()=>{
    const f=await fixture({problem:false}),items=quantity(12),p=await preview(f,items);ok(await save(f,items,p));
    const rows=await OrderAllocation.find({order:f.order._id}).lean();assert.equal(rows.reduce((n,r)=>n+r.qty,0),12);assert.equal(rows.reduce((n,r)=>n+r.pickedQty,0),6);
    assert.equal((await OrderAllocation.findById(f.allocation._id)).pickedBy.toString(),worker._id.toString());
  });
  await t.test('reported-short and inactive slots are excluded from added reservations',async()=>{
    const f=await fixture();const reduced=quantity(6);ok(await save(f,reduced,await preview(f,reduced)));
    const items=quantity(9),p=await preview(f,items);assert.equal(p.canSave,true);
    await Slot.updateOne({_id:f.slots[1]._id},{$set:{isActive:false}});
    assert.equal((await save(f,items,p)).status,409);
    assert.equal((await Order.findById(f.order._id)).orderItems[0].qty,6);
    assert.equal((await preview(f,items)).canSave,false);
  });
  await t.test('two orders cannot reserve the same replacement stock concurrently',async()=>{
    const f=await fixture(),g=await fixture();
    const first=[...quantity(6),{productId:String(f.b),qty:6,unitPrice:3}],second=[...quantity(6),{productId:String(f.b),qty:6,unitPrice:3}];
    const p=await preview(f,first),q=await preview(g,second);
    const results=await Promise.all([save(f,first,p),save(g,second,q)]);
    assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===409).length,1);
    const holds=await OrderAllocation.find({product:f.b,status:'Reserved'});assert.equal(holds.reduce((n,r)=>n+r.qty,0),6);
    const failed=results[0].status===409?f:g;assert.equal((await Order.findById(failed.order._id)).orderItems[0].qty,10);
  });
  await t.test('a changed reservation plan requires checking and confirming the new plan',async()=>{
    const f=await fixture(),items=[...quantity(4),{productId:String(f.b),qty:4,unitPrice:3}],p=await preview(f,items);
    const slot=await Slot.create({store:'AE1',unit:'D',position:4,cbm:1000});await SlotItem.collection.insertOne({product:f.b,slot:slot._id,qty:4,cbm:4});
    const result=await save(f,items,p,{confirmedPhysicalReturn:true});assert.equal(result.status,409);assert.match(result.body.message,/Stock or return quantities changed/);
    assert.equal((await OrderAllocation.findById(f.allocation._id)).pickedQty,6);assert.equal(await InventoryMovement.countDocuments({order:f.order._id}),0);
  });
  await t.test('a repeated successful save cannot release stock or add reservations twice',async()=>{
    const f=await fixture(),items=[...quantity(6),{productId:String(f.b),qty:4,unitPrice:3}],p=await preview(f,items);
    ok(await save(f,items,p));assert.equal((await save(f,items,p)).status,409);
    assert.equal(await InventoryMovement.countDocuments({order:f.order._id,type:'RELEASE'}),1);assert.equal(await InventoryMovement.countDocuments({order:f.order._id,type:'RESERVE'}),1);
  });

  await t.test('every item change retains the earlier history with accurate line totals',async()=>{
    const f=await fixture();let items=quantity(6);ok(await save(f,items,await preview(f,items)));
    items=quantity(4);ok(await save(f,items,await preview(f,items),{confirmedPhysicalReturn:true}));
    const order=await Order.findById(f.order._id).select('+itemChanges');
    assert.equal(order.itemChanges.length,2);assert.equal(order.itemChanges[0].before[0].qty,10);assert.equal(order.itemChanges[0].after[0].qty,6);assert.equal(order.itemChanges[1].before[0].qty,6);assert.equal(order.itemChanges[1].after[0].qty,4);
    assert.equal(order.itemChanges[0].before[0].lineTotal,25);assert.equal(order.itemChanges[1].after[0].lineTotal,10);
  });

});
