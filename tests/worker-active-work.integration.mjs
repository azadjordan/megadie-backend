// Disposable local replica set only; never reads .env or starts the app server.
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import express from 'express';
import cookieParser from 'cookie-parser';
import User from '../models/userModel.js';
import Order from '../models/orderModel.js';
import Product from '../models/productModel.js';
import Slot from '../models/slotModel.js';
import SlotItem from '../models/slotItemModel.js';
import OrderAllocation from '../models/orderAllocationModel.js';
import WorkerWork from '../models/workerWorkModel.js';
import InventoryMovement from '../models/inventoryMovementModel.js';
import packingRoutes from '../routes/packingRoutes.js';
import { errorHandler } from '../middleware/errorMiddleware.js';
import { testSessionCookies } from './helpers/sessionCookie.mjs';
import { workWindow } from '../utils/workerWorkWindow.js';

const uri = process.env.WORKER_ACTIVE_TEST_URI;
test('combined worker work feed', { skip: !uri, timeout: 120000 }, async t => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/megadie_worker_active_test(?:\?|$)/);
  process.env.JWT_SECRET = 'isolated-worker-active-test'; process.env.NODE_ENV = 'test';
  await mongoose.connect(uri, { autoIndex: false }); await mongoose.connection.dropDatabase();
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  await OrderAllocation.createIndexes(); await WorkerWork.createIndexes(); await InventoryMovement.createCollection();
  const makeUser = (name, values = {}) => User.create({ name, email: name + '@test.invalid', phoneNumber: '123456789', password: 'test-password', approvalStatus: 'Approved', ...values });
  const worker = await makeUser('Packer', { isWorker: true }), other = await makeUser('Driver', { isWorker: true }), admin = await makeUser('Admin', { isAdmin: true }), customer = await makeUser('Client');
  const app = express(); app.use(express.json(), cookieParser()); app.use('/api/packing', packingRoutes); app.use(errorHandler);
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const cookies = testSessionCookies(), base = 'http://127.0.0.1:' + server.address().port + '/api/packing';
  async function api(path, actor = worker, method = 'GET', body) {
    const response = await fetch(base + path, { method, headers: { Origin: 'http://localhost:5173', Cookie: await cookies(actor), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const ok = response => { assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; };
  const feed = async (actor = worker, query = '') => ok(await api('/my-work' + query, actor));
  const all = response => Object.values(response.groups).flatMap(group => group.data);
  const one = async actor => all(await feed(actor))[0];
  let position = 1;
  async function fixture({ packing = true, driver = null, picked = 0, packed = false, destination = 'PRIVATE ADDRESS' } = {}) {
    const product = new mongoose.Types.ObjectId(); await Product.collection.insertOne({ _id: product, name: 'Red ribbon', sku: 'RIB-' + product, packingUnit: 'roll', cbm: 1 });
    const slot = await Slot.create({ store: 'AE1', unit: String.fromCharCode(65 + Math.floor((position - 1) / 16)), position: ((position++ - 1) % 16) + 1, cbm: 1000, occupiedCbm: 20 });
    await SlotItem.collection.insertOne({ product, slot: slot._id, qty: 20, cbm: 20 });
    const order = await Order.create({ user: customer._id, status: 'Shipping', orderItems: [{ product, sku: 'RIB-' + product, productName: 'Red ribbon', qty: 10, unitPrice: 12 }], totalPrice: 135, deliveryCharge: 10, extraFee: 5,
      allocationStatus: 'Allocated', ...(packing ? { packingWorker: worker._id, packingSentAt: new Date(), preparationMode: 'prepare_only' } : {}),
      ...(packed ? { packedAt: new Date(), packedBy: worker._id } : {}), deliveryWorker: driver?._id || null,
      deliveryDetails: { contactName: 'PRIVATE RECIPIENT', phoneNumber: '+971501234567', address: destination, notes: 'PRIVATE NOTE' } });
    const allocation = await OrderAllocation.create({ order: order._id, product, slot: slot._id, qty: 10, pickedQty: picked, by: admin._id });
    if (packed && packing) await WorkerWork.create({ order: order._id, type: 'packed', worker: worker._id, actor: worker._id, completedAt: order.packedAt, sourceKey: String(order._id) + ':packed:fixture', orderNumber: order.orderNumber, customerName: 'Client', label: 'Client — ' + order.orderNumber.split('-').at(-1), items: [{ sku: 'RIB-' + product, name: 'Red ribbon', qty: 10, unit: 'roll' }], active: true });
    return { order, product, slot, allocation };
  }
  t.beforeEach(async () => { await Order.deleteMany({}); await OrderAllocation.deleteMany({}); await SlotItem.deleteMany({}); await WorkerWork.deleteMany({}); });
  await t.test('same worker sees one order through packing, departure and receipt', async () => {
    const f = await fixture({ driver: worker });
    let card = await one(); assert.equal(card.nextAction, 'start_packing'); assert.equal(all(await feed()).length, 1);
    const action = async (name, body = {}) => ok(await api('/orders/' + f.order._id + '/' + name, worker, 'POST', { expectedRevision: (await one()).version, ...body }));
    await action('pick', { allocationId: String(f.allocation._id), pickedQty: 10 });
    card = await one(); assert.equal(card.nextAction, 'packed');
    await action('packed'); card = await one(); assert.equal(card.kind, 'delivery'); assert.equal(card.nextAction, 'departed');
    assert.equal(all(await feed()).length, 1);
    for (const action of ['departed', 'delivered']) {
      ok(await api('/deliveries/' + f.order._id + '/movement', worker, 'POST', { action, expectedRevision: (await one()).version, confirmedReady: true, confirmedReceived: true }));
      if (action === 'departed') assert.equal((await one()).nextAction, 'delivered');
    }
    assert.equal(all(await feed()).length, 0);
    const recent = ok(await api('/recent-work')); assert.equal(recent.counts.packed, 1); assert.equal(recent.counts.delivered, 1);
    assert.ok(!JSON.stringify(recent).includes('PRIVATE'));
  });
  await t.test('completed packing leaves active work immediately and retains a private receipt', async () => {
    const f = await fixture({ driver: other, picked: 10, packed: true });
    assert.equal(all(await feed()).length, 0);
    for (const path of ['/orders/', '/deliveries/']) {
      const receipt = ok(await api(path + f.order._id)).data; assert.equal(receipt.scope, 'recent-work');
      assert.equal(receipt.canPack, false); assert.equal(receipt.delivery, null); assert.ok(!JSON.stringify(receipt).includes('PRIVATE'));
    }
    assert.ok(ok(await api('/recent-work')).data.some(card => card.orderId === String(f.order._id) && card.work.some(work => work.type === 'packed')));
    assert.equal(ok(await api('/orders')).pagination.total, 0);
    assert.equal(Object.values(ok(await api('/orders?view=board')).groups).reduce((sum, group) => sum + group.pagination.total, 0), 0);
    assert.ok(ok(await api('/orders?view=board', admin)).groups.ready_handoff.data.some(card => card.orderId === String(f.order._id)));
    const d = await one(other); assert.equal(d.nextAction, 'departed'); assert.equal(d.delivery.address, 'PRIVATE ADDRESS');
    ok(await api('/deliveries/' + f.order._id + '/movement', other, 'POST', { action: 'departed', expectedRevision: d.version, confirmedReady: true }));
    assert.equal(all(await feed()).length, 0); assert.equal((await one(other)).nextAction, 'delivered');
  });
  await t.test('completed unassigned packing is absent while driver-only preparation reuses existing readiness', async () => {
    await fixture({ picked: 10, packed: true }); assert.equal(all(await feed()).length, 0);
    const f = await fixture({ packing: false, driver: other });
    const card = await one(other); assert.equal(card.orderId, String(f.order._id)); assert.equal(card.nextAction, 'departed');
    assert.equal(card.canDepart, ok(await api('/deliveries/' + f.order._id, other)).data.canDepart);
  });
  await t.test('waiting preparation and missing destination do not offer departure', async () => {
    const f = await fixture({ driver: other }); assert.equal((await one(other)).message, 'Waiting for packing.');
    await Order.updateOne({ _id: f.order._id }, { $set: { packedAt: new Date(), 'deliveryDetails.address': '' } });
    await OrderAllocation.updateOne({ _id: f.allocation._id }, { $set: { pickedQty: 10 } });
    const card = await one(other); assert.equal(card.group, 'waiting'); assert.equal(card.canDepart, false); assert.match(card.message, /location is missing/);
  });
  await t.test('saved packing and delivery links use the existing three-day receipt and name limits', async () => {
    const f = await fixture({ picked: 10, packed: true, driver: other });
    const before = await Order.findById(f.order._id).lean();
    for (const period of ['today', 'yesterday', 'dayBeforeYesterday']) {
      const completedAt = new Date(+workWindow(period).start + 1);
      await WorkerWork.updateOne({ order: f.order._id, type: 'packed' }, { $set: { completedAt } });
      for (const path of ['/orders/', '/deliveries/']) {
        const receipt = ok(await api(path + f.order._id)).data;
        assert.equal(receipt.scope, 'recent-work'); assert.equal(receipt.delivery, null); assert.equal(receipt.canPack, false);
        assert.equal(Boolean(receipt.customerName), period === 'today'); assert.equal(Boolean(receipt.label), period === 'today');
        assert.ok(receipt.items.every(item => !item.allocations.length && !item.alternatives.length));
        assert.ok(!JSON.stringify(receipt).includes('PRIVATE'));
      }
    }
    await WorkerWork.updateOne({ order: f.order._id, type: 'packed' }, { $set: { completedAt: new Date(Date.now() - 9 * 86400000) } });
    for (const path of ['/orders/', '/deliveries/']) assert.equal((await api(path + f.order._id)).status, 403);
    assert.equal(all(await feed()).length, 0); assert.equal((await one(other)).nextAction, 'departed');
    assert.equal(ok(await api('/deliveries/' + f.order._id, other)).data.delivery.address, 'PRIVATE ADDRESS');
    assert.deepEqual(await Order.findById(f.order._id).lean(), before);
  });
  await t.test('later delivery assignment restores only the assigned delivery responsibility', async () => {
    const f = await fixture({ picked: 10, packed: true });
    const receipt = await WorkerWork.findOne({ order: f.order._id, type: 'packed' }).lean();
    assert.equal(all(await feed()).length, 0);
    ok(await api('/deliveries/' + f.order._id + '/assignment', admin, 'POST', { workerId: String(worker._id), expectedRevision: 0 }));
    assert.equal((await one()).nextAction, 'departed');
    assert.equal(ok(await api('/orders/' + f.order._id)).data.scope, 'packed-handoff');
    ok(await api('/deliveries/' + f.order._id + '/assignment', admin, 'POST', { workerId: String(other._id), expectedRevision: 1 }));
    assert.equal(all(await feed()).length, 0); assert.equal((await one(other)).nextAction, 'departed');
    assert.equal(ok(await api('/deliveries/' + f.order._id)).data.scope, 'recent-work');
    assert.deepEqual(await WorkerWork.findOne({ _id: receipt._id }).lean(), receipt);
    assert.equal(String((await Order.findById(f.order._id)).packingWorker), String(worker._id));
  });
  await t.test('reopening packing restores the task and completing it again retains correct credit', async () => {
    const f = await fixture({ picked: 10, packed: true });
    ok(await api('/orders/' + f.order._id + '/reopen', admin, 'POST', { expectedRevision: 0 }));
    const active = ok(await api('/orders/' + f.order._id)).data;
    assert.equal(active.scope, undefined); assert.ok(active.items[0].allocations.length); assert.equal((await one()).nextAction, 'packed');
    assert.equal(await WorkerWork.countDocuments({ order: f.order._id, type: 'packed', active: true }), 0);
    const finished = ok(await api('/orders/' + f.order._id + '/packed', worker, 'POST', { expectedRevision: active.version })).data;
    assert.equal(finished.scope, 'recent-work'); assert.equal(all(await feed()).length, 0);
    assert.equal(await WorkerWork.countDocuments({ order: f.order._id, type: 'packed', active: true }), 1);
    assert.equal(await WorkerWork.countDocuments({ order: f.order._id, type: 'packed', active: false }), 1);
  });
  await t.test('a delivery reassignment during a saved-link read returns only the former packer receipt', async () => {
    const f = await fixture({ picked: 10, packed: true, driver: worker });
    const original = Order.findById; let reads = 0;
    Order.findById = function (...args) {
      const query = original.apply(this, args);
      if (String(args[0]) === String(f.order._id) && ++reads === 2) {
        const exec = query.exec;
        query.exec = async function (...args) {
          await Order.updateOne({ _id: f.order._id }, { $set: { deliveryWorker: other._id }, $inc: { reservationRevision: 1 } });
          return exec.apply(this, args);
        };
      }
      return query;
    };
    try {
      const receipt = ok(await api('/deliveries/' + f.order._id)).data;
      assert.equal(receipt.scope, 'recent-work'); assert.equal(receipt.delivery, null); assert.ok(!JSON.stringify(receipt).includes('PRIVATE'));
    } finally { Order.findById = original; }
    assert.equal(all(await feed()).length, 0); assert.equal((await one(other)).nextAction, 'departed');
  });
  await t.test('help does not block other usable locations, and alternatives remain actionable', async () => {
    const f = await fixture({ picked: 6 });
    await OrderAllocation.updateOne({ _id: f.allocation._id }, { $set: { pickProblem: true } });
    await Order.updateOne({ _id: f.order._id }, { $set: { packingHelp: [{ product: f.product, sku: 'RIB', requestedAt: new Date(), requestedBy: worker._id, requestedByName: worker.name, reason: 'worker_requested' }] } });
    assert.equal((await one()).group, 'waiting');
    const slot = await Slot.create({ store: 'AE1', unit: 'N', position: 16, cbm: 1000 });
    await SlotItem.collection.insertOne({ product: f.product, slot: slot._id, qty: 8 });
    let card = await one(); assert.equal(card.group, 'todo'); assert.equal(card.nextAction, 'continue_packing'); assert.equal(card.needsHelp, true);
    await SlotItem.updateOne({ product: f.product, slot: slot._id }, { $set: { qty: 4 } });
    await Order.updateOne({ _id: f.order._id }, { $set: { 'orderItems.0.qty': 14 } });
    await OrderAllocation.create({ order: f.order._id, product: f.product, slot: slot._id, qty: 4, by: admin._id });
    card = await one(); assert.equal(card.group, 'todo'); assert.equal(card.summary.remainingUnits, 8);
  });
  await t.test('all collected is insufficient when the existing task checks reject packing', async () => {
    const f = await fixture({ picked: 10 });
    await Slot.updateOne({ _id: f.slot._id }, { $set: { store: 'OTHER' } });
    assert.equal((await one()).group, 'waiting'); assert.equal((await one()).nextAction, null);
  });
  await t.test('reassignment, legacy fallback, explicit unassignment and cancellation keep scope correct', async () => {
    const f = await fixture({ packing: false, driver: worker }); assert.equal(all(await feed()).length, 1);
    await Order.updateOne({ _id: f.order._id }, { $set: { deliveryWorker: other._id } }); assert.equal(all(await feed()).length, 0);
    await Order.updateOne({ _id: f.order._id }, { $unset: { deliveryWorker: 1 }, $set: { packingWorker: worker._id, packingSentAt: new Date(), preparationMode: 'prepare_deliver', packedAt: new Date() } });
    await OrderAllocation.updateOne({ _id: f.allocation._id }, { $set: { pickedQty: 10 } });
    assert.equal((await one()).kind, 'delivery');
    await Order.updateOne({ _id: f.order._id }, { $set: { deliveryWorker: null } }); assert.equal(all(await feed()).length, 0);
    await Order.updateOne({ _id: f.order._id }, { $set: { status: 'Cancelled' } }); assert.equal(all(await feed()).length, 0);
    assert.equal((await api('/my-work', customer)).status, 403); assert.equal((await api('/my-work?workerId=' + other._id)).status, 400);
  });
  await t.test('counts and pagination cover unique assignments, clamp after changes and read without writes', async () => {
    for (let i = 0; i < 14; i++) await fixture({ driver: worker });
    for (let i = 0; i < 13; i++) await fixture({ packing: false, driver: worker });
    for (let i = 0; i < 3; i++) await fixture({ picked: 10, packed: true });
    await Order.updateMany({ packingWorker: { $exists: false } }, { $set: { 'deliveryDetails.address': '' } });
    const before = JSON.stringify(await Order.find().sort({ _id: 1 }).lean());
    const first = await feed(), second = await feed(worker, '?todoPage=2&waitingPage=2');
    assert.equal(first.groups.todo.pagination.total, 14); assert.equal(first.groups.waiting.pagination.total, 13);
    assert.equal(first.groups.todo.data.length, 12); assert.equal(second.groups.todo.data.length, 2); assert.equal(second.groups.waiting.data.length, 1);
    assert.equal(new Set([...all(first), ...all(second)].map(card => card.orderId)).size, 27);
    assert.equal((await feed(worker, '?todoPage=99999')).groups.todo.pagination.page, 2);
    assert.equal(JSON.stringify(await Order.find().sort({ _id: 1 }).lean()), before);
    assert.ok(!JSON.stringify(first).includes('unitPrice')); assert.equal((await api('/my-work?todoPage=-1')).status, 400);
  });
});
