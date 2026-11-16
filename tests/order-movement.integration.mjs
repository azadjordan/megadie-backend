// Explicit disposable local replica set only. Never imports server.js or loads .env.
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import express from "express";
import cookieParser from "cookie-parser";
import User from "../models/userModel.js";
import Order from "../models/orderModel.js";
import Product from "../models/productModel.js";
import Slot from "../models/slotModel.js";
import SlotItem from "../models/slotItemModel.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import InventoryMovement from "../models/inventoryMovementModel.js";
import packingRoutes from "../routes/packingRoutes.js";
import orderRoutes from "../routes/orderRoutes.js";
import userRoutes from "../routes/userRoutes.js";
import productRoutes from "../routes/productRoutes.js";
import slotItemRoutes from "../routes/slotItemRoutes.js";
import slotRoutes from "../routes/slotRoutes.js";
import { errorHandler } from "../middleware/errorMiddleware.js";
import { testSessionCookies } from "./helpers/sessionCookie.mjs";

const uri = process.env.MOVEMENT_TEST_URI;
test("delivery movement with a disposable local replica set", { skip: !uri, timeout: 120000 }, async t => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/megadie_movement_test(?:\?|$)/);
  process.env.JWT_SECRET = "local-packing-tests-only";
  process.env.NODE_ENV = "production";
  await mongoose.connect(uri, { autoIndex: false });
  await mongoose.connection.dropDatabase();
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  await OrderAllocation.createIndexes();
  await InventoryMovement.createCollection();
  const makeUser = (name, values = {}) => User.create({ name, email: `${name}@test.invalid`, phoneNumber: name, password: "test-password", approvalStatus: "Approved", ...values });
  const admin = await makeUser("Admin", { isAdmin: true });
  const worker = await makeUser("Worker", { isWorker: true });
  const other = await makeUser("Other", { isWorker: true });
  const customer = await makeUser("Client");
  const app = express(); app.use(express.json(), cookieParser());
  app.use("/api/packing", packingRoutes); app.use("/api/orders", orderRoutes); app.use("/api/users", userRoutes);
  app.use("/api/products", productRoutes); app.use("/api/slot-items", slotItemRoutes); app.use("/api/slots", slotRoutes); app.use(errorHandler);
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const cookieFor = testSessionCookies();
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function api(path, { actor = admin, method = "GET", body, cookie } = {}) {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Origin: "http://localhost:5173", Cookie: cookie || await cookieFor(actor) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const view = async (f, actor = admin) => (await api(`/packing/orders/${f.order._id}`, { actor })).body.data;
  async function send(f, actor = worker) {
    const v = await view(f);
    return api(`/packing/orders/${f.order._id}/send`, { method: "POST", body: { workerId: String(actor._id), preparationMode: "prepare_only", deliveryDetails: {}, expectedRevision: v.version, expectedDeliveryRevision: v.deliveryRevision } });
  }
  async function action(f, name, body = {}, actor = worker) {
    const v = await view(f, actor);
    assert.ok(v, "Task must be readable before the test action");
    return api(`/packing/orders/${f.order._id}/${name}`, { actor, method: "POST", body: { expectedRevision: v.version, ...body } });
  }
  async function fixture({ targetQty = 10 } = {}) {
    const productId = new mongoose.Types.ObjectId();
    await Product.collection.insertOne({ _id: productId, name: "Ribbon", sku: `RIB-${productId}`, packingUnit: "100yd Roll", cbm: 1 });
    const slots = await Slot.create([1, 2, 3].map((position, index) => ({ store: "AE1", unit: ["A", "B", "C"][index], position, cbm: 1000, occupiedCbm: 100 })));
    await SlotItem.collection.insertMany(slots.map((slot, index) => ({ product: productId, slot: slot._id, qty: index ? targetQty : 20, cbm: index ? targetQty : 20 })));
    const order = await Order.create({ user: customer._id, status: "Shipping", orderItems: [{ product: productId, sku: `RIB-${productId}`, qty: 10, unitPrice: 12 }], allocationStatus: "Allocated", totalPrice: 120 });
    const allocation = await OrderAllocation.create({ order: order._id, product: productId, slot: slots[0]._id, qty: 10, by: admin._id });
    return { order, productId, slots, allocation, allocationId: String(allocation._id) };
  }
  const expectOK = result => assert.equal(result.status, 200, JSON.stringify(result.body));

  const movement = async f => (await api(`/orders/${f.order._id}/movement`)).body.data;
  async function move(f, body = {}, version) {
    return api(`/orders/${f.order._id}/movement`, { method: 'POST', body: { expectedRevision: version ?? (await movement(f)).version, action: 'departed', method: 'courier', handler: 'Courier A', confirmedReady: true, confirmedReceived: true, confirmedReturn: true, ...body } });
  }
  await t.test('courier pickup holds stock and stays unfinished; receipt independently completes delivery', async () => {
    const f = await fixture(), before = await SlotItem.find({ product: f.productId }).lean();
    expectOK(await move(f));
    let v = await movement(f);
    assert.equal(v.status, 'Shipping'); assert.equal(v.isOut, true); assert.equal(v.history.length, 1);
    assert.equal((await OrderAllocation.findById(f.allocationId)).pickedQty, 10);
    assert.deepEqual((await SlotItem.find({ product: f.productId }).lean()).map(r => r.qty), before.map(r => r.qty));
    assert.equal((await api(`/orders/${f.order._id}/allocations/finalize`, { method: 'POST' })).status, 409);
    expectOK(await move(f, { action: 'delivered', method: undefined, handler: undefined }));
    v = await movement(f); assert.equal(v.status, 'Delivered'); assert.ok(v.deliveredAt); assert.equal(v.deliveredBy, 'Courier A');
    assert.deepEqual(v.history.map(e => e.action), ['departed', 'delivered']);
    assert.equal((await api(`/orders/${f.order._id}/allocations/finalize`, { method: 'POST' })).status, 409, 'Invoice remains required');
    const client = await api(`/orders/${f.order._id}`, { actor: customer }); expectOK(client);
    assert.equal(client.body.data.deliveryMovement, undefined); assert.equal(client.body.data.deliveryHistory, undefined);
    assert.equal((await api(`/orders/${f.order._id}/movement`, { actor: worker })).status, 403);
    assert.equal((await api(`/orders/${f.order._id}/movement`, { actor: customer })).status, 403);
  });
  await t.test('company delivery, customer collection and direct receipt are truthful without invoice or invented departure', async () => {
    const company = await fixture(); expectOK(await move(company, { method: 'company', handler: 'Owner' }));
    assert.equal((await movement(company)).movement.handler, 'Owner');
    const collected = await fixture(); expectOK(await move(collected, { action: 'collected', method: 'collection', handler: '' }));
    const c = await movement(collected); assert.equal(c.status, 'Delivered'); assert.equal(c.movement.departedAt, undefined); assert.equal(c.history[0].action, 'collected');
    const direct = await fixture(); expectOK(await move(direct, { action: 'delivered', method: 'company', handler: 'Azad' }));
    const d = await movement(direct); assert.equal(d.movement.departedAt, undefined); assert.deepEqual(d.history.map(e => e.action), ['delivered']);
  });
  await t.test('a generic handover needs no method or name and direct receipt needs no departure', async () => {
    const f = await fixture(); expectOK(await move(f, { method: undefined, handler: undefined }));
    assert.equal((await movement(f)).movement.method, undefined);
    assert.equal((await movement(f)).movement.handler, '');
    expectOK(await move(f, { action: 'returned' }));
    expectOK(await move(f, { action: 'reshelved' }));
    const direct = await fixture(); expectOK(await move(direct, { action: 'delivered', method: undefined, handler: undefined }));
    assert.equal((await movement(direct)).status, 'Delivered');
    assert.equal((await movement(direct)).movement.departedAt, undefined);
  });
  await t.test('physical confirmations and exact reservations are checked before any write', async () => {
    const f = await fixture(), v = await movement(f);
    for (const body of [{ confirmedReady: false }, { method: 'collection' }, { method: 'unknown' }, { handler: 'x'.repeat(121) }, { action: 'delivered', confirmedReceived: false }, { expectedRevision: undefined }]) {
      assert.equal((await move(f, body)).status >= 400, true);
      assert.equal((await movement(f)).version, v.version);
      assert.equal((await movement(f)).history.length, 0);
    }
    await OrderAllocation.updateOne({ _id: f.allocationId }, { $set: { qty: 7 } });
    assert.equal((await move(f)).status, 409); assert.equal((await OrderAllocation.findById(f.allocationId)).pickedQty, 0);
  });
  await t.test('dispatch guards manual stock, assignment, cancellation, deletion and shelf counts', async () => {
    const f = await fixture(); expectOK(await move(f));
    const requests = [
      [`/orders/${f.order._id}/allocations/${f.allocationId}`, 'DELETE', undefined],
      [`/orders/${f.order._id}/allocations`, 'POST', { productId: String(f.productId), slotId: String(f.slots[0]._id), qty: 7 }],
      [`/orders/${f.order._id}/allocations/reserve-all`, 'POST', {}],
      [`/orders/${f.order._id}/cancel`, 'POST', { confirmedPhysicalReturn: true }],
      [`/orders/${f.order._id}`, 'DELETE', { expectedRevision: (await movement(f)).version, confirmedPhysicalReturn: true }],
      [`/orders/${f.order._id}`, 'PUT', { deliveredBy: 'Bypass' }],
      [`/orders/${f.order._id}/delivery-details`, 'PUT', { expectedRevision: 0, deliveryDetails: {}, assignedTo: 'Bypass' }],
    ];
    for (const [path, method, body] of requests) assert.equal((await api(path, { method, body })).status, 409, path);
    assert.equal((await api(`/orders/${f.order._id}/delete-preview`)).body.data.allowed, false);
    assert.ok((await api(`/orders/${f.order._id}/items-editor`)).body.data.lockReason);
    assert.equal((await api(`/orders/${f.order._id}/fulfillment-sheet`)).status, 409);
    assert.equal((await api('/slot-items/correct-count', { method: 'POST', body: { productId: String(f.productId), slotId: String(f.slots[0]._id), actualQty: 20 } })).status, 409);
    assert.equal((await send(f)).status, 409);
    assert.equal((await OrderAllocation.findById(f.allocationId)).qty, 10);
  });
  await t.test('active delivery details stay editable after packing, departure and return without changing custody or defaults', async () => {
    const f = await fixture(), otherOrder = await fixture();
    const defaults = await User.findById(customer._id).select('address deliveryGoogleMapsUrl deliveryContactName deliveryPhoneNumber').lean();
    const v = await view(f);
    expectOK(await api(`/packing/orders/${f.order._id}/send`, { method: 'POST', body: { workerId: String(worker._id), preparationMode: 'prepare_deliver', deliveryDetails: { address: 'Original order address' }, expectedRevision: v.version, expectedDeliveryRevision: v.deliveryRevision } }));
    expectOK(await action(f, 'pick', { allocationId: f.allocationId, pickedQty: 10 })); expectOK(await action(f, 'packed'));
    const rows = await OrderAllocation.find({ order: f.order._id }).lean();
    const stock = await SlotItem.find({ product: f.productId }).lean();
    for (const stage of ['packed', 'out', 'returned']) {
      if (stage === 'out') expectOK(await move(f));
      if (stage === 'returned') expectOK(await move(f, { action: 'returned' }));
      const before = await Order.findById(f.order._id).select('+deliveryHistory').lean();
      const details = { contactName: 'New receiver', phoneNumber: '+971501234567', secondaryPhoneNumber: '041234567', address: 'Order address - ' + stage, googleMapsUrl: 'https://maps.app.goo.gl/updated', notes: 'Updated receiving instructions' };
      const path = `/orders/${f.order._id}/delivery-details`;
      const body = { expectedRevision: before.deliveryRevision, deliveryDetails: details };
      expectOK(await api(path, { method: 'PUT', body }));
      const after = await Order.findById(f.order._id).select('+deliveryHistory').lean();
      assert.deepEqual(after.deliveryDetails, details);
      for (const key of ['status', 'packingWorker', 'packingSentAt', 'packedAt', 'packedBy', 'preparationMode', 'assignedTo', 'invoice', 'stockFinalizedAt', 'deliveryMovement', 'deliveryHistory']) assert.deepEqual(after[key], before[key], key);
      assert.equal(after.deliveryRevision, before.deliveryRevision + 1);
      assert.deepEqual(await OrderAllocation.find({ order: f.order._id }).lean(), rows);
      assert.deepEqual(await SlotItem.find({ product: f.productId }).lean(), stock);
      assert.deepEqual(await User.findById(customer._id).select('address deliveryGoogleMapsUrl deliveryContactName deliveryPhoneNumber').lean(), defaults);
      assert.equal((await Order.findById(otherOrder.order._id)).deliveryDetails, undefined);
      assert.equal((await view(f, worker)).delivery.address, details.address);
      assert.equal((await view(f, worker)).delivery.phoneNumber, details.phoneNumber);
      const stale = await api(path, { method: 'PUT', body }); assert.equal(stale.status, 409); assert.match(stale.body.message, /changed/i);
      assert.equal((await api(path, { method: 'PUT', body: { ...body, expectedRevision: after.deliveryRevision, assignedTo: 'Bypass' } })).status, 409);
      for (const actor of [worker, customer]) assert.equal((await api(path, { actor, method: 'PUT', body: { ...body, expectedRevision: after.deliveryRevision } })).status, 403);
    }
    expectOK(await move(f, { action: 'delivered' }));
    const delivered = await Order.findById(f.order._id);
    const result = await api(`/orders/${f.order._id}/delivery-details`, { method: 'PUT', body: { expectedRevision: delivered.deliveryRevision, deliveryDetails: { address: 'Must not change' } } });
    assert.equal(result.status, 409); assert.match(result.body.message, /delivered.*read-only/i);
  });
  await t.test('return to store retains packed goods; a second attempt preserves both attempts', async () => {
    const f = await fixture(); expectOK(await move(f));
    const firstDeparture = (await movement(f)).movement.departedAt;
    expectOK(await move(f, { action: 'returned', note: 'Client unavailable' }));
    let v = await movement(f); assert.equal(v.isOut, false); assert.equal(v.holdsGoods, true); assert.equal(v.status, 'Shipping');
    assert.equal((await OrderAllocation.findById(f.allocationId)).pickedQty, 10);
    assert.equal((await api(`/orders/${f.order._id}/cancel`, { method: 'POST', body: { confirmedPhysicalReturn: true } })).status, 409);
    expectOK(await move(f, { method: 'company', handler: 'Owner' }));
    v = await movement(f); assert.deepEqual(v.history.map(e => e.action), ['departed', 'returned', 'departed']);
    assert.equal(v.history[0].at, firstDeparture); assert.equal(v.movement.handler, 'Owner'); assert.equal(v.movement.returnedAt, undefined);
  });
  await t.test('reshelving is explicit, clears picked ledger and reopens packing without releasing reservations', async () => {
    const f = await fixture(); expectOK(await move(f));
    assert.equal((await move(f, { action: 'reshelved' })).status, 409);
    expectOK(await move(f, { action: 'returned' }));
    assert.equal((await move(f, { action: 'reshelved', confirmedReturn: false })).status, 400);
    expectOK(await move(f, { action: 'reshelved' }));
    const v = await movement(f), allocation = await OrderAllocation.findById(f.allocationId);
    assert.equal(v.holdsGoods, false); assert.equal(allocation.qty, 10); assert.equal(allocation.pickedQty, 0);
    assert.equal((await Order.findById(f.order._id)).allocationStatus, 'Allocated');
    expectOK(await api(`/orders/${f.order._id}/cancel`, { method: 'POST' }));
    assert.equal((await Order.findById(f.order._id)).status, 'Cancelled');
  });
  await t.test('returned goods can be deleted only with current physical return confirmation', async () => {
    const f = await fixture(); expectOK(await move(f)); expectOK(await move(f, { action: 'returned' }));
    const p = (await api(`/orders/${f.order._id}/delete-preview`)).body.data;
    assert.equal(p.allowed, true); assert.equal(p.stock.requiresPhysicalReturn, true);
    assert.equal((await api(`/orders/${f.order._id}`, { method: 'DELETE', body: { expectedRevision: p.version } })).status, 409);
    expectOK(await api(`/orders/${f.order._id}`, { method: 'DELETE', body: { expectedRevision: (await movement(f)).version, confirmedPhysicalReturn: true } }));
    assert.equal(await OrderAllocation.countDocuments({ order: f.order._id }), 0);
  });
  await t.test('live packing cannot depart early, reopen or reassign after departure; return retains packing', async () => {
    const f = await fixture(); expectOK(await send(f));
    assert.equal((await move(f)).status, 409);
    expectOK(await action(f, 'pick', { allocationId: f.allocationId, pickedQty: 10 })); expectOK(await action(f, 'packed'));
    expectOK(await move(f));
    const board = (await api('/packing/orders?view=board', { actor: worker })).body.groups;
    assert.ok(board.in_delivery.data.some(o => o.orderId === String(f.order._id)));
    assert.ok(!board.ready_handoff.data.some(o => o.orderId === String(f.order._id)));
    assert.equal((await view(f, worker)).deliveryState, 'courier');
    assert.equal((await action(f, 'reopen', {}, admin)).status, 409);
    assert.equal((await send(f, other)).status, 409);
    expectOK(await move(f, { action: 'returned' })); assert.ok((await Order.findById(f.order._id)).packedAt);
    assert.ok((await api('/packing/orders?view=board', { actor: worker })).body.groups.ready_handoff.data.some(o => o.orderId === String(f.order._id)));
    expectOK(await move(f, { action: 'collected', method: 'collection' })); assert.equal((await movement(f)).status, 'Delivered');
  });
  await t.test('concurrent departures commit once and stale updates cannot overwrite movement', async () => {
    const f = await fixture(), revision = (await movement(f)).version;
    const results = await Promise.all([move(f, { handler: 'First' }, revision), move(f, { handler: 'Second' }, revision)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal((await movement(f)).history.length, 1);
    assert.equal((await move(f, { action: 'delivered' }, revision)).status, 409);
  });
  await t.test('dispatch racing reservation release never sends released stock', async () => {
    const f = await fixture();
    const results = await Promise.all([move(f), api(`/orders/${f.order._id}/allocations/${f.allocationId}`, { method: 'DELETE' })]);
    assert.equal(results.filter(r => r.status === 200).length, 1);
    const order = await Order.findById(f.order._id), allocation = await OrderAllocation.findById(f.allocationId);
    if (order.deliveryMovement?.departedAt) { assert.ok(allocation); assert.equal(allocation.pickedQty, 10); }
    else assert.equal(allocation, null);
  });
  await t.test('original delivery endpoint shares guards and records a real receipt', async () => {
    const f = await fixture();
    expectOK(await api(`/orders/${f.order._id}/deliver`, { method: 'PUT', body: { deliveredBy: 'Azad' } }));
    assert.equal((await movement(f)).history[0].action, 'delivered');
    assert.equal((await OrderAllocation.findById(f.allocationId)).pickedQty, 10);
  });
});
