// Real browser and APIs, redirected only to this disposable localhost server.
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { chromium } from 'playwright';
import User from '../models/userModel.js';
import Order from '../models/orderModel.js';
import Product from '../models/productModel.js';
import Slot from '../models/slotModel.js';
import SlotItem from '../models/slotItemModel.js';
import OrderAllocation from '../models/orderAllocationModel.js';
import InventoryMovement from '../models/inventoryMovementModel.js';
import orderRoutes from '../routes/orderRoutes.js';
import packingRoutes from '../routes/packingRoutes.js';
import userRoutes from '../routes/userRoutes.js';
import siteSettingsRoutes from '../routes/siteSettingsRoutes.js';
import { errorHandler } from '../middleware/errorMiddleware.js';

const uri=process.env.ORDER_ITEMS_E2E_URI, frontend=process.env.ORDER_ITEMS_TEST_ORIGIN||'http://localhost:5173';
test('real admin item editing and worker continuation', {skip:!uri,timeout:120000},async t=>{
  assert.match(uri,/^mongodb:\/\/127\.0\.0\.1:\d+\/megadie_order_items_e2e_test(?:\?|$)/);
  assert.match(frontend,/^http:\/\/localhost:\d+$/);
  process.env.NODE_ENV='test';process.env.JWT_SECRET='local-order-item-editing-only';
  let browser,server;
  await mongoose.connect(uri,{autoIndex:false});await mongoose.connection.dropDatabase();
  t.after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await mongoose.connection.dropDatabase();await mongoose.disconnect();});
  await OrderAllocation.createIndexes();await InventoryMovement.createCollection();
  const admin=await User.create({name:'Owner',email:'owner@test.invalid',phoneNumber:'owner',password:'test-password',isAdmin:true});
  const worker=await User.create({name:'Worker Ahmed',email:'worker@test.invalid',phoneNumber:'worker',password:'test-password',isWorker:true});
  const customer=await User.create({name:'Ahmed Trading',email:'client@test.invalid',phoneNumber:'client',password:'test-password',approvalStatus:'Approved'});
  const a=new mongoose.Types.ObjectId(),b=new mongoose.Types.ObjectId();
  await Product.collection.insertMany([{_id:a,name:'Red satin ribbon 25 mm',sku:'RIB-RED-25MM',packingUnit:'100yd Roll',isActive:true,cbm:1},{_id:b,name:'Blue grosgrain ribbon 38 mm',sku:'RIB-BLUE-38MM',packingUnit:'100yd Roll',isActive:true,cbm:1}]);
  const [source,target]=await Slot.create([{store:'AE1',unit:'A',position:1,cbm:1000},{store:'AE1',unit:'B',position:2,cbm:1000}]);
  await SlotItem.collection.insertMany([{product:a,slot:source._id,qty:20,cbm:20},{product:b,slot:target._id,qty:8,cbm:8}]);
  const order=await Order.create({user:customer._id,status:'Shipping',packingWorker:worker._id,packingSentAt:new Date(),assignedTo:worker.name,preparationMode:'prepare_only',deliveryCharge:5,extraFee:1,orderItems:[{product:a,sku:'RIB-RED-25MM',qty:10,unitPrice:2.5}],allocationStatus:'Allocated',packingSummary:{totalItems:1,collectedItems:0,inProgressItems:1,needsHelp:true}});
  const allocation=await OrderAllocation.create({order:order._id,product:a,slot:source._id,qty:10,pickedQty:6,pickProblem:true,pickedBy:worker._id,by:admin._id});
  await Order.updateOne({_id:order._id},{$push:{packingReports:{allocation:allocation._id,product:a,sku:'RIB-RED-25MM',slot:source._id,slotLabel:'A1-AE1',requestedQty:10,pickedQty:6,shortQty:4,by:worker._id,byName:worker.name}}});
  const app=express();app.use(cors({origin:frontend,credentials:true}),express.json(),cookieParser());
  app.use('/api/users',userRoutes);app.use('/api/orders',orderRoutes);app.use('/api/packing',packingRoutes);app.use('/api/site-settings',siteSettingsRoutes);app.use(errorHandler);
  server=await new Promise(resolve=>{const s=app.listen(0,()=>resolve(s));});
  const api='http://localhost:'+server.address().port+'/api';
  browser=await chromium.launch({headless:true});
  const errors=[];let loseNextSave=false;let saveRequests=0;
  async function contextFor(width){
    const context=await browser.newContext({viewport:{width,height:900}});
    await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.pathname.startsWith('/api/')){
      const target='http://localhost:'+server.address().port+url.pathname+url.search;
      if(route.request().method()==='PUT'&&url.pathname.endsWith('/items')){
        saveRequests++;
        if(loseNextSave){loseNextSave=false;const committed=await route.fetch({url:target});assert.equal(committed.status(),200,await committed.text());return route.abort('failed');}
      }
      return route.continue({url:target});
    }return url.origin===frontend?route.continue():route.abort();});
    const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));return {page,context};
  }
  async function login(page,user){
    await page.goto(frontend+(user.isAdmin?'/admin/orders/'+order._id+'/packing':'/packing'));await page.getByLabel('Email',{exact:true}).fill(user.email);await page.getByLabel('Password',{exact:true}).fill('test-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(url=>user.isAdmin?url.pathname.startsWith('/admin'):url.pathname.startsWith('/packing'));
  }
  const {page}=await contextFor(1280);await login(page,admin);
  await page.goto(frontend+'/admin/orders/'+order._id+'/packing');
  await page.getByRole('link',{name:'Edit this item',exact:true}).click();
  let dialog=page.getByRole('dialog',{name:'Edit order items',exact:true});
  const redQty=()=>dialog.getByLabel('Order quantity for RIB-RED-25MM',{exact:true});
  const save=()=>dialog.getByRole('button',{name:'Save changes',exact:true});
  await redQty().fill('6');
  await save().waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('[role="dialog"] button')].some(b=>b.textContent==='Save changes'&&!b.disabled));
  assert.equal(await dialog.getByRole('checkbox').count(),0);
  await page.screenshot({path:'/Users/azad/Developer/megadie/output/order-items-implemented-desktop.png',fullPage:true});
  loseNextSave=true;
  await save().click();await dialog.getByRole('button',{name:'Load latest order',exact:true}).click();
  await dialog.getByText('No unsaved changes',{exact:true}).waitFor();
  assert.equal(await save().isDisabled(),true);assert.equal(saveRequests,1);
  await dialog.getByRole('button',{name:'Close',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.match(page.url(),/\/packing$/);
  let saved=await Order.findById(order._id);assert.equal(saved.orderItems[0].qty,6);assert.equal(saved.totalPrice,21);
  assert.equal((await OrderAllocation.findById(allocation._id)).pickedQty,6);

  // Resolving the last shortage must not remove access to the item editor.
  assert.equal(await page.getByRole('link',{name:'Edit this item',exact:true}).count(),0);
  await page.getByRole('link',{name:'Edit order items',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'Edit order items',exact:true});
  assert.equal(await redQty().inputValue(),'6');
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  assert.match(page.url(),/\/packing$/);

  await page.getByRole('link',{name:'Back to order',exact:true}).click();
  await page.getByRole('button',{name:'Edit items',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'Edit order items',exact:true});
  await redQty().fill('4');await dialog.getByText('2 × 100yd Roll',{exact:true}).waitFor();
  assert.equal(await save().isDisabled(),true);
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button',{name:'Add item',exact:true}).click();
  await dialog.getByRole('searchbox',{name:'Search by SKU or product name',exact:true}).fill('BLUE');
  await dialog.getByRole('button',{name:'Add RIB-BLUE-38MM',exact:true}).click();
  await dialog.getByLabel('Order quantity for RIB-BLUE-38MM',{exact:true}).fill('3');
  await dialog.getByLabel('Agreed unit price for RIB-BLUE-38MM',{exact:true}).fill('3.25');
  await dialog.getByText('2 × 100yd Roll',{exact:true}).waitFor();assert.equal(await dialog.getByRole('checkbox').isChecked(),false);
  await page.setViewportSize({width:390,height:844});
  await dialog.getByRole('checkbox').check();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const buttonBounds=await save().boundingBox();assert.ok(buttonBounds&&buttonBounds.y+buttonBounds.height<=844);
  await page.screenshot({path:'/Users/azad/Developer/megadie/output/order-items-implemented-mobile.png',fullPage:true});
  await save().click();await dialog.waitFor({state:'hidden'});
  saved=await Order.findById(order._id);assert.equal(saved.totalPrice,25.75);assert.deepEqual(saved.orderItems.map(i=>[i.qty,i.unitPrice]),[[4,2.5],[3,3.25]]);
  const blueAllocation=await OrderAllocation.findOne({order:order._id,product:b});assert.equal(blueAllocation.pickedQty,0);

  const employee=await contextFor(390);await login(employee.page,worker);await employee.page.getByRole('heading',{name:'My packing orders',exact:true}).waitFor();
  await employee.page.goto(frontend+'/packing/orders/'+order._id);
  await employee.page.getByText(/Order updated by Owner/).waitFor();
  await employee.page.getByRole('article',{name:'RIB-BLUE-38MM',exact:true}).getByText('Picked 0 of 3',{exact:true}).waitFor();
  assert.equal(await employee.page.getByText('Unit price · AED',{exact:true}).count(),0);
  assert.equal(await employee.page.getByRole('link',{name:'Edit order items',exact:true}).count(),0);
  assert.equal(await employee.page.getByRole('button',{name:'Edit order items',exact:true}).count(),0);

  await page.getByRole('button',{name:'Edit items',exact:true}).click();dialog=page.getByRole('dialog',{name:'Edit order items',exact:true});
  await redQty().fill('2');await dialog.getByText('2 × 100yd Roll',{exact:true}).waitFor();await dialog.getByRole('checkbox').check();
  const progress=await Order.findById(order._id).select('+reservationRevision');
  const picked=await employee.context.request.post(api+'/packing/orders/'+order._id+'/pick',{headers:{Origin:frontend},data:{allocationId:String(blueAllocation._id),pickedQty:1,expectedRevision:progress.reservationRevision}});
  assert.equal(picked.status(),200,await picked.text());
  await save().click();await dialog.getByRole('button',{name:'Load latest order',exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Load latest order',exact:true}).click();
  await dialog.getByText('2 × 100yd Roll',{exact:true}).waitFor();assert.equal(await redQty().inputValue(),'2');assert.equal(await dialog.getByRole('checkbox').isChecked(),false);
  await dialog.getByRole('checkbox').check();await save().click();await dialog.waitFor({state:'hidden'});
  assert.equal((await Order.findById(order._id)).orderItems[0].qty,2);

  await page.getByRole('button',{name:'Edit items',exact:true}).click();dialog=page.getByRole('dialog',{name:'Edit order items',exact:true});
  await dialog.getByLabel('Order quantity for RIB-BLUE-38MM',{exact:true}).fill('10');
  await dialog.getByText(/Cannot reserve the added quantity/).waitFor();assert.equal(await save().isDisabled(),true);
  assert.equal((await Order.findById(order._id)).orderItems[1].qty,3);
  await dialog.getByLabel('Order quantity for RIB-BLUE-38MM',{exact:true}).fill('4');
  await page.waitForFunction(()=>[...document.querySelectorAll('[role="dialog"] button')].some(b=>b.textContent==='Save changes'&&!b.disabled));
  await save().click();await dialog.waitFor({state:'hidden'});
  assert.equal((await Order.findById(order._id)).totalPrice,24);
  assert.equal((await OrderAllocation.findById(blueAllocation._id)).pickedQty,1);

  await page.getByRole('button',{name:'Edit items',exact:true}).click();dialog=page.getByRole('dialog',{name:'Edit order items',exact:true});
  await redQty().fill('1');await dialog.getByText('1 × 100yd Roll',{exact:true}).waitFor();await dialog.getByRole('checkbox').check();
  const otherSheet=await (await page.context().request.get(api+'/orders/'+order._id+'/items-editor')).json();
  const otherItems=[{key:'line-1',qty:4}];
  const otherPlan=await (await page.context().request.post(api+'/orders/'+order._id+'/items-preview',{headers:{Origin:frontend},data:{expectedRevision:otherSheet.data.version,items:otherItems}})).json();
  const otherSaved=await page.context().request.put(api+'/orders/'+order._id+'/items',{headers:{Origin:frontend},data:{expectedRevision:otherSheet.data.version,items:otherItems,token:otherPlan.data.token,confirmedPhysicalReturn:true}});
  assert.equal(otherSaved.status(),200,await otherSaved.text());
  await save().click();await dialog.getByRole('button',{name:'Load latest order',exact:true}).click();
  await dialog.getByText(/Another admin changed the item list/).waitFor();
  assert.equal(await dialog.getByLabel('Order quantity for RIB-BLUE-38MM',{exact:true}).inputValue(),'4');
  assert.equal(await dialog.getByRole('article',{name:'RIB-RED-25MM',exact:true}).count(),0);
  await dialog.getByText('Your previous draft',{exact:true}).click();await dialog.getByText('RIB-RED-25MM: 1 × 100yd Roll',{exact:true}).waitFor();

  await dialog.getByRole('article',{name:'RIB-BLUE-38MM',exact:true}).getByRole('button',{name:'Remove item',exact:true}).click();
  await dialog.getByRole('button',{name:'Cancel order',exact:true}).waitFor();await dialog.getByRole('checkbox').check();
  loseNextSave=true;
  await dialog.getByRole('button',{name:'Cancel order',exact:true}).click();
  await dialog.getByRole('button',{name:'Load latest order',exact:true}).click();await dialog.waitFor({state:'hidden'});
  saved=await Order.findById(order._id).select('+itemChanges +packingReports');assert.equal(saved.status,'Cancelled');assert.equal(saved.itemChanges.length,6);assert.equal(saved.packingReports.length,1);
  await page.reload();
  await page.getByRole('link',{name:'View packing',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Edit order items',exact:true}).isDisabled(),true);
  await page.getByText('Items can only be changed while the order is Shipping.',{exact:true}).waitFor();
  await page.getByText('Stock reports (1)',{exact:true}).waitFor();
  await page.getByText('Picked 6 of 10; 4 missing.',{exact:true}).waitFor();
  assert.equal(await OrderAllocation.countDocuments({order:order._id}),0);
  assert.equal((await SlotItem.findOne({product:a,slot:source._id})).qty,20);assert.equal((await SlotItem.findOne({product:b,slot:target._id})).qty,8);

  // Reported case: remove a 37-unit item after only seven were found, then
  // continue editing the remaining order without needing another shortage.
  const removalOrder=await Order.create({user:customer._id,status:'Shipping',packingWorker:worker._id,packingSentAt:new Date(),assignedTo:worker.name,preparationMode:'prepare_only',orderItems:[{product:a,sku:'RIB-RED-25MM',qty:37,unitPrice:2.5},{product:b,sku:'RIB-BLUE-38MM',qty:2,unitPrice:3.25}],allocationStatus:'Allocated',packingSummary:{totalItems:2,collectedItems:0,inProgressItems:1,needsHelp:true}});
  await OrderAllocation.create([{order:removalOrder._id,product:a,slot:source._id,qty:37,pickedQty:7,pickProblem:true,pickedBy:worker._id,by:admin._id},{order:removalOrder._id,product:b,slot:target._id,qty:2,by:admin._id}]);
  await page.goto(frontend+'/admin/orders/'+removalOrder._id+'/packing');
  await page.getByRole('link',{name:'Edit this item',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'Edit order items',exact:true});
  await dialog.getByRole('article',{name:'RIB-RED-25MM',exact:true}).getByRole('button',{name:'Remove item',exact:true}).click();
  await dialog.getByText('7 × 100yd Roll',{exact:true}).waitFor();
  await dialog.getByRole('checkbox').check();await save().click();await dialog.waitFor({state:'hidden'});
  await page.getByRole('article',{name:'RIB-BLUE-38MM',exact:true}).waitFor();
  assert.equal(await page.getByRole('article',{name:'RIB-RED-25MM',exact:true}).count(),0);
  assert.equal(await page.getByRole('link',{name:'Edit this item',exact:true}).count(),0);
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('link',{name:'Edit order items',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'Edit order items',exact:true});
  assert.equal(await dialog.getByLabel('Order quantity for RIB-BLUE-38MM',{exact:true}).inputValue(),'2');
  await dialog.getByRole('button',{name:'Close',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await page.getByRole('link',{name:'Edit order items',exact:true}).waitFor();
  await page.getByRole('article',{name:'RIB-BLUE-38MM',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'/Users/azad/Developer/megadie/output/order-items-packing-action-mobile.png',fullPage:true});
  const remaining=await Order.findById(removalOrder._id);assert.equal(remaining.status,'Shipping');assert.equal(remaining.orderItems.length,1);
  assert.deepEqual(errors,[]);
});
