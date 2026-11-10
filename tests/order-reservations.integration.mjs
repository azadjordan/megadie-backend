// Disposable local replica set only. Never loads .env or development data.
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import express from "express";
import cookieParser from "cookie-parser";
import { testSessionCookies } from "./helpers/sessionCookie.mjs";
import orderRoutes from "../routes/orderRoutes.js";
import User from "../models/userModel.js";
import Order from "../models/orderModel.js";
import Slot from "../models/slotModel.js";
import Product from "../models/productModel.js";
import SlotItem from "../models/slotItemModel.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import InventoryMovement from "../models/inventoryMovementModel.js";
import { errorHandler } from "../middleware/errorMiddleware.js";

const uri = process.env.RESERVATION_TEST_URI;
test("order-wide reservations on a disposable replica set", { skip: !uri, timeout: 90000 }, async (t) => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/megadie_reservation_test(?:\?|$)/);
  process.env.JWT_SECRET = "local-reservation-test-secret";
  process.env.NODE_ENV = "production";
  await mongoose.connect(uri, { autoIndex: false });
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  await mongoose.connection.dropDatabase();
  await OrderAllocation.createIndexes();
  await InventoryMovement.createCollection();
  const admin = await User.create({ name: "Admin", email: "admin@test.invalid", phoneNumber: "admin-phone", password: "test-password", isAdmin: true, approvalStatus: "Approved" });
  const customer = await User.create({ name: "Customer", email: "customer@test.invalid", phoneNumber: "customer-phone", password: "test-password", approvalStatus: "Approved" });
  const app = express(); app.use(express.json()); app.use(cookieParser()); app.use("/api/orders", orderRoutes); app.use(errorHandler);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const sessionCookie = testSessionCookies();
  async function api(path, { method = "POST", body, as = admin } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (as) headers.Cookie = await sessionCookie(as);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/orders/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }
  async function fixture(qtys = [10, 4], stockQtys = qtys) {
    const products = qtys.map(() => new mongoose.Types.ObjectId());
    const slots = qtys.map(() => new mongoose.Types.ObjectId());
    await Product.collection.insertMany(products.map((_id, i) => ({ _id, name: `Product ${i}`, sku: `SKU-${_id}`, cbm: 0 })));
    await Slot.collection.insertMany(slots.map((_id, i) => ({ _id, label: `A${i + 1}-${_id}-AE1`, store: "AE1", unit: "A", position: i + 1 })));
    for (let i = 0; i < products.length; i++) if (stockQtys[i] != null) await SlotItem.collection.insertOne({ product: products[i], slot: slots[i], qty: stockQtys[i], cbm: 0, createdAt: new Date() });
    const order = await Order.create({ user: customer._id, status: "Shipping", orderItems: products.map((product, i) => ({ product, sku: `SKU-${product}`, qty: qtys[i], unitPrice: 10 })) });
    return { order, products, slots, path: `${order._id}/allocations/reserve-all` };
  }
  const allocations = (order) => OrderAllocation.find({ order: order._id }).lean();
  const movements = (order) => InventoryMovement.countDocuments({ order: order._id });

  await t.test("shortages return every issue and write nothing, including guards and audit", async () => {
    const f = await fixture([10, 4, 2], [7, null, 2]);
    const beforeOrder = await Order.collection.findOne({ _id: f.order._id });
    const beforeStock = await SlotItem.collection.find({ product: { $in: f.products } }).toArray();
    const result = await api(f.path);
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.noNewReservations, true);
    assert.equal(result.body.issues.length, 2);
    assert.equal(result.body.issues[0].shortageQty, 3);
    assert.equal(result.body.issues[1].shortageQty, 4);
    assert.deepEqual(await allocations(f.order), []);
    assert.equal(await movements(f.order), 0);
    assert.deepEqual(await Order.collection.findOne({ _id: f.order._id }), beforeOrder);
    assert.deepEqual(await SlotItem.collection.find({ product: { $in: f.products } }).toArray(), beforeStock);
  });
  await t.test("success reserves the complete order without deducting stock, and retry adds nothing", async () => {
    const f = await fixture();
    const result = await api(f.path);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.addedQty, 14);
    assert.equal((await allocations(f.order)).length, 2);
    assert.equal((await Order.findById(f.order._id)).allocationStatus, "Allocated");
    const sheet = await api(`${f.order._id}/fulfillment-sheet`, { method: "GET" });
    assert.equal(sheet.status, 200);
    assert.equal(sheet.body.data.picks.reduce((sum, row) => sum + row.qty, 0), 14);
    assert.deepEqual((await SlotItem.find({ product: { $in: f.products } }).lean()).map((row) => row.qty), [10, 4]);
    const repeat = await api(f.path);
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.data.addedQty, 0);
    assert.equal(await movements(f.order), 2);
  });
  await t.test("the existing finalization flow deducts bulk reservations exactly once", async () => {
    const f = await fixture([4], [10]);
    assert.equal((await api(f.path)).status, 200);
    await Order.updateOne({ _id: f.order._id }, { $set: { status: "Delivered", invoice: new mongoose.Types.ObjectId() } });
    const finalized = await api(`${f.order._id}/allocations/finalize`);
    assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
    assert.equal((await SlotItem.findOne({ product: f.products[0] })).qty, 6);
    assert.equal((await allocations(f.order))[0].status, "Deducted");
    assert.ok((await Order.findById(f.order._id)).stockFinalizedAt);
    assert.equal((await Order.findById(f.order._id)).allocationStatus, "Allocated");
    const repeated = await api(`${f.order._id}/allocations/finalize`);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.data.alreadyFinalized, true);
    assert.equal((await SlotItem.findOne({ product: f.products[0] })).qty, 6);
    assert.equal((await api(f.path)).status, 409);
  });
  await t.test("preserves manual picks, including notes and actor, and uses the next slots", async () => {
    const f = await fixture([10], [4]);
    const manual = await api(`${f.order._id}/allocations`, { body: { productId: String(f.products[0]), slotId: String(f.slots[0]), qty: 4, note: "Keep this pick" } });
    assert.equal(manual.status, 200, JSON.stringify(manual.body));
    const original = (await allocations(f.order))[0];
    const next = await Slot.create({ label: `EXTRA-${f.order._id}`, store: "AE1", unit: "A", position: 9, cbm: 1 });
    await SlotItem.collection.insertOne({ product: f.products[0], slot: next._id, qty: 6, cbm: 0 });
    assert.equal((await api(f.path)).status, 200);
    assert.deepEqual(await OrderAllocation.findById(original._id).lean(), original);
    assert.equal((await allocations(f.order)).reduce((sum, row) => sum + row.qty, 0), 10);
  });
  await t.test("a shortage preserves existing reservations and reports their quantities", async () => {
    const f = await fixture([10], [20]);
    await api(`${f.order._id}/allocations`, { body: { productId: String(f.products[0]), slotId: String(f.slots[0]), qty: 4 } });
    const before = await allocations(f.order);
    const result = await api(f.path);
    assert.equal(result.status, 409);
    assert.equal(result.body.issues[0].reservedQty, 4);
    assert.equal(result.body.issues[0].neededQty, 6);
    assert.match(result.body.issues[0].message, /Review existing slot reservations/);
    assert.deepEqual(await allocations(f.order), before);
  });
  await t.test("duplicate ordered product lines are reserved once for their combined quantity", async () => {
    const f = await fixture([5], [5]);
    await Order.updateOne({ _id: f.order._id }, { $set: { orderItems: [{ product: f.products[0], sku: "S", qty: 2, unitPrice: 1 }, { product: f.products[0], sku: "S", qty: 3, unitPrice: 1 }] } });
    const result = await api(f.path);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.addedQty, 5);
    assert.equal((await Order.findById(f.order._id)).allocationStatus, "Allocated");
  });
  await t.test("expected restrictions and authorization are enforced", async () => {
    const f = await fixture([1]);
    for (const status of ["Processing", "Delivered", "Cancelled"]) {
      await Order.updateOne({ _id: f.order._id }, { $set: { status } });
      assert.equal((await api(f.path)).status, 409);
    }
    await Order.updateOne({ _id: f.order._id }, { $set: { status: "Shipping", stockFinalizedAt: new Date() } });
    assert.equal((await api(f.path)).status, 409);
    assert.equal((await api(f.path, { as: customer })).status, 403);
    assert.equal((await api(f.path, { as: null })).status, 401);
    assert.deepEqual(await allocations(f.order), []);
  });
  await t.test("a write failure after the first reservation rolls back all changes", async (t) => {
    const f = await fixture();
    const original = InventoryMovement.create;
    let calls = 0;
    t.mock.method(InventoryMovement, "create", async function (...args) {
      if (++calls === 2) throw new Error("Injected audit failure");
      return original.apply(this, args);
    });
    const before = await Order.collection.findOne({ _id: f.order._id });
    const result = await api(f.path);
    assert.equal(result.status, 500);
    assert.equal(calls, 2);
    assert.deepEqual(await allocations(f.order), []);
    assert.equal(await movements(f.order), 0);
    assert.deepEqual(await Order.collection.findOne({ _id: f.order._id }), before);
  });
  await t.test("simultaneous requests for the same order are idempotent", async () => {
    const f = await fixture();
    const results = await Promise.all([api(f.path), api(f.path)]);
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    assert.deepEqual(results.map((r) => r.body.data.addedQty).sort((a, b) => a - b), [0, 14]);
    assert.equal(await movements(f.order), 2);
  });
  await t.test("competing orders cannot reserve the same stock twice", async () => {
    const f = await fixture([10]);
    const second = await Order.create({ user: customer._id, status: "Shipping", orderItems: f.order.orderItems });
    const results = await Promise.all([api(f.path), api(`${second._id}/allocations/reserve-all`)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const rows = await OrderAllocation.find({ order: { $in: [f.order._id, second._id] } }).lean();
    assert.equal(rows.reduce((sum, row) => sum + row.qty, 0), 10);
  });
  await t.test("manual and bulk requests share the stock guard, and release restores availability", async () => {
    const f = await fixture([10]);
    const second = await Order.create({ user: customer._id, status: "Shipping", orderItems: f.order.orderItems });
    const results = await Promise.all([api(f.path), api(`${second._id}/allocations`, { body: { productId: String(f.products[0]), slotId: String(f.slots[0]), qty: 10 } })]);
    assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results));
    const rows = await OrderAllocation.find({ order: { $in: [f.order._id, second._id] } }).lean();
    assert.equal(rows.length, 1);
    const winner = rows[0];
    assert.equal((await api(`${winner.order}/allocations/${winner._id}`, { method: "DELETE" })).status, 200);
    const loser = String(winner.order) === String(f.order._id) ? second._id : f.order._id;
    assert.equal((await api(`${loser}/allocations/reserve-all`)).status, 200);
  });
  await t.test("manual and bulk requests for different slots of the same order cannot exceed its quantity", async () => {
    const f = await fixture([10]);
    const slot = new mongoose.Types.ObjectId();
    await Slot.collection.insertOne({ _id: slot, label: "SECOND-AE1", store: "AE1" });
    await SlotItem.collection.insertOne({ product: f.products[0], slot, qty: 10, cbm: 0 });
    const results = await Promise.all([api(f.path), api(`${f.order._id}/allocations`, { body: { productId: String(f.products[0]), slotId: String(slot), qty: 10 } })]);
    assert.equal(results[0].status, 200, JSON.stringify(results));
    assert.ok([200, 400].includes(results[1].status), JSON.stringify(results));
    assert.equal((await allocations(f.order)).reduce((sum, row) => sum + row.qty, 0), 10);
  });
});
