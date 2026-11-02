// Explicit local test URI only. Never loads .env or connects to the development database.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import mongoose from "mongoose";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import orderRoutes from "../routes/orderRoutes.js";
import userRoutes from "../routes/userRoutes.js";
import User from "../models/userModel.js";
import Order from "../models/orderModel.js";
import Quote from "../models/quoteModel.js";
import Slot from "../models/slotModel.js";
import Product from "../models/productModel.js";
import SlotItem from "../models/slotItemModel.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import { errorHandler } from "../middleware/errorMiddleware.js";

const uri = process.env.DELIVERY_TEST_URI || (process.env.DELIVERY_TEST_URI_FILE ? readFileSync(process.env.DELIVERY_TEST_URI_FILE, "utf8").trim() : "");

test("delivery API integration on an isolated local replica set", { skip: !uri, timeout: 90000 }, async (t) => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/megadie_delivery_test(?:\?|$)/, "Only the explicitly named local disposable database is permitted");
  process.env.JWT_SECRET = "local-delivery-test-secret";
  process.env.NODE_ENV = "production";
  await mongoose.connect(uri, { autoIndex: false });
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  await mongoose.connection.dropDatabase();
  await User.collection.createIndex({ phoneNumber: 1 }, { unique: true, sparse: true });
  const admin = await User.create({ name: "Admin", email: "admin@test.invalid", phoneNumber: "admin-phone", password: "test-password", isAdmin: true, approvalStatus: "Approved" });
  const customer = await User.create({ name: "Alpha Beta Company", email: "client@test.invalid", phoneNumber: "client-phone", password: "test-password", address: "Default destination", approvalStatus: "Approved" });
  const other = await User.create({ name: "Other Customer", email: "other@test.invalid", phoneNumber: "other-phone", password: "test-password", address: "Other destination", approvalStatus: "Approved" });
  const product = new mongoose.Types.ObjectId();
  await Product.collection.insertOne({ _id: product, name: "Grosgrain ribbon", sku: "SKU1" });
  const slots = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  await Slot.collection.insertMany(slots.map((_id, i) => ({ _id, label: `A${i ? 10 : 2}-AE1`, store: "AE1", unit: "A", position: i ? 10 : 2 })));
  await SlotItem.collection.insertOne({ product, slot: slots[0], qty: 100 });
  const app = express(); app.use(express.json()); app.use(cookieParser());
  app.use("/api/orders", orderRoutes); app.use("/api/users", userRoutes); app.use(errorHandler);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function api(path, { as = admin, method = "GET", body } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (as) headers.Cookie = `jwt=${jwt.sign({ userId: String(as._id) }, process.env.JWT_SECRET)}`;
    const response = await fetch(origin + "/api" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const quote = await Quote.create({ user: customer._id, status: "Confirmed", requestedItems: [{ product, qty: 4, unitPrice: 10 }] });
  const created = await api(`/orders/from-quote/${quote._id}`, { method: "POST" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const orderId = created.body._id;
  const second = await Order.create({ user: customer._id, orderItems: [{ product, sku: "SKU1", qty: 1, unitPrice: 10 }], deliveryDetails: created.body.deliveryDetails, deliveryRevision: 1 });
  await Order.updateOne({ _id: orderId }, { $set: { status: "Shipping", orderNumber: "ORD-261102-023AD" } });
  await OrderAllocation.collection.insertMany(slots.map((slot) => ({ order: new mongoose.Types.ObjectId(orderId), product, slot, qty: 2, status: "Reserved", note: "INTERNAL-SECRET", by: admin._id })));
  const endpoint = `/orders/${orderId}/delivery-details`;
  const newDetails = { contactName: "Reception", phoneNumber: "shared-recipient", secondaryPhoneNumber: "backup", address: "Order-only destination", googleMapsUrl: "https://maps.app.goo.gl/example", notes: "Open until 5" };

  await t.test("new order captures defaults and later profile changes do not alter it", async () => {
    assert.equal(created.body.deliveryDetails.address, "Default destination");
    assert.equal(created.body.deliveryRevision, 1);
    const update = await api("/users/account/profile", { as: customer, method: "PUT", body: { address: "New default", deliveryContactName: "Usual desk", deliveryPhoneNumber: "shared-recipient" } });
    assert.equal(update.status, 200);
    assert.equal(update.body.data.phoneNumber, "client-phone");
    const read = await api(`/orders/${orderId}`);
    assert.equal(read.body.data.resolvedDelivery.details.address, "Default destination");
    const saved = await api(endpoint, { method: "PUT", body: { expectedRevision: 1, deliveryDetails: newDetails } });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.resolvedDelivery.revision, 2);
    assert.equal((await User.findById(customer._id)).address, "New default");
    assert.equal((await Order.findById(second._id)).deliveryDetails.address, "Default destination");
    await api(`/users/${other._id}`, { method: "PUT", body: { deliveryPhoneNumber: "shared-recipient" } });
    assert.equal((await User.findById(other._id)).phoneNumber, "other-phone");
  });
  await t.test("fresh sheet is read-only, compact labeled, correctly sorted, and contains no internal data", async () => {
    const before = JSON.stringify(await Order.findById(orderId).lean());
    const result = await api(`/orders/${orderId}/fulfillment-sheet`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data.problems, []);
    assert.equal(result.body.data.label, "ABC-023AD");
    assert.deepEqual(result.body.data.picks.map((p) => p.slot), ["A2-AE1", "A10-AE1"]);
    assert.equal(result.body.data.delivery.details.address, newDetails.address);
    assert.doesNotMatch(JSON.stringify(result.body), /INTERNAL-SECRET|unitPrice|totalPrice|admin@test|storeAddress/);
    assert.equal(JSON.stringify(await Order.findById(orderId).lean()), before);
    assert.equal((await SlotItem.findOne({ product })).qty, 100);
    assert.equal(await OrderAllocation.countDocuments({ order: orderId, status: "Reserved" }), 2);
  });
  await t.test("destination edits require admin, valid values and revision; owners remain sanitized", async () => {
    assert.equal((await api(endpoint, { as: customer, method: "PUT", body: { expectedRevision: 2, deliveryDetails: newDetails } })).status, 403);
    assert.equal((await api(`/orders/${orderId}/fulfillment-sheet`, { as: customer })).status, 403);
    assert.equal((await api(`/orders/${orderId}/fulfillment-sheet`, { as: null })).status, 401);
    assert.equal((await api(`/orders/${orderId}`, { as: other })).status, 403);
    const own = await api(`/orders/${orderId}`, { as: customer });
    assert.equal(own.body.data.totalPrice, undefined);
    assert.equal(own.body.data.orderItems[0].unitPrice, undefined);
    assert.equal(own.body.data.resolvedDelivery.details.contactName, "Reception");
    for (const body of [{ deliveryDetails: newDetails }, { expectedRevision: 2, deliveryDetails: { googleMapsUrl: "javascript:bad" } }, { expectedRevision: 2, deliveryDetails: { phoneNumber: [] } }]) {
      assert.equal((await api(endpoint, { method: "PUT", body })).status, 400);
    }
    assert.equal((await api(`/orders/${orderId}`, { method: "PUT", body: { deliveryDetails: newDetails } })).status, 400);
  });
  await t.test("racing destination edits have one winner", async () => {
    const results = await Promise.all(["First", "Second"].map((contactName) => api(endpoint, { method: "PUT", body: { expectedRevision: 2, deliveryDetails: { ...newDetails, contactName } } })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await Order.findById(orderId)).deliveryRevision, 3);
  });
  await t.test("customer reassignment replaces the destination and preserves invoice locks", async () => {
    const changed = await api(`/orders/${second._id}`, { method: "PUT", body: { user: String(other._id) } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const reset = await Order.findById(second._id);
    assert.equal(reset.deliveryDetails.address, "Other destination");
    assert.equal(reset.deliveryDetails.phoneNumber, "shared-recipient");
    assert.equal(reset.deliveryRevision, 2);
    await Order.collection.updateOne({ _id: second._id }, { $set: { invoice: new mongoose.Types.ObjectId() } });
    assert.equal((await api(`/orders/${second._id}`, { method: "PUT", body: { user: String(customer._id) } })).status, 400);
  });
  await t.test("legacy defaults need explicit capture; saved blanks and completed history are preserved", async () => {
    const legacy = await Order.create({ user: customer._id, status: "Shipping", orderItems: [{ product, sku: "SKU1", qty: 1, unitPrice: 1 }] });
    let result = await api(`/orders/${legacy._id}`);
    assert.equal(result.body.data.resolvedDelivery.savedToOrder, false);
    assert.equal(result.body.data.resolvedDelivery.details.address, "New default");
    const sheet = await api(`/orders/${legacy._id}/fulfillment-sheet`);
    assert.ok(sheet.body.data.problems.some((p) => p.includes("save the delivery")));
    assert.equal((await Order.findById(legacy._id)).deliveryDetails, undefined);
    result = await api(`/orders/${legacy._id}/delivery-details`, { method: "PUT", body: { expectedRevision: 0, deliveryDetails: {} } });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.resolvedDelivery.details.address, "");
    assert.equal(result.body.data.resolvedDelivery.savedToOrder, true);
    await Order.collection.updateOne({ _id: legacy._id }, { $unset: { deliveryDetails: "", deliveryRevision: "" }, $set: { status: "Delivered" } });
    assert.equal((await api(`/orders/${legacy._id}`)).body.data.resolvedDelivery.details, null);
    assert.equal((await api(`/orders/${legacy._id}/fulfillment-sheet`)).status, 409);
    assert.equal((await api(`/orders/${legacy._id}/delivery-details`, { method: "PUT", body: { expectedRevision: 0, deliveryDetails: newDetails } })).status, 409);
    await Order.collection.updateOne({ _id: legacy._id }, { $set: { status: "Cancelled" } });
    assert.equal((await api(`/orders/${legacy._id}/fulfillment-sheet`)).status, 409);
  });
});
