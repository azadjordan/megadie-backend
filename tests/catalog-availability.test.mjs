import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import Catalog from '../models/catalogModel.js';
import CatalogEntry from '../models/catalogEntryModel.js';
import Category from '../models/categoryModel.js';
import Product from '../models/productModel.js';
import SlotItem from '../models/slotItemModel.js';
import OrderAllocation from '../models/orderAllocationModel.js';
import User from '../models/userModel.js';
import catalogRoutes from '../routes/catalogRoutes.js';
import {getProductsAvailability} from '../controllers/productController.js';
import {protect, requireApproved} from '../middleware/authMiddleware.js';

const oid = n => (100000000000000000000000n + BigInt(n)).toString();
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some(part => matches(row, part));
    if (value?.$in) return value.$in.some(item => String(item) === String(row[key]));
    if (value && typeof value === 'object' && '$ne' in value) return String(row[key]) !== String(value.$ne);
    return String(row[key]) === String(value);
  });
}
function query(rows) {
  let fields;
  return {
    select(value) { fields = value.split(' '); return this; },
    async lean() {
      const pick = row => row && fields ? Object.fromEntries(fields.filter(key => key in row).map(key => [key, row[key]])) : row;
      return Array.isArray(rows) ? rows.map(pick) : pick(rows);
    },
  };
}

