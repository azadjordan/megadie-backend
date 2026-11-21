// Explicit disposable localhost replica set only. Does not load .env/server.js.
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
import Quote from '../models/quoteModel.js';
import Invoice from '../models/invoiceModel.js';
import Payment from '../models/paymentModel.js';
import packingRoutes from '../routes/packingRoutes.js';
import orderRoutes from '../routes/orderRoutes.js';
import { errorHandler } from '../middleware/errorMiddleware.js';
import { testSessionCookies } from './helpers/sessionCookie.mjs';
import { listWorkerWork, getWorkerWorkOrder, preserveWorkerWork } from '../utils/workerWork.js';
import { workWindow } from '../utils/workerWorkWindow.js';

const uri = process.env.WORKER_WORK_TEST_URI;
test('private work history, durable credit, expiry and corrections', { skip: !uri, timeout: 120000 }, async t => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/megadie_worker_work_test(?:\?|$)/);
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'isolated-work-test';
  await mongoose.connect(uri, { autoIndex: false }); await mongoose.connection.dropDatabase();
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  await Promise.all([WorkerWork.createIndexes(), OrderAllocation.createIndexes(), Quote.createCollection(), Invoice.createCollection(), Payment.createCollection()]);
  const makeUser = (name, fields = {}) => User.create({ name, email: name + '@test.invalid', phoneNumber: name, password: 'test-password', approvalStatus: 'Approved', ...fields });
  const admin = await makeUser('Owner', { isAdmin: true });
  const packer = await makeUser('Packer', { isWorker: true }), driver = await makeUser('Driver', { isWorker: true }), outsider = await makeUser('Other', { isWorker: true });
  const customer = await makeUser('Grand', { address: 'PRIVATE ADDRESS', deliveryPhoneNumber: '+971509999999', deliveryGoogleMapsUrl: 'https://maps.google.com/?q=private' });
  const app = express(); app.use(express.json(), cookieParser()); app.use('/api/packing', packingRoutes); app.use('/api/orders', orderRoutes); app.use(errorHandler);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const cookie = testSessionCookies(), base = `http://127.0.0.1:${server.address().port}/api`;
  async function api(path, actor = admin, method = 'GET', body) {
    const response = await fetch(base + path, { method, headers: { Cookie: await cookie(actor), Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.data; };
  const task = async (f, actor = admin) => ok(await api(`/packing/deliveries/${f.order._id}`, actor));
  const packing = async (f, actor = admin) => ok(await api(`/packing/orders/${f.order._id}`, actor));
  const move = async (f, action, actor = driver, extra = {}, revision) => api(`/packing/deliveries/${f.order._id}/movement`, actor, 'POST', {
    action, expectedRevision: revision ?? (await task(f, actor)).version, confirmedReady: true, confirmedReceived: true, confirmedReturn: true, ...extra,
  });
  const history = async (actor = driver, params = 'period=today') => { const response = await api(`/packing/recent-work?${params}`, actor); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; };
  let position = 1;
  async function fixture({ packActor = packer, packWorker = packer } = {}) {
    const p = new mongoose.Types.ObjectId();
    await Product.collection.insertOne({ _id: p, name: 'Ribbon', sku: `RIB-${p}`, packingUnit: '100yd Roll', cbm: 1 });
    const slot = await Slot.create({ store: 'AE1', unit: 'A', position: position++, cbm: 1000, occupiedCbm: 100 });
    await SlotItem.collection.insertOne({ product: p, slot: slot._id, qty: 100, cbm: 100 });
    const order = await Order.create({ user: customer._id, status: 'Shipping', orderItems: [{ product: p, sku: `RIB-${p}`, productName: 'Ribbon at completion', qty: 10, unitPrice: 12 }], totalPrice: 120, allocationStatus: 'Allocated' });
    const allocation = await OrderAllocation.create({ order: order._id, product: p, slot: slot._id, qty: 10, by: admin._id });
    const f = { order, p, allocation, slot };
    const before = await packing(f);
    ok(await api(`/packing/orders/${order._id}/send`, admin, 'POST', { workerId: String(packWorker._id), preparationMode: 'prepare_only', deliveryDetails: { contactName: 'PRIVATE RECIPIENT', address: 'PRIVATE ADDRESS', phoneNumber: '+971509999999', googleMapsUrl: 'https://maps.google.com/?q=private', notes: 'PRIVATE NOTE' }, expectedRevision: before.version, expectedDeliveryRevision: before.deliveryRevision }));
    let view = await packing(f, packWorker);
    ok(await api(`/packing/orders/${order._id}/pick`, packWorker, 'POST', { expectedRevision: view.version, allocationId: String(allocation._id), pickedQty: 10 }));
    view = await packing(f, packWorker);
    ok(await api(`/packing/orders/${order._id}/packed`, packActor, 'POST', { expectedRevision: view.version }));
    ok(await api(`/packing/deliveries/${order._id}/assignment`, admin, 'POST', { workerId: String(driver._id), expectedRevision: (await task(f)).version }));
    return f;
  }
  const assertPrivate = data => {
    const json = JSON.stringify(data);
    for (const forbidden of ['PRIVATE ADDRESS', 'PRIVATE RECIPIENT', '+971509999999', '?q=private', 'PRIVATE NOTE', 'unitPrice', 'lineTotal', 'invoice', 'payments', 'slotId', 'availableQty', 'customerId']) assert.ok(!json.includes(forbidden), forbidden + ' leaked');
  };

  await t.test('admin completion credits responsible packer and driver; receipt returns a sanitized success', async () => {
    const f = await fixture({ packActor: admin });
    const packingReceipt = await WorkerWork.findOne({ order: f.order._id, type: 'packed' }).lean();
    assert.equal(String(packingReceipt.worker), String(packer._id)); assert.equal(String(packingReceipt.actor), String(admin._id));
    const oldPackingPage = await packing(f, packer);
    assertPrivate(oldPackingPage);
    assert.deepEqual(oldPackingPage.problems, []); assert.equal(oldPackingPage.canPack, false);
    assert.equal(oldPackingPage.items.reduce((sum, item) => sum + item.pickedQty, 0), 10);
    assert.equal(oldPackingPage.summary.totalUnits, 10);
    assert.equal((await task(f, packer)).delivery, null);
    assert.equal((await task(f, driver)).delivery.address, 'PRIVATE ADDRESS');
    const moneyBefore = await Order.findById(f.order._id).lean(), stockBefore = await SlotItem.findById((await SlotItem.findOne({ product: f.p }))._id).lean();
    ok(await move(f, 'departed'));
    const revision = (await task(f, driver)).version;
    const receipt = ok(await move(f, 'delivered', driver, {}, revision));
    assert.equal(receipt.scope, 'recent-work'); assert.equal(receipt.deliveryState, 'delivered'); assertPrivate(receipt);
    assertPrivate(await task(f, driver)); assertPrivate(await packing(f, packer));
    assert.equal((await api(`/packing/deliveries/${f.order._id}`, outsider)).status, 403);
    assert.equal((await api(`/packing/orders/${f.order._id}`, outsider)).status, 403);
    assert.equal((await history()).counts.delivered, 1); assert.equal((await history(packer)).counts.packed, 1);
    assert.equal((await history(packer)).counts.delivered, 0); assert.equal((await history(outsider)).pagination.total, 0);
    assert.equal((await move(f, 'delivered', driver, {}, revision)).status, 409);
    assert.equal(await WorkerWork.countDocuments({ order: f.order._id, type: 'delivered', active: true }), 1);
    const after = await Order.findById(f.order._id).lean();
    assert.equal(after.totalPrice, moneyBefore.totalPrice); assert.deepEqual(after.orderItems, moneyBefore.orderItems);
    assert.equal((await SlotItem.findOne({ product: f.p })).qty, stockBefore.qty);
    const stored = await WorkerWork.findOne({ order: f.order._id, type: 'delivered' }).lean(); assertPrivate(stored);
  });

  await t.test('admin receipt preserves driver credit; correction removes credit and repeat completion counts once', async () => {
    const f = await fixture(); ok(await move(f, 'departed')); ok(await move(f, 'delivered', admin));
    let record = await WorkerWork.findOne({ order: f.order._id, type: 'delivered', active: true }).lean();
    assert.equal(String(record.worker), String(driver._id)); assert.equal(String(record.actor), String(admin._id));
    const oldTime = record.completedAt;
    ok(await move(f, 'corrected', admin, { confirmedCorrection: true, note: 'Receipt recorded by mistake' }));
    assert.equal(await WorkerWork.countDocuments({ order: f.order._id, type: 'delivered', active: true }), 0);
    const corrected = (await history()).data.find(card => card.orderId === String(f.order._id));
    assert.equal(corrected.work[0].active, false); assert.equal(corrected.work[0].voidReason, 'delivery_corrected');
    ok(await move(f, 'delivered'));
    assert.equal(await WorkerWork.countDocuments({ order: f.order._id, type: 'delivered', active: true }), 1);
    record = await WorkerWork.findOne({ order: f.order._id, type: 'delivered', active: false }).lean(); assert.deepEqual(record.completedAt, oldTime);
  });

  await t.test('reassignment never transfers packing credit; reopening excludes the former completion', async () => {
    const f = await fixture(); let v = await packing(f);
    ok(await api(`/packing/orders/${f.order._id}/send`, admin, 'POST', { workerId: String(outsider._id), preparationMode: 'prepare_only', deliveryDetails: {}, expectedRevision: v.version, expectedDeliveryRevision: v.deliveryRevision }));
    assert.equal((await packing(f, packer)).scope, 'recent-work');
    assert.ok(!(await history(outsider)).data.some(card => card.orderId === String(f.order._id)));
    assert.equal(String((await WorkerWork.findOne({ order: f.order._id, type: 'packed' })).worker), String(packer._id));
    v = await packing(f); ok(await api(`/packing/orders/${f.order._id}/reopen`, admin, 'POST', { expectedRevision: v.version }));
    assert.equal(await WorkerWork.countDocuments({ order: f.order._id, type: 'packed', active: true }), 0);
  });

  await t.test('returns and reshelving revoke packed credit, without creating a delivery', async () => {
    const f = await fixture(); ok(await move(f, 'departed')); ok(await move(f, 'returned'));
    ok(await move(f, 'reshelved', admin));
    assert.equal(await WorkerWork.countDocuments({ order: f.order._id, active: true }), 0);
    assert.equal(await WorkerWork.countDocuments({ order: f.order._id, type: 'delivered' }), 0);
  });

  await t.test('worker cannot broaden the period, identity, fields or financial access', async () => {
    for (const query of [`workerId=${packer._id}`, 'from=2020-01-01&to=2030-01-01', 'period=all', 'period=last7', 'period=last3', 'period=month', 'include=delivery', 'period[today]=1', 'page=-1']) assert.equal((await api(`/packing/recent-work?${query}`, driver)).status, 400, query);
    assertPrivate(await history(driver));
    const report = await history(admin, `workerId=${driver._id}&period=last7`); assert.ok(report.counts.delivered >= 2);
    assert.equal((await api('/packing/recent-work', admin)).status, 400);
    assert.equal((await api('/packing/recent-work?period=today', customer)).status, 403);
  });

  await t.test('three-day boundary is enforced on lists and both saved task links; active jobs remain accessible', async () => {
    const f = await fixture(); ok(await move(f, 'departed')); ok(await move(f, 'delivered'));
    const now = new Date('2026-11-20T19:59:59.999Z'); const earliest = workWindow('last3', now).start;
    await WorkerWork.updateMany({ order: f.order._id }, { $set: { completedAt: earliest } });
    assert.ok((await listWorkerWork(driver, { period: 'dayBeforeYesterday' }, now)).data.some(card => card.orderId === String(f.order._id)));
    assert.equal((await getWorkerWorkOrder(String(f.order._id), driver, {}, now)).scope, 'recent-work');
    await assert.rejects(getWorkerWorkOrder(String(f.order._id), driver, {}, new Date(+now + 1)), e => e.statusCode === 403);
    assert.ok(!(await listWorkerWork(driver, { period: 'dayBeforeYesterday' }, new Date(+now + 1))).data.some(card => card.orderId === String(f.order._id)));
    await WorkerWork.updateMany({ order: f.order._id }, { $set: { completedAt: new Date(Date.now() - 9 * 86400000) } });
    assert.equal((await api(`/packing/deliveries/${f.order._id}`, driver)).status, 403);
    assert.equal((await api(`/packing/orders/${f.order._id}`, packer)).status, 403);
    const active = await fixture(); await Order.updateOne({ _id: active.order._id }, { $set: { packingSentAt: new Date(Date.now() - 20 * 86400000) } });
    assert.equal((await packing(active, packer)).scope, 'recent-work'); assert.ok((await task(active, driver)).delivery);
  });

  await t.test('snapshots survive edits and order deletion; worker role revocation blocks existing sessions', async () => {
    const f = await fixture(); ok(await move(f, 'departed')); ok(await move(f, 'delivered'));
    await Order.updateOne({ _id: f.order._id }, { $set: { 'orderItems.0.productName': 'Later changed product', 'orderItems.0.qty': 1 } });
    let card = (await history()).data.find(card => card.orderId === String(f.order._id));
    assert.equal(card.items[0].name, 'Ribbon at completion'); assert.equal(card.items[0].qty, 10); assert.equal(card.items[0].unit, '100yd Roll');
    const before = await packing(f);
    ok(await api(`/orders/${f.order._id}`, admin, 'DELETE', { expectedRevision: before.version, confirmedPhysicalReturn: true }));
    assert.equal(await Order.findById(f.order._id), null);
    card = (await history()).data.find(card => card.orderId === String(f.order._id)); assert.equal(card.items[0].qty, 10);
    const saved = ok(await api(`/packing/deliveries/${f.order._id}`, driver)); assertPrivate(saved); assert.ok(saved.version > before.version); assert.equal(saved.status, 'Completed'); assert.deepEqual(saved.problems, []);
    await User.updateOne({ _id: driver._id }, { $set: { isWorker: false } });
    try {
      assert.ok([401, 403].includes((await api('/packing/recent-work', driver)).status));
      assert.ok([401, 403].includes((await api(`/packing/deliveries/${f.order._id}`, driver)).status));
    } finally { await User.updateOne({ _id: driver._id }, { $set: { isWorker: true } }); }
  });

  await t.test('verified legacy delivery is supported, ambiguous packing is not guessed', async () => {
    const f = await fixture(); await WorkerWork.deleteMany({ order: f.order._id });
    const now = new Date();
    await Order.updateOne({ _id: f.order._id }, { $set: { status: 'Delivered', deliveredAt: now, packedBy: admin._id, packingActivity: [{ action: 'PACKED', actor: admin._id, at: now }], deliveryHistory: [{ action: 'delivered', method: 'company', worker: driver._id, actor: admin._id, at: now }] } });
    const card = (await history()).data.find(card => card.orderId === String(f.order._id)); assert.ok(card); assert.equal(card.work[0].type, 'delivered');
    assert.ok(!(await history(packer)).data.some(card => card.orderId === String(f.order._id)));
    assertPrivate(card);
    const session = await mongoose.startSession();
    await session.withTransaction(async () => { const order = await Order.findById(f.order._id).select('+packingActivity +deliveryHistory +reservationRevision').session(session); await preserveWorkerWork(order, session); await order.deleteOne({ session }); }); await session.endSession();
    assert.ok((await history()).data.some(card => card.orderId === String(f.order._id)));
  });

  await t.test('receipt-write failure rolls back delivery, quote deletion and credit together', async () => {
    const f = await fixture(); ok(await move(f, 'departed'));
    const quote = new mongoose.Types.ObjectId(); await Quote.collection.insertOne({ _id: quote, number: 'Test quote' }); await Order.updateOne({ _id: f.order._id }, { $set: { quote } });
    const original = WorkerWork.updateOne;
    WorkerWork.updateOne = () => { throw new Error('Simulated work receipt write failure'); };
    try { assert.equal((await move(f, 'delivered')).status, 500); }
    finally { WorkerWork.updateOne = original; }
    const order = await Order.findById(f.order._id);
    assert.equal(order.status, 'Shipping'); assert.equal(String(order.quote), String(quote)); assert.ok(await Quote.findById(quote));
    assert.equal(await WorkerWork.countDocuments({ order: f.order._id, type: 'delivered' }), 0);
  });

  await t.test('concurrent receipt confirmations commit only one credit', async () => {
    const f = await fixture(); ok(await move(f, 'departed')); const version = (await task(f, driver)).version;
    const results = await Promise.all([move(f, 'delivered', driver, {}, version), move(f, 'delivered', admin, {}, version)]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal(await WorkerWork.countDocuments({ order: f.order._id, type: 'delivered', active: true }), 1);
  });

  await t.test('courier deliveries and customer collections do not count as internal worker deliveries', async () => {
    for (const method of ['courier', 'collection']) {
      const f = await fixture();
      const revision = (await task(f)).version;
      assert.equal((await move(f, method === 'courier' ? 'departed' : 'collected', admin, { method, handler: 'External courier' })).status, 409);
      ok(await api(`/packing/deliveries/${f.order._id}/assignment`, admin, 'POST', { workerId: null, expectedRevision: revision }));
      if (method === 'courier') {
        ok(await move(f, 'departed', admin, { method, handler: 'External courier' }));
        assert.equal((await api(`/packing/deliveries/${f.order._id}`, driver)).status, 403);
        assert.equal((await api(`/packing/deliveries/${f.order._id}/movement`, driver, 'POST', { action: 'delivered', expectedRevision: (await task(f)).version, confirmedReceived: true })).status, 403);
        assert.equal((await Order.findById(f.order._id)).status, 'Shipping');
        ok(await move(f, 'delivered', admin));
      }
      else ok(await move(f, 'collected', admin, { method }));
      assert.equal((await Order.findById(f.order._id)).status, 'Delivered');
      assert.equal(await WorkerWork.countDocuments({ order: f.order._id, type: 'delivered' }), 0);
      assert.equal((await api(`/packing/deliveries/${f.order._id}`, driver)).status, 403);
    }
  });

  await t.test('counts cover every page; admins retain old reports while workers cannot extend retention', async () => {
    const now = new Date(Date.now() - 1000);
    for (let n = 0; n < 14; n++) await WorkerWork.create({ order: new mongoose.Types.ObjectId(), type: 'delivered', worker: outsider._id, actor: admin._id, completedAt: now, sourceKey: `pagination-${n}`, orderNumber: `TEST-${n}`, customerName: 'Test client', label: `Test client — ${n}`, items: [{ sku: 'TEST', name: 'Test product', qty: 1, unit: 'piece' }] });
    const page1 = await history(outsider), page2 = await history(outsider, 'page=2');
    assert.equal(page1.counts.delivered, 14); assert.equal(page1.data.length, 12); assert.equal(page2.data.length, 2); assert.equal(page2.counts.delivered, 14);
    assert.ok(page1.pagination.hasNext); assert.equal(page2.pagination.hasNext, false);
    await WorkerWork.updateMany({ worker: outsider._id }, { $set: { completedAt: new Date('2020-02-20T08:00:00Z') } });
    assert.equal((await history(outsider)).counts.delivered, 0);
    const report = await history(admin, `workerId=${outsider._id}&from=2020-02-20&to=2020-02-20`);
    assert.equal(report.counts.delivered, 14);
    assert.equal((await api(`/packing/recent-work?workerId=${outsider._id}&from=2020-02-31&to=2020-03-03`, admin)).status, 400);
  });
  await t.test('monthly totals include older orders without exposing names, IDs or detailed access beyond three days', async () => {
    const now = new Date('2026-11-20T12:00:00+04:00');
    const ids = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    for (const [i, completedAt] of ['2026-11-10T08:00:00Z', '2026-11-19T08:00:00Z'].entries()) {
      await WorkerWork.create({ order: ids[i], type: 'delivered', worker: outsider._id, actor: admin._id, completedAt, sourceKey: 'month-private-' + i, orderNumber: 'ORD-TEST-PRIVATE' + i, customerName: 'PRIVATE CLIENT', label: 'PRIVATE CLIENT — PRIVATE' + i, items: [{ sku: 'TEST', name: 'Test product', qty: 1, unit: 'piece' }] });
    }
    const today = await listWorkerWork(outsider, { period: 'today' }, now);
    assert.deepEqual(today.monthly, { month: '2026-11', delivered: 2 });
    assert.equal(today.counts.delivered, 0); assert.equal(today.data.length, 0);
    assert.ok(!JSON.stringify(today).includes('PRIVATE CLIENT')); assert.ok(!JSON.stringify(today.monthly).includes(String(ids[0])));
    const yesterday = await listWorkerWork(outsider, { period: 'yesterday' }, now);
    assert.equal(yesterday.monthly.delivered, 2); assert.equal(yesterday.data.length, 1);
    assert.equal(yesterday.data[0].customerName, undefined); assert.equal(yesterday.data[0].label, undefined); assert.equal(yesterday.data[0].cartonReference, 'PRIVATE1');
    await assert.rejects(getWorkerWorkOrder(String(ids[0]), outsider, {}, now), error => error.statusCode === 403);
    const saved = await getWorkerWorkOrder(String(ids[1]), outsider, {}, now);
    assert.equal(saved.customerName, undefined); assert.equal(saved.label, undefined);
    const adminReport = await listWorkerWork(admin, { workerId: String(outsider._id), from: '2026-11-19', to: '2026-11-19' }, now);
    assert.equal(adminReport.data[0].customerName, 'PRIVATE CLIENT');
  });
  await t.test('a later correction cannot resurrect an old delivery through legacy fallback', async () => {
    const f = await fixture(); ok(await move(f, 'departed')); ok(await move(f, 'delivered'));
    await WorkerWork.deleteMany({ order: f.order._id });
    await Order.updateOne({ _id: f.order._id }, { $push: { deliveryHistory: { action: 'corrected', actor: admin._id, at: new Date() } } });
    assert.ok(!(await history()).data.some(card => card.orderId === String(f.order._id)));
  });

});
