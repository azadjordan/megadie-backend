// Explicit disposable local replica set only. Never imports server.js or loads .env.
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import User from "../models/userModel.js";
import AdminSession from "../models/adminSessionModel.js";
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

const uri = process.env.PACKING_TEST_URI;
test("worker packing with a disposable local replica set", { skip: !uri, timeout: 120000 }, async t => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/megadie_packing_test(?:\?|$)/);
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

  const recipient = { contactName: 'Order recipient', phoneNumber: '+971 50 123 4567', secondaryPhoneNumber: '04 123 4567', address: 'Order destination', googleMapsUrl: '', notes: 'Ring at reception' };
  async function assign(f, overrides = {}) {
    const v = await view(f);
    return api(`/packing/orders/${f.order._id}/send`, { method: 'POST', body: { workerId: String(worker._id), preparationMode: 'prepare_deliver', deliveryDetails: {}, expectedRevision: v.version, expectedDeliveryRevision: v.deliveryRevision, ...overrides } });
  }

  async function unassign(f, overrides = {}, actor = admin) {
    const v = await view(f);
    return api(`/packing/orders/${f.order._id}/unassign`, { actor, method: 'POST', body: { expectedRevision: v.version, expectedDeliveryRevision: v.deliveryRevision, confirmedPhysicalReturn: true, ...overrides } });
  }

  await t.test('withdrawal preserves reservations, delivery, reports and history while revoking worker access', async () => {
    const f = await fixture();
    expectOK(await assign(f, { deliveryDetails: recipient }));
    expectOK(await action(f, 'problem', { allocationId: f.allocationId, pickedQty: 0, note: 'Physical stock needs checking.' }));
    expectOK(await action(f, 'help', { allocationId: f.allocationId }));
    const before = await view(f), allocation = (await OrderAllocation.findById(f.allocationId)).toObject();
    const stock = await SlotItem.find({ product: f.productId }).sort({ _id: 1 }).lean();
    const movements = await InventoryMovement.countDocuments({ order: f.order._id });
    assert.equal(before.helpRequestedItems, 1);
    assert.equal((await api(`/orders/${f.order._id}/fulfillment-sheet`)).status, 409);
    assert.equal(before.unassignLockReason, '');
    const result = await unassign(f); expectOK(result);
    const after = result.body.data;
    assert.equal(after.sentAt, null); assert.equal(after.worker, null);
    assert.equal(after.version, before.version + 1);
    assert.equal(after.deliveryRevision, before.deliveryRevision + 1);
    assert.deepEqual(after.deliveryDetails, before.deliveryDetails);
    assert.deepEqual(after.reports, before.reports);
    assert.equal(after.stockChecksPending, 1);
    assert.equal(after.helpRequestedItems, 0);
    assert.equal(after.activity.at(-1).action, 'ASSIGNMENT_REMOVED');
    assert.equal(after.activity.length, before.activity.length + 1);
    const saved = await Order.findById(f.order._id).select('+packingHelp');
    assert.equal(saved.status, 'Shipping'); assert.equal(saved.allocationStatus, 'Allocated');
    assert.equal(saved.assignedTo, ''); assert.equal(saved.packingWorker, undefined);
    assert.ok(saved.packingHelp.every(request => request.resolvedAt));
    assert.deepEqual((await OrderAllocation.findById(f.allocationId)).toObject(), allocation);
    assert.deepEqual(await SlotItem.find({ product: f.productId }).sort({ _id: 1 }).lean(), stock);
    assert.equal(await InventoryMovement.countDocuments({ order: f.order._id }), movements);
    assert.equal((await api(`/orders/${f.order._id}/fulfillment-sheet`)).status, 200);
    assert.equal((await api(`/packing/orders/${f.order._id}`, { actor: worker })).status, 403);
    assert.equal((await api(`/packing/orders/${f.order._id}/pick`, { actor: worker, method: 'POST', body: { expectedRevision: before.version, allocationId: f.allocationId, pickedQty: 1 } })).status, 403);
    assert.ok(!(await api('/packing/orders?view=board', { actor: worker })).body.groups.to_pack.data.some(row => row.orderId === String(f.order._id)));
    assert.equal((await unassign(f)).status, 409);
    // Publishing again must retain the original stock reports and audit trail.
    expectOK(await send(f));
    assert.equal((await view(f)).stockChecksPending, 1);
    assert.ok((await view(f)).activity.some(event => event.action === 'ASSIGNMENT_REMOVED'));
  });

  await t.test('withdrawal requires admin authority, a real confirmation and zero picked quantities', async () => {
    const f = await fixture(); expectOK(await send(f));
    assert.equal((await unassign(f, {}, worker)).status, 403);
    assert.equal((await unassign(f, {}, customer)).status, 403);
    assert.equal((await unassign(f, { confirmedPhysicalReturn: false })).status, 400);
    assert.equal((await unassign(f, { expectedRevision: undefined })).status, 400);
    const stale = await view(f);
    expectOK(await action(f, 'pick', { allocationId: f.allocationId, pickedQty: 4 }));
    assert.equal((await unassign(f, { expectedRevision: stale.version })).status, 409);
    const picked = await view(f);
    assert.match(picked.unassignLockReason, /correct.*zero/);
    assert.equal((await unassign(f)).status, 409);
    assert.equal((await view(f)).version, picked.version);
    assert.equal((await OrderAllocation.findById(f.allocationId)).pickedQty, 4);
    expectOK(await action(f, 'correct', { allocationId: f.allocationId, pickedQty: 0, confirmedReturn: true }, admin));
    expectOK(await unassign(f));
    assert.equal((await OrderAllocation.findById(f.allocationId)).qty, 10);
  });

  await t.test('withdrawal preserves completed-work and invoice safeguards', async () => {
    for (const fields of [{ packedAt: new Date() }, { status: 'Delivered' }, { stockFinalizedAt: new Date() }, { invoice: new mongoose.Types.ObjectId() }]) {
      const f = await fixture(); expectOK(await send(f));
      await Order.updateOne({ _id: f.order._id }, { $set: fields });
      const before = await view(f);
      assert.ok(before.unassignLockReason);
      assert.equal((await unassign(f)).status, 409);
      assert.equal((await view(f)).version, before.version);
      assert.ok((await view(f)).sentAt);
    }
    const f = await fixture(); expectOK(await send(f));
    const { default: Invoice } = await import('../models/invoiceModel.js');
    await Invoice.collection.insertOne({ order: f.order._id, status: 'Issued' });
    assert.equal((await unassign(f)).status, 409, 'An invoice cannot be bypassed by clearing its order reference');
    const g = await fixture(); expectOK(await send(g));
    assert.equal((await unassign(g, { expectedDeliveryRevision: 0 })).status, 409);
  });

  await t.test('a concurrent pick and withdrawal cannot both commit', async () => {
    const f = await fixture(); expectOK(await send(f));
    const before = await view(f);
    const [pick, removal] = await Promise.all([
      api(`/packing/orders/${f.order._id}/pick`, { actor: worker, method: 'POST', body: { expectedRevision: before.version, allocationId: f.allocationId, pickedQty: 1 } }),
      unassign(f, { expectedRevision: before.version, expectedDeliveryRevision: before.deliveryRevision }),
    ]);
    assert.equal([pick, removal].filter(result => result.status === 200).length, 1, JSON.stringify([pick, removal]));
    const after = await view(f), allocation = await OrderAllocation.findById(f.allocationId);
    if (removal.status === 200) { assert.equal(after.sentAt, null); assert.equal(allocation.pickedQty, 0); }
    else { assert.ok(after.sentAt); assert.equal(allocation.pickedQty, 1); }
  });

  await t.test('assignment preserves saved contacts when an older form sends location fields only', async () => {
    const f = await fixture();
    await Order.updateOne({ _id: f.order._id }, { $set: { deliveryDetails: recipient } });
    expectOK(await assign(f, { deliveryDetails: { address: 'Updated destination', googleMapsUrl: '', notes: 'Updated notes' } }));
    const own = await view(f, worker);
    assert.deepEqual(own.delivery, { ...recipient, address: 'Updated destination', notes: 'Updated notes' });
    for (const secret of ['email', 'unitPrice', 'totalPrice', 'customerLocation', 'deliveryDetails', 'activity', 'reports']) assert.equal(Object.hasOwn(own, secret), false, secret);
    assert.equal((await api(`/packing/orders/${f.order._id}`, { actor: other })).status, 403);
    assert.equal((await api(`/packing/orders/${f.order._id}`, { actor: customer })).status, 403);
    assert.equal((await api('/packing/orders?view=board', { actor: worker })).body.groups.to_pack.data.some(row => Object.hasOwn(row, 'delivery')), false);
  });

  await t.test('pack-only saves hide contacts from workers and preserve them through reassignment and mode changes', async () => {
    const f = await fixture();
    expectOK(await assign(f, { deliveryDetails: recipient }));
    expectOK(await action(f, 'pick', { allocationId: f.allocationId, pickedQty: 3 }));
    expectOK(await assign(f, { preparationMode: 'prepare_only', workerId: String(other._id), deliveryDetails: {} }));
    assert.equal((await view(f, other)).delivery, null);
    assert.equal(JSON.stringify(await view(f, other)).includes(recipient.phoneNumber), false);
    assert.deepEqual((await view(f)).deliveryDetails, recipient);
    expectOK(await assign(f, { workerId: String(other._id) }));
    assert.deepEqual((await view(f, other)).delivery, recipient);
    assert.equal((await OrderAllocation.findById(f.allocationId)).pickedQty, 3);
    assert.equal((await api(`/packing/orders/${f.order._id}`, { actor: worker })).status, 403);
  });

  await t.test('explicit contact edits and clearing apply to the order while customer defaults keep their contacts', async () => {
    const f = await fixture();
    await User.updateOne({ _id: customer._id }, { $set: { deliveryContactName: 'Profile recipient', deliveryPhoneNumber: '+971 50 999 0000', secondaryPhoneNumber: '04 999 0000', address: 'Profile destination', deliveryGoogleMapsUrl: '' } });
    expectOK(await assign(f));
    const first = await view(f, worker);
    assert.equal(first.delivery.contactName, 'Profile recipient');
    assert.equal(first.delivery.phoneNumber, '+971 50 999 0000');
    assert.equal(first.delivery.secondaryPhoneNumber, '04 999 0000');
    expectOK(await assign(f, { deliveryDetails: { contactName: 'Different recipient', phoneNumber: '+971 50 222 0000', secondaryPhoneNumber: '', address: 'New location' }, saveCustomerLocation: true, expectedCustomerLocation: { address: 'Profile destination', googleMapsUrl: '' } }));
    const updated = await view(f, worker);
    assert.equal(updated.delivery.contactName, 'Different recipient');
    assert.equal(updated.delivery.secondaryPhoneNumber, '');
    const profile = await User.findById(customer._id);
    assert.equal(profile.address, 'New location');
    assert.equal(profile.deliveryContactName, 'Profile recipient');
    assert.equal(profile.deliveryPhoneNumber, '+971 50 999 0000');
    assert.equal(profile.secondaryPhoneNumber, '04 999 0000');
  });

  await t.test('legacy delivery tasks use profile defaults only when there is no saved order snapshot', async () => {
    const f = await fixture();
    await Order.updateOne({ _id: f.order._id }, { $set: { packingWorker: worker._id, packingSentAt: new Date(), preparationMode: 'prepare_deliver' }, $unset: { deliveryDetails: '' } });
    assert.equal((await view(f, worker)).delivery.contactName, 'Profile recipient');
    assert.equal((await api(`/packing/orders/${f.order._id}`, { actor: other })).status, 403);
    await Order.updateOne({ _id: f.order._id }, { $set: { deliveryDetails: { ...recipient, contactName: '', phoneNumber: '', secondaryPhoneNumber: '' } } });
    const saved = await view(f, worker);
    assert.equal(saved.delivery.contactName, '');
    assert.equal(saved.delivery.phoneNumber, '');
  });

  await t.test('invalid and stale instruction saves leave contacts and revisions unchanged', async () => {
    const f = await fixture();
    expectOK(await assign(f, { deliveryDetails: recipient }));
    const before = await view(f);
    assert.equal((await assign(f, { deliveryDetails: { phoneNumber: 123 } })).status, 400);
    assert.equal((await assign(f, { expectedDeliveryRevision: before.deliveryRevision - 1, deliveryDetails: { phoneNumber: '' } })).status, 409);
    assert.equal((await assign(f, { deliveryDetails: { address: '', googleMapsUrl: '' } })).status, 400);
    const after = await view(f);
    assert.deepEqual(after.deliveryDetails, before.deliveryDetails);
    assert.equal(after.version, before.version);
    assert.equal(after.deliveryRevision, before.deliveryRevision);
    // Invalid legacy instructions remain editable and produce an actionable
    // validation response rather than an unknown-save server error.
    await Order.collection.updateOne({ _id: f.order._id }, { $set: { 'deliveryDetails.googleMapsUrl': 'http://invalid-map.test' } });
    assert.equal((await assign(f)).status, 400);
    assert.equal((await view(f)).version, before.version);
    expectOK(await assign(f, { deliveryDetails: { googleMapsUrl: '' } }));
  });

  await t.test("work queues count all assigned orders, paginate independently and derive partial progress", async () => {
    const queueWorker = await makeUser("QueueWorker", { isWorker: true });
    const product = new mongoose.Types.ObjectId();
    const slot = new mongoose.Types.ObjectId();
    const orders = Array.from({ length: 19 }, (_, index) => ({
      _id: new mongoose.Types.ObjectId(), user: customer._id, orderNumber: `BOARD-${index}`,
      status: index === 18 ? "Delivered" : "Shipping",
      packingWorker: index === 16 ? other._id : queueWorker._id,
      ...(index === 17 ? {} : { packingSentAt: new Date(2026, 0, index + 1) }),
      ...(index >= 13 && index <= 15 ? { packedAt: new Date(), preparationMode: index === 15 ? "prepare_only" : "prepare_deliver" } : {}),
      orderItems: [{ product, sku: "BOARD-SKU", qty: 10, unitPrice: 12 }],
    }));
    await Order.collection.insertMany(orders);
    await OrderAllocation.collection.insertMany(orders.map((order, index) => ({
      order: order._id, product, slot, qty: 10, pickedQty: index >= 13 && index <= 15 ? 10 : 6,
      pickProblem: index === 0, status: "Reserved",
    })));
    const first = await api("/packing/orders?view=board", { actor: queueWorker });
    expectOK(first);
    const groups = first.body.groups;
    assert.equal(groups.to_pack.pagination.total, 13);
    assert.equal(groups.to_pack.data.length, 12);
    assert.equal(groups.to_pack.pagination.hasNext, true);
    assert.equal(groups.ready_delivery.pagination.total, 2);
    assert.equal(groups.ready_handoff.pagination.total, 1);
    assert.deepEqual(groups.to_pack.data[0].summary, { totalItems: 1, collectedItems: 0, inProgressItems: 1, needsHelp: true });
    assert.equal(groups.to_pack.data[0].label, "Client — 0");
    assert.doesNotMatch(JSON.stringify(groups), /unitPrice|email|password/);
    const second = await api("/packing/orders?view=board&to_packPage=2&ready_deliveryPage=99", { actor: queueWorker });
    expectOK(second);
    assert.equal(second.body.groups.to_pack.data.length, 1);
    assert.equal(second.body.groups.to_pack.pagination.total, 13);
    assert.equal(second.body.groups.to_pack.pagination.page, 2);
    assert.equal(second.body.groups.ready_delivery.pagination.page, 1);
    assert.equal(second.body.groups.ready_delivery.data.length, 2);
    assert.equal(second.body.groups.to_pack.data[0].orderId, String(orders[12]._id));
    // Moving one order into a ready queue leaves no phantom last page behind.
    await Order.updateOne({ _id: orders[12]._id }, { $set: { packedAt: new Date(), preparationMode: "prepare_only" } });
    const moved = await api("/packing/orders?view=board&to_packPage=2", { actor: queueWorker });
    assert.equal(moved.body.groups.to_pack.pagination.page, 1);
    assert.equal(moved.body.groups.to_pack.pagination.total, 12);
    assert.equal(moved.body.groups.ready_handoff.pagination.total, 2);
  });

  await t.test("worker accounts use staff sessions and cannot access customer prices or admin APIs", async () => {
    const cookie = await cookieFor(worker);
    const decoded = jwt.verify(cookie.slice(4), process.env.JWT_SECRET);
    assert.equal(decoded.exp - decoded.iat, 28800);
    assert.ok(decoded.sessionId);
    assert.ok(await AdminSession.findById(decoded.sessionId));
    const profile = await api("/users/account/profile", { actor: worker });
    assert.equal(profile.body.data.isWorker, true);
    expectOK(await api("/users/session/activity", { actor: worker, method: "POST", body: { sessionId: decoded.sessionId } }));
    for (const path of ["/products", "/orders", "/packing/workers"]) assert.equal((await api(path, { actor: worker })).status, 403, path);
    await api("/users/account/profile", { actor: customer, method: "PUT", body: { isWorker: true, isAdmin: true } });
    const unchanged = await User.findById(customer._id);
    assert.equal(unchanged.isWorker, false); assert.equal(unchanged.isAdmin, false);
  });
  await t.test("only fully reserved eligible orders publish; assignments and reads are scoped", async () => {
    const f = await fixture();
    await OrderAllocation.updateOne({ _id: f.allocation._id }, { $set: { qty: 6 } });
    assert.equal((await send(f)).status, 409);
    assert.equal((await Order.findById(f.order._id)).packingSentAt, undefined);
    await OrderAllocation.updateOne({ _id: f.allocation._id }, { $set: { qty: 10 } });
    expectOK(await send(f));
    const own = await view(f, worker);
    assert.equal(own.items[0].unit, "100yd Roll");
    for (const secret of ["unitPrice", "totalPrice", "email", "packingActivity", "reports", "adminToAdminNote"]) assert.equal(JSON.stringify(own).includes(`"${secret}"`), false, secret);
    assert.equal((await api(`/packing/orders/${f.order._id}`, { actor: other })).status, 403);
    assert.equal((await api(`/packing/orders/${f.order._id}/send`, { actor: worker, method: "POST", body: {} })).status, 403);
    const list = await api("/packing/orders", { actor: other });
    assert.equal(list.body.data.some(row => row.orderId === String(f.order._id)), false);
  });
  await t.test("partial picking and a location replacement preserve physical progress without deducting stock", async () => {
    const f = await fixture(); expectOK(await send(f));
    expectOK(await action(f, "problem", { allocationId: f.allocationId, pickedQty: 6, note: "Only six here" }));
    expectOK(await action(f, "replace", { allocationId: f.allocationId, slotId: String(f.slots[1]._id), qty: 4 }));
    const rows = await OrderAllocation.find({ order: f.order._id }).sort({ qty: -1 }).lean();
    assert.deepEqual(rows.map(row => [row.qty, row.pickedQty]), [[6, 6], [4, 0]]);
    assert.equal((await SlotItem.findOne({ product: f.productId, slot: f.slots[0]._id })).qty, 20);
    const saved = await Order.findById(f.order._id).select("+packingReports +packingActivity");
    assert.equal(saved.packingReports.length, 1); assert.equal(saved.packingReports[0].shortQty, 4);
    assert.equal(saved.packingSummary.needsHelp, false);
    assert.equal(await InventoryMovement.countDocuments({ order: f.order._id }), 2);
  });
  await t.test("unavailable replacement rolls back and retains earlier picked data and reports", async () => {
    const f = await fixture({ targetQty: 3 }); expectOK(await send(f));
    expectOK(await action(f, "problem", { allocationId: f.allocationId, pickedQty: 6 }));
    const before = await OrderAllocation.findById(f.allocation._id).lean();
    assert.equal((await action(f, "replace", { allocationId: f.allocationId, slotId: String(f.slots[1]._id), qty: 4 })).status, 409);
    assert.deepEqual(await OrderAllocation.findById(f.allocation._id).lean(), before);
    assert.equal(await InventoryMovement.countDocuments({ order: f.order._id }), 0);
    assert.equal((await view(f, worker)).summary.needsHelp, true);
  });
  await t.test("an audit-write failure rolls back both reservation mutations", async () => {
    const f = await fixture(); expectOK(await send(f));
    expectOK(await action(f, "problem", { allocationId: f.allocationId, pickedQty: 6 }));
    const original = InventoryMovement.create;
    const mock = t.mock.method(InventoryMovement, "create", async function (...args) {
      if (args[0]?.[0]?.type === "RESERVE") throw new Error("Test audit failure");
      return original.apply(this, args);
    });
    try { assert.equal((await action(f, "replace", { allocationId: f.allocationId, slotId: String(f.slots[1]._id), qty: 4 })).status, 500); }
    finally { mock.mock.restore(); }
    assert.equal((await OrderAllocation.findById(f.allocation._id)).qty, 10);
    assert.equal(await OrderAllocation.countDocuments({ order: f.order._id }), 1);
    assert.equal(await InventoryMovement.countDocuments({ order: f.order._id }), 0);
  });
  await t.test("duplicate/stale confirmations cannot add picked units twice", async () => {
    const f = await fixture(); expectOK(await send(f)); const v = await view(f, worker);
    const body = { allocationId: f.allocationId, pickedQty: 10, expectedRevision: v.version };
    expectOK(await api(`/packing/orders/${f.order._id}/pick`, { actor: worker, method: "POST", body }));
    assert.equal((await api(`/packing/orders/${f.order._id}/pick`, { actor: worker, method: "POST", body })).status, 409);
    assert.equal((await OrderAllocation.findById(f.allocation._id)).pickedQty, 10);
    assert.equal((await Order.findById(f.order._id).select("+packingActivity")).packingActivity.filter(row => row.action === "PICKED").length, 1);
  });
  await t.test("collected quantities are protected from manual edits, cancellation and deletion", async () => {
    const f = await fixture(); expectOK(await send(f));
    expectOK(await action(f, "pick", { allocationId: f.allocationId, pickedQty: 6 }));
    assert.equal((await api(`/slots/${f.slots[0]._id}`, { method: "DELETE" })).status, 409);
    assert.equal((await api(`/orders/${f.order._id}/allocations/${f.allocationId}`, { method: "DELETE" })).status, 409);
    assert.equal((await api(`/orders/${f.order._id}/allocations`, { method: "POST", body: { productId: String(f.productId), slotId: String(f.slots[0]._id), qty: 5 } })).status, 409);
    assert.equal((await api(`/orders/${f.order._id}/cancel`, { method: "POST", body: {} })).status, 409);
    const preview = (await api(`/orders/${f.order._id}/delete-preview`)).body.data;
    assert.equal(preview.allowed, true);
    assert.equal(preview.stock.requiresPhysicalReturn, true);
    assert.equal((await api(`/orders/${f.order._id}`, { method: "DELETE", body: { expectedRevision: preview.order.version } })).status, 409);
    assert.equal((await api(`/orders/${f.order._id}`, { method: "DELETE" })).status, 409);
    assert.equal((await action(f, "correct", { allocationId: f.allocationId, pickedQty: 0 })).status, 409);
    expectOK(await action(f, "correct", { allocationId: f.allocationId, pickedQty: 0, confirmedReturn: true }));
    expectOK(await api(`/orders/${f.order._id}/cancel`, { method: "POST", body: { confirmedPhysicalReturn: true } }));
    const archived = await view(f);
    assert.equal(archived.status, "Cancelled"); assert.equal(archived.summary.needsHelp, false);
    assert.ok(archived.activity.length >= 3);
    assert.equal((await api(`/packing/orders/${f.order._id}`, { actor: worker })).status, 403);
  });
  await t.test("reserved and picked orders delete after confirming returns without adding stock twice", async () => {
    for (const pickedQty of [0, 6, 10]) {
      const f = await fixture(); expectOK(await send(f));
      if (pickedQty) expectOK(await action(f, "pick", { allocationId: f.allocationId, pickedQty }));
      if (pickedQty === 10) expectOK(await action(f, "packed"));
      const preview = (await api(`/orders/${f.order._id}/delete-preview`)).body.data;
      assert.equal(preview.allowed, true);
      assert.equal(preview.stock.pickedQty, pickedQty);
      assert.equal(preview.stock.returnRows.length, pickedQty ? 1 : 0);
      if (pickedQty) {
        assert.equal(preview.stock.returnRows[0].qty, pickedQty);
        assert.equal(preview.stock.returnRows[0].slotLabel, "A1-AE1");
        assert.equal(preview.stock.returnRows[0].unit, "100yd Roll");
      }
      const deleted = await api(`/orders/${f.order._id}`, { method: "DELETE", body: { confirmedPhysicalReturn: true, expectedRevision: preview.order.version } });
      expectOK(deleted);
      assert.equal(deleted.body.data.releasedQty, 10);
      assert.equal(deleted.body.data.returnedPickedQty, pickedQty);
      assert.equal(deleted.body.data.restoredQty, 0);
      assert.equal(await Order.findById(f.order._id), null);
      assert.equal(await OrderAllocation.countDocuments({ order: f.order._id }), 0);
      assert.equal((await SlotItem.findOne({ product: f.productId, slot: f.slots[0]._id })).qty, 20);
      const movement = await InventoryMovement.findOne({ order: f.order._id, type: "RELEASE" }).lean();
      assert.equal(movement.meta.returnedPickedQty, pickedQty);
      assert.equal(movement.meta.physicalReturnConfirmed, true);
      assert.equal(String(movement.actor), String(admin._id));
      assert.equal((await api(`/packing/orders/${f.order._id}`, { actor: worker })).status, 403);
    }
  });
  await t.test("changed picks invalidate a return acknowledgement and require a fresh delete preview", async () => {
    const f = await fixture(); expectOK(await send(f));
    expectOK(await action(f, "pick", { allocationId: f.allocationId, pickedQty: 4 }));
    const preview = (await api(`/orders/${f.order._id}/delete-preview`)).body.data;
    expectOK(await action(f, "pick", { allocationId: f.allocationId, pickedQty: 6 }));
    const stale = await api(`/orders/${f.order._id}`, { method: "DELETE", body: { confirmedPhysicalReturn: true, expectedRevision: preview.order.version } });
    assert.equal(stale.status, 409); assert.match(stale.body.message, /Order changed/);
    assert.ok(await Order.findById(f.order._id));
    assert.equal((await OrderAllocation.findById(f.allocation._id)).pickedQty, 6);
    assert.equal(await InventoryMovement.countDocuments({ order: f.order._id }), 0);
    const fresh = (await api(`/orders/${f.order._id}/delete-preview`)).body.data;
    assert.equal(fresh.stock.returnRows[0].qty, 6);
    expectOK(await api(`/orders/${f.order._id}`, { method: "DELETE", body: { confirmedPhysicalReturn: true, expectedRevision: fresh.order.version } }));
  });
  await t.test("deletion and a competing pick cannot both commit against the same confirmation", async () => {
    const f = await fixture(); expectOK(await send(f));
    expectOK(await action(f, "pick", { allocationId: f.allocationId, pickedQty: 6 }));
    const preview = (await api(`/orders/${f.order._id}/delete-preview`)).body.data;
    const [deleted, picked] = await Promise.all([
      api(`/orders/${f.order._id}`, { method: "DELETE", body: { confirmedPhysicalReturn: true, expectedRevision: preview.order.version } }),
      api(`/packing/orders/${f.order._id}/pick`, { actor: worker, method: "POST", body: { allocationId: f.allocationId, pickedQty: 10, expectedRevision: preview.order.version } }),
    ]);
    assert.equal([deleted, picked].filter(result => result.status === 200).length, 1);
    assert.equal((await SlotItem.findOne({ product: f.productId, slot: f.slots[0]._id })).qty, 20);
    if (deleted.status === 200) {
      assert.equal(await Order.findById(f.order._id), null);
      assert.equal(await OrderAllocation.countDocuments({ order: f.order._id }), 0);
      assert.equal((await InventoryMovement.findOne({ order: f.order._id, type: "RELEASE" })).meta.returnedPickedQty, 6);
    } else {
      assert.equal(deleted.status, 409);
      assert.equal((await OrderAllocation.findById(f.allocationId)).pickedQty, 10);
      assert.equal(await InventoryMovement.countDocuments({ order: f.order._id, type: "RELEASE" }), 0);
    }
  });
  await t.test("physical return acknowledgement does not bypass missing finalized stock records", async () => {
    const f = await fixture(); expectOK(await send(f));
    expectOK(await action(f, "pick", { allocationId: f.allocationId, pickedQty: 6 }));
    await Order.updateOne({ _id: f.order._id }, { $set: { stockFinalizedAt: new Date() } });
    const preview = (await api(`/orders/${f.order._id}/delete-preview`)).body.data;
    assert.equal(preview.allowed, false);
    assert.match(preview.blockers.join(" "), /deducted allocation records are missing/);
    assert.equal((await api(`/orders/${f.order._id}`, { method: "DELETE", body: { confirmedPhysicalReturn: true, expectedRevision: preview.order.version } })).status, 409);
    assert.ok(await Order.findById(f.order._id));
    assert.equal((await OrderAllocation.findById(f.allocationId)).pickedQty, 6);
    assert.equal(await InventoryMovement.countDocuments({ order: f.order._id }), 0);
  });
  await t.test("a failed return audit leaves the order, picks, reservations and stock unchanged", async () => {
    const f = await fixture(); expectOK(await send(f));
    expectOK(await action(f, "pick", { allocationId: f.allocationId, pickedQty: 6 }));
    const preview = (await api(`/orders/${f.order._id}/delete-preview`)).body.data;
    const original = InventoryMovement.create;
    const audit = t.mock.method(InventoryMovement, "create", async function (...args) {
      if (args[0]?.[0]?.meta?.reason === "ORDER_DELETED") throw new Error("Test delete audit failure");
      return original.apply(this, args);
    });
    try {
      assert.equal((await api(`/orders/${f.order._id}`, { method: "DELETE", body: { confirmedPhysicalReturn: true, expectedRevision: preview.order.version } })).status, 500);
    } finally { audit.mock.restore(); }
    assert.equal((await Order.findById(f.order._id).select("+reservationRevision")).reservationRevision, preview.order.version);
    assert.equal((await OrderAllocation.findById(f.allocation._id)).pickedQty, 6);
    assert.equal(await InventoryMovement.countDocuments({ order: f.order._id }), 0);
    assert.equal((await SlotItem.findOne({ product: f.productId, slot: f.slots[0]._id })).qty, 20);
  });
  await t.test("deducted packing stock restores once after confirmed deletion", async () => {
    const f = await fixture(); expectOK(await send(f));
    expectOK(await action(f, "pick", { allocationId: f.allocationId, pickedQty: 10 }));
    expectOK(await action(f, "packed"));
    await Order.updateOne({ _id: f.order._id }, { $set: { invoice: new mongoose.Types.ObjectId() } });
    expectOK(await api(`/orders/${f.order._id}/deliver`, { method: "PUT", body: { deliveredBy: "Courier" } }));
    expectOK(await api(`/orders/${f.order._id}/allocations/finalize`, { method: "POST", body: {} }));
    assert.equal((await SlotItem.findOne({ product: f.productId, slot: f.slots[0]._id })).qty, 10);
    const preview = (await api(`/orders/${f.order._id}/delete-preview`)).body.data;
    const body = { confirmedPhysicalReturn: true, expectedRevision: preview.order.version };
    expectOK(await api(`/orders/${f.order._id}`, { method: "DELETE", body }));
    assert.equal((await SlotItem.findOne({ product: f.productId, slot: f.slots[0]._id })).qty, 20);
    assert.equal((await api(`/orders/${f.order._id}`, { method: "DELETE", body })).status, 404);
    assert.equal((await SlotItem.findOne({ product: f.productId, slot: f.slots[0]._id })).qty, 20);
    assert.equal(await InventoryMovement.countDocuments({ order: f.order._id, type: "RESTORE" }), 1);
  });
  await t.test("plain reservations can be deleted without a worker return confirmation", async () => {
    const f = await fixture();
    const preview = (await api(`/orders/${f.order._id}/delete-preview`)).body.data;
    assert.equal(preview.allowed, true); assert.equal(preview.stock.requiresPhysicalReturn, false);
    expectOK(await api(`/orders/${f.order._id}`, { method: "DELETE", body: { expectedRevision: preview.order.version } }));
    assert.equal((await SlotItem.findOne({ product: f.productId, slot: f.slots[0]._id })).qty, 20);
  });

  await t.test("shelf counts cannot deduct collected-but-not-finalized units again", async () => {
    const f = await fixture(); expectOK(await send(f));
    expectOK(await action(f, "pick", { allocationId: f.allocationId, pickedQty: 6 }));
    const result = await api("/slot-items/correct-count", { method: "POST", body: { productId: String(f.productId), slotId: String(f.slots[0]._id), actualQty: 14, note: "Physical shelf count" } });
    assert.equal(result.status, 409); assert.match(result.body.message, /6 collected/);
    assert.equal((await SlotItem.findOne({ product: f.productId, slot: f.slots[0]._id })).qty, 20);
    const stock = await api(`/slot-items/by-product/${f.productId}?orderId=${f.order._id}`);
    assert.equal(stock.body.data.find(row => String(row.slot._id) === String(f.slots[0]._id)).pendingPickedQty, 6);
  });
  await t.test("packed gate, admin reopen and delivery/finalization work exactly once", async () => {
    const f = await fixture(); expectOK(await send(f));
    assert.equal((await action(f, "packed")).status, 409);
    assert.equal((await api(`/orders/${f.order._id}/deliver`, { method: "PUT", body: { deliveredBy: "Courier" } })).status, 409);
    expectOK(await action(f, "pick", { allocationId: f.allocationId, pickedQty: 10 }));
    expectOK(await action(f, "packed"));
    assert.equal((await action(f, "correct", { allocationId: f.allocationId, pickedQty: 0, confirmedReturn: true })).status, 409);
    assert.equal((await action(f, "reopen")).status, 403);
    expectOK(await action(f, "reopen", {}, admin));
    assert.equal((await OrderAllocation.findById(f.allocation._id)).pickedQty, 10);
    expectOK(await action(f, "packed"));
    await Order.updateOne({ _id: f.order._id }, { $set: { invoice: new mongoose.Types.ObjectId() } });
    expectOK(await api(`/orders/${f.order._id}/deliver`, { method: "PUT", body: { deliveredBy: "Courier" } }));
    expectOK(await api(`/orders/${f.order._id}/allocations/finalize`, { method: "POST", body: {} }));
    expectOK(await api(`/orders/${f.order._id}/allocations/finalize`, { method: "POST", body: {} }));
    assert.equal((await SlotItem.findOne({ product: f.productId, slot: f.slots[0]._id })).qty, 10);
    assert.equal((await OrderAllocation.findById(f.allocation._id)).expiresAt, undefined);
    const preview = await api(`/orders/${f.order._id}/delete-preview`);
    assert.equal(preview.body.data.stock.requiresPhysicalReturn, true);
    assert.equal((await api(`/orders/${f.order._id}`, { method: "DELETE" })).status, 409);
  });
  await t.test("reassignment retains progress and removes the old worker's access", async () => {
    const f = await fixture(); expectOK(await send(f));
    expectOK(await action(f, "pick", { allocationId: f.allocationId, pickedQty: 6 }));
    expectOK(await send(f, other));
    assert.equal((await api(`/packing/orders/${f.order._id}`, { actor: worker })).status, 403);
    assert.equal((await view(f, other)).items[0].pickedQty, 6);
    assert.ok((await view(f, other)).handoverAt);
  });
  await t.test("concurrent replacements on two orders cannot overbook their shared alternative", async () => {
    const f = await fixture({ targetQty: 5 });
    const secondOrder = await Order.create({ user: customer._id, status: "Shipping", orderItems: [{ product: f.productId, sku: "SHARED", qty: 10, unitPrice: 1 }], totalPrice: 10 });
    const secondAllocation = await OrderAllocation.create({ order: secondOrder._id, product: f.productId, slot: f.slots[0]._id, qty: 10 });
    const g = { ...f, order: secondOrder, allocation: secondAllocation, allocationId: String(secondAllocation._id) };
    expectOK(await send(f)); expectOK(await send(g));
    expectOK(await action(f, "problem", { allocationId: f.allocationId, pickedQty: 6 }));
    expectOK(await action(g, "problem", { allocationId: g.allocationId, pickedQty: 6 }));
    const results = await Promise.all([f, g].map(task => action(task, "replace", { allocationId: task.allocationId, slotId: String(f.slots[1]._id), qty: 4 })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const held = await OrderAllocation.find({ product: f.productId, slot: f.slots[1]._id }).lean();
    assert.equal(held.reduce((sum, row) => sum + row.qty, 0), 4);
  });
  await t.test("role revocation invalidates an existing worker session", async () => {
    const auth = await cookieFor(other);
    expectOK(await api(`/users/${other._id}`, { method: "PUT", body: { isWorker: false } }));
    assert.equal((await api("/packing/orders", { cookie: auth })).status, 401);
  });

  await t.test("split replacements preserve a target's earlier picked quantity and original report", async () => {
    const f = await fixture({ targetQty: 4 });
    await OrderAllocation.updateOne({ _id: f.allocation._id }, { $set: { qty: 8 } });
    const prior = await OrderAllocation.create({ order: f.order._id, product: f.productId, slot: f.slots[1]._id, qty: 2, pickedQty: 1, pickedBy: admin._id, pickedAt: new Date() });
    expectOK(await send(f));
    expectOK(await action(f, "problem", { allocationId: f.allocationId, pickedQty: 4 }));
    expectOK(await action(f, "replace", { allocationId: f.allocationId, slotId: String(f.slots[1]._id), qty: 2 }));
    assert.equal((await view(f, worker)).summary.needsHelp, true);
    expectOK(await action(f, "replace", { allocationId: f.allocationId, slotId: String(f.slots[2]._id), qty: 2 }));
    const target = await OrderAllocation.findById(prior._id);
    assert.equal(target.qty, 4); assert.equal(target.pickedQty, 1); assert.equal(String(target.pickedBy), String(admin._id));
    const v = await view(f, worker);
    assert.equal(v.items[0].pickedQty, 5); assert.equal(v.items[0].reservedQty, 10); assert.equal(v.summary.needsHelp, false);
    assert.equal((await Order.findById(f.order._id).select("+packingReports")).packingReports[0].shortQty, 4);
  });
  await t.test("manual reservations and worker replacements serialize against the same stock", async () => {
    const f = await fixture({ targetQty: 5 }); expectOK(await send(f));
    expectOK(await action(f, "problem", { allocationId: f.allocationId, pickedQty: 6 }));
    const manual = await Order.create({ user: customer._id, status: "Shipping", orderItems: [{ product: f.productId, sku: "SHARED", qty: 4, unitPrice: 1 }], totalPrice: 4 });
    const results = await Promise.all([
      action(f, "replace", { allocationId: f.allocationId, slotId: String(f.slots[1]._id), qty: 4 }),
      api(`/orders/${manual._id}/allocations`, { method: "POST", body: { productId: String(f.productId), slotId: String(f.slots[1]._id), qty: 4 } }),
    ]);
    assert.equal(results.filter(result => result.status === 200).length, 1, JSON.stringify(results));
    const held = await OrderAllocation.find({ product: f.productId, slot: f.slots[1]._id }).lean();
    assert.equal(held.reduce((sum, row) => sum + row.qty, 0), 4);
  });
  await t.test("inactive locations block new collections but do not block finishing goods already collected", async () => {
    const f = await fixture(); expectOK(await send(f));
    await Slot.updateOne({ _id: f.slots[0]._id }, { $set: { isActive: false } });
    assert.equal((await action(f, "pick", { allocationId: f.allocationId, pickedQty: 10 })).status, 409);
    expectOK(await action(f, "problem", { allocationId: f.allocationId, pickedQty: 6 }));
    expectOK(await action(f, "replace", { allocationId: f.allocationId, slotId: String(f.slots[1]._id), qty: 4 }));
    const target = await OrderAllocation.findOne({ order: f.order._id, slot: f.slots[1]._id });
    expectOK(await action(f, "pick", { allocationId: String(target._id), pickedQty: 4 }));
    assert.equal((await view(f, worker)).canPack, true);
    expectOK(await action(f, "packed"));
  });
  await t.test("enabling worker access requires a fresh staff login instead of a customer token", async () => {
    const oldCookie = await cookieFor(customer);
    expectOK(await api(`/users/${customer._id}`, { method: "PUT", body: { isWorker: true } }));
    assert.equal((await api("/users/account/profile", { cookie: oldCookie })).status, 401);
    const login = await api("/users/auth", { method: "POST", body: { email: customer.email, password: "test-password" } });
    expectOK(login); assert.equal(login.body.data.isWorker, true); assert.ok(login.body.data.sessionId);
    expectOK(await api(`/users/${customer._id}`, { method: "PUT", body: { isWorker: false } }));
  });
  await t.test("published tasks require physical handover confirmation even before the first saved collection", async () => {
    const f = await fixture(); expectOK(await send(f));
    assert.equal((await api(`/orders/${f.order._id}/cancel`, { method: "POST", body: {} })).status, 409);
    assert.equal((await api(`/orders/${f.order._id}/delete-preview`)).body.data.stock.requiresPhysicalReturn, true);
    assert.equal((await api(`/orders/${f.order._id}`, { method: "DELETE" })).status, 409);
    expectOK(await api(`/orders/${f.order._id}/cancel`, { method: "POST", body: { confirmedPhysicalReturn: true } }));
    assert.equal(await OrderAllocation.countDocuments({ order: f.order._id }), 0);
    assert.equal((await SlotItem.findOne({ product: f.productId, slot: f.slots[0]._id })).qty, 20);
  });
  await t.test("older persisted orders and reservations need no packing-field backfill", async () => {
    const f = await fixture();
    await Order.collection.updateOne({ _id: f.order._id }, { $unset: { packingReports: "", packingActivity: "", packingSummary: "", reservationRevision: "", deliveryRevision: "" } });
    await OrderAllocation.collection.updateOne({ _id: f.allocation._id }, { $unset: { pickedQty: "", pickProblem: "" } });
    const old = await view(f);
    assert.deepEqual(old.reports, []); assert.deepEqual(old.activity, []); assert.equal(old.version, 0);
    assert.equal(old.items[0].pickedQty, 0);
    expectOK(await send(f));
    expectOK(await action(f, "pick", { allocationId: f.allocationId, pickedQty: 10 }));
    expectOK(await action(f, "packed"));
  });
});