test('catalog stock summaries share fresh SKU stock math, enforce visibility, and batch inventory reads', async t => {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'catalog-availability-test-only';
  const catalog = {_id:oid(1), productType:'Ribbon', layout:'color-grid', isActive:false};
  const categories = [
    {_id:oid(10), productType:'Ribbon', isActive:true},
    {_id:oid(11), productType:'Ribbon', isActive:true},
    {_id:oid(12), productType:'Ribbon', isActive:false},
  ];
  const entries = ['007','009','012','017','028','030','029'].map((code,i) => ({
    _id:oid(100+i), catalog:catalog._id, category:categories[0]._id, code, isActive:false,
  }));
  entries.push({_id:oid(110), catalog:catalog._id, category:categories[1]._id, code:'007', isActive:false});
  entries.push({_id:oid(111), catalog:catalog._id, category:categories[2]._id, code:'007', isActive:false});
  entries.push({_id:oid(112), catalog:oid(2), category:categories[0]._id, code:'007', isActive:true});
  entries.push({_id:oid(113), catalog:catalog._id, category:categories[0]._id, code:'031', isActive:false});
  const product = (n, code, extra = {}) => ({_id:oid(200+n), productType:'Ribbon', category:categories[0]._id,
    catalogCode:code, isActive:true, isAvailable:true, moq:1, ...extra});
  const products = [
    product(0,'007', {size:'1 inch', grade:'A+', packingUnit:'100yd Roll'}),
    product(1,'007', {size:'3/4 inch', grade:'B', packingUnit:'35yd Roll'}),
    product(2,'009'), product(3,'012', {moq:5}), product(4,'017', {isAvailable:false}),
    product(5,'028', {isActive:false}), product(6,'030'), product(7,'029'),
    product(8,'007', {category:categories[1]._id}),
    product(9,'007', {category:categories[2]._id}),
  ];
  const stock = new Map(products.map((p,i) => [p._id, [0,10,5,4,100,100,2,0,0,100][i]]));
  const reserved = new Map([[products[1]._id,3], [products[2]._id,5], [products[6]._id,9]]);

  t.mock.method(User,'findById',role => ({select:async () => ({_id:role, isAdmin:role === 'admin', approvalStatus:role === 'pending' ? 'Pending' : 'Approved'})}));
  t.mock.method(Catalog,'findOne',filter => query(matches(catalog,filter) ? catalog : null));
  t.mock.method(CatalogEntry,'find',filter => query(entries.filter(row => matches(row,filter))));
  t.mock.method(Category,'find',filter => query(categories.filter(row => matches(row,filter))));
  t.mock.method(Product,'find',filter => query(products.filter(row => matches(row,filter))));
  t.mock.method(SlotItem,'aggregate',async pipeline => {
    const ids = new Set(pipeline[0].$match.product.$in.map(String));
    return [...stock].filter(([id,qty]) => ids.has(id) && qty > 0).map(([id,onHand]) => ({_id:id,onHand}));
  });
  t.mock.method(OrderAllocation,'aggregate',async pipeline => {
    const ids = new Set(pipeline[0].$match.product.$in.map(String));
    return [...reserved].filter(([id]) => ids.has(id)).map(([id,qty]) => ({_id:id,reserved:qty}));
  });

  const app = express();
  app.use(express.json(),cookieParser());
  app.post('/products/availability',protect,requireApproved,getProductsAvailability);
  app.use(catalogRoutes);
  app.use((err,_req,res,_next) => res.status(res.statusCode >= 400 ? res.statusCode : 500).json({message:err.message}));
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous;
  });
  const post = (path,body,role='admin') => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method:'POST', headers:{'Content-Type':'application/json', ...(role ? {Cookie:`jwt=${jwt.sign({userId:role},process.env.JWT_SECRET)}`} : {})},
    body:JSON.stringify(body),
  });
  const preview = `/preview/${catalog._id}/availability`;
  const customer = `/${catalog._id}/availability`;
  const request = {entryIds:entries.map(entry => entry._id)};

  assert.equal((await post(preview,request,null)).status,401);
  assert.equal((await post(preview,request,'customer')).status,404);
  assert.equal((await post(preview,request,'admin')).status,404);
  assert.equal((await post(customer,request,'pending')).status,403);
  assert.equal((await post(customer,request,'customer')).status,404);
  assert.equal((await post(customer,request,'admin')).status,404, 'Admin customer routes also honor publication');
  assert.equal((await post(customer+'?preview=true&isActive=false',request,'admin')).status,404);
  catalog.isActive = true;
  entries.forEach(entry => { entry.isActive = true; });
  for (const body of [{}, {entryIds:'bad'}, {entryIds:['bad']}, {entryIds:[{}]}, {entryIds:Array(50).fill(entries[0]._id)}]) {
    assert.equal((await post(customer,body)).status,400);
  }
  assert.equal((await post('/bad/availability',{entryIds:[]})).status,400);

  const response = await post(customer,request);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.match(response.headers.get('server-timing'),/^availability;dur=\d+\.\d$/);
  let body = await response.json();
  const byEntry = new Map(body.data.map(row => [row.entryId,row.inStock]));
  assert.equal(byEntry.get(entries[0]._id),true, 'Any stocked width/grade/packing can qualify');
  for (const entry of entries.slice(1,8)) assert.equal(byEntry.get(entry._id),false);
  assert.equal(byEntry.has(entries[8]._id),false, 'Inactive category is omitted');
  assert.equal(byEntry.has(entries[9]._id),false, 'Entry in another catalog is omitted');
  const byStockFlag = new Map(body.data.map(row => [row.entryId,row.noStock]));
  assert.equal(byStockFlag.get(entries[0]._id),false, 'A stocked variation prevents the no-stock flag');
  assert.equal(byStockFlag.get(entries[1]._id),true, 'Fully reserved stock has no available balance');
  assert.equal(byStockFlag.get(entries[2]._id),false, 'Stock below MOQ is not a zero balance');
  for (const entry of entries.slice(3,8)) assert.equal(byStockFlag.get(entry._id),true);
  assert.equal(byStockFlag.get(entries[10]._id),true, 'No matching requestable variation has no stock');
  assert.ok(body.data.every(row => Object.keys(row).sort().join(',') === 'entryId,inStock,noStock'), 'No stock totals or SKU payload in summaries');
  assert.equal(Product.find.mock.callCount(),1);
  assert.equal(SlotItem.aggregate.mock.callCount(),1);
  assert.equal(OrderAllocation.aggregate.mock.callCount(),1);

  // A product batch returns quantities from exactly the same fresh calculation.
  body = await (await post('/products/availability',{productIds:products.map(p => p._id)})).json();
  const byProduct = new Map(body.data.map(row => [row.productId,row]));
  assert.equal(byProduct.get(products[1]._id).availability.availableNow,7);
  assert.equal(byProduct.get(products[1]._id).inStock,true);
  assert.equal(byProduct.get(products[2]._id).availability.availableNow,0, 'Fully reserved stock is not sellable');
  assert.equal(byProduct.get(products[3]._id).inStock,false, 'Four units cannot meet MOQ five');
  assert.equal(byProduct.get(products[4]._id).inStock,false, 'Manually unavailable product');
  assert.equal(byProduct.get(products[5]._id).inStock,false, 'Inactive product');
  assert.equal(byProduct.get(products[6]._id).availability.availableNow,0, 'Reservations clamp available stock to zero');

  stock.set(products[1]._id,3);
  body = await (await post(customer,{entryIds:[entries[0]._id]})).json();
  assert.equal(body.data[0].inStock,false, 'A second read reflects changed reservations/stock without a server cache');
  assert.equal(body.data[0].noStock,true);

  catalog.isActive = true;
  entries.forEach(entry => { entry.isActive = true; });
  entries[0].isActive = false;
  body = await (await post(customer,request,'customer')).json();
  assert.equal(body.data.some(row => row.entryId === entries[0]._id),false);
  assert.equal(body.data.some(row => row.entryId === entries[7]._id),true);
  categories[1].productType = 'Double Face Tape';
  body = await (await post(customer,{entryIds:[entries[7]._id]},'customer')).json();
  assert.deepEqual(body.data,[],'Category must belong to the catalog product type');

  const productReads = Product.find.mock.callCount();
  const stockReads = SlotItem.aggregate.mock.callCount();
  body = await (await post(customer,{entryIds:[oid(999)]})).json();
  assert.deepEqual(body.data,[]);
  assert.equal(Product.find.mock.callCount(),productReads,'No product query for missing entries');
  assert.equal(SlotItem.aggregate.mock.callCount(),stockReads,'No inventory query for an empty batch');

  // Page-sized batches have a bounded query count, not a read per tile.
  const batch = Array.from({length:49},(_,i) => ({_id:oid(500+i), catalog:catalog._id,
    category:categories[0]._id, code:String(500+i), isActive:true}));
  entries.push(...batch);
  products.push(...batch.map((entry,i) => ({...product(600+i,entry.code), _id:oid(800+i)})));
  batch.forEach((_entry,i) => stock.set(oid(800+i),1));
  const before = [Product.find.mock.callCount(),SlotItem.aggregate.mock.callCount(),OrderAllocation.aggregate.mock.callCount()];
  body = await (await post(customer,{entryIds:batch.map(entry => entry._id)})).json();
  assert.equal(body.data.length,49);
  assert.ok(body.data.every(row => row.inStock && row.noStock === false));
  assert.equal(Product.find.mock.callCount() - before[0],1);
  assert.equal(SlotItem.aggregate.mock.callCount() - before[1],1, 'One batched stock read for 49 colors');
  assert.equal(OrderAllocation.aggregate.mock.callCount() - before[2],1, 'One batched reservation read for 49 colors');

  catalog.layout = 'future-layout';
  assert.equal((await post(customer,{entryIds:[entries[1]._id]})).status,422);
});
