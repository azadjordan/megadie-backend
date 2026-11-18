// Explicit local test URI only. Never loads .env or connects to the development database.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import mongoose from "mongoose";
import express from "express";
import cookieParser from "cookie-parser";
import { testSessionCookies } from "./helpers/sessionCookie.mjs";
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
import { saveCustomerProfile } from "../utils/customerLocation.js";

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
  const sessionCookie = testSessionCookies();
  async function api(path, { as = admin, method = "GET", body } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (as) headers.Cookie = await sessionCookie(as);
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
    const update = await api("/users/account/profile", { as: customer, method: "PUT", body: { address: "New default", expectedCustomerLocation: { address: "Default destination", googleMapsUrl: "" }, deliveryContactName: "Usual desk", deliveryPhoneNumber: "shared-recipient" } });
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
    assert.ok(result.body.data.problems.includes("Assign this order before copying."));
    assert.equal(result.body.data.customerName, "Alpha Beta Company");
    assert.equal(result.body.data.label, "Alpha Beta Company — 023AD");
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
    const results = await Promise.all(["First", "Second"].map((contactName) => api(endpoint, { method: "PUT", body: { expectedRevision: 2, deliveryDetails: { ...newDetails, contactName }, assignedTo: contactName } })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const winner = await Order.findById(orderId);
    assert.equal(winner.deliveryRevision, 3);
    assert.equal(winner.assignedTo, winner.deliveryDetails.contactName);
  });
  await t.test("assignment saves on the order, survives Courier edits, cannot be cleared, and stays admin-only", async () => {
    const assigned = await api(endpoint, { method: "PUT", body: { expectedRevision: 3, deliveryDetails: newDetails, assignedTo: "  Ahmed  " } });
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.data.assignedTo, "Ahmed");
    assert.equal((await Order.findById(orderId)).assignedTo, "Ahmed");
    assert.equal((await api(`/orders/${orderId}`)).body.data.assignedTo, "Ahmed");
    assert.equal((await api(`/orders/${orderId}/fulfillment-sheet`)).body.data.assignedTo, "Ahmed");
    assert.equal((await api(`/orders/${orderId}`, { as: customer })).body.data.assignedTo, undefined);
    const ownList = await api("/orders/my", { as: customer });
    assert.equal(ownList.body.data.find((row) => row._id === orderId).assignedTo, undefined);
    const courierEdit = await api(endpoint, { method: "PUT", body: { expectedRevision: 4, deliveryDetails: { ...newDetails, notes: "Courier-only edit" } } });
    assert.equal(courierEdit.status, 200);
    assert.equal(courierEdit.body.data.assignedTo, "Ahmed", "Omission must not clear the saved assignee");
    assert.equal((await api(endpoint, { as: customer, method: "PUT", body: { expectedRevision: 5, deliveryDetails: newDetails, assignedTo: "Unauthorized" } })).status, 403);
    assert.equal((await api(`/orders/${orderId}`, { method: "PUT", body: { assignedTo: "Bypass" } })).status, 400);
    for (const assignedTo of [null, "", "   ", 123, {}, "x".repeat(121)]) {
      assert.equal((await api(endpoint, { method: "PUT", body: { expectedRevision: 5, deliveryDetails: newDetails, assignedTo } })).status, 400);
    }
    assert.equal((await Order.findById(orderId)).deliveryRevision, 5);
    const cleared = await api(endpoint, { method: "PUT", body: { expectedRevision: 5, deliveryDetails: newDetails, assignedTo: "  " } });
    assert.equal(cleared.status, 400);
    assert.equal((await Order.findById(orderId)).deliveryRevision, 5);
    assert.equal((await api(`/orders/${orderId}/fulfillment-sheet`)).body.data.assignedTo, "Ahmed");
    const replaced = await api(endpoint, { method: "PUT", body: { expectedRevision: 5, deliveryDetails: newDetails, assignedTo: "Samir" } });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.data.assignedTo, "Samir");
    assert.equal((await Order.findById(second._id)).assignedTo, "");
    assert.equal((await User.findById(customer._id)).phoneNumber, "client-phone");
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
    const legacy = await Order.create({ user: customer._id, status: "Shipping", preparationMode: "prepare_deliver", orderItems: [{ product, sku: "SKU1", qty: 1, unitPrice: 1 }] });
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
    await api(`/orders/${legacy._id}/delivery-details`, { method: "PUT", body: { expectedRevision: 1, deliveryDetails: { address: "Location only" }, assignedTo: "Ahmed" } });
    await OrderAllocation.collection.insertOne({ order: legacy._id, product, slot: slots[0], qty: 1, status: "Reserved" });
    const locationOnly = await api(`/orders/${legacy._id}/fulfillment-sheet`);
    assert.deepEqual(locationOnly.body.data.problems, []);
    assert.deepEqual(locationOnly.body.data.delivery.missingFields, []);
    assert.equal(locationOnly.body.data.picks[0].name, undefined);
    const courier = await api(`/orders/${legacy._id}`);
    assert.deepEqual(courier.body.data.resolvedDelivery.missingFields, ["contactName", "phoneNumber"]);
    await Order.collection.updateOne({ _id: legacy._id }, { $unset: { deliveryDetails: "", deliveryRevision: "" }, $set: { status: "Delivered" } });
    assert.equal((await api(`/orders/${legacy._id}`)).body.data.resolvedDelivery.details, null);
    assert.equal((await api(`/orders/${legacy._id}/fulfillment-sheet`)).status, 409);
    assert.equal((await api(`/orders/${legacy._id}/delivery-details`, { method: "PUT", body: { expectedRevision: 0, deliveryDetails: newDetails, assignedTo: "Closed" } })).status, 409);
    await Order.collection.updateOne({ _id: legacy._id }, { $set: { status: "Cancelled" } });
    assert.equal((await api(`/orders/${legacy._id}/fulfillment-sheet`)).status, 409);
  });
  await t.test("task modes and explicit customer defaults save safely without changing other orders", async () => {
    const task = await Order.create({ user: customer._id, status: "Shipping", orderItems: [{ product, sku: "SKU1", qty: 1, unitPrice: 1 }] });
    await OrderAllocation.collection.insertOne({ order: task._id, product, slot: slots[0], qty: 1, status: "Reserved" });
    const path = `/orders/${task._id}/delivery-details`;
    const body = { expectedRevision: 0, preparationMode: "prepare_only", assignedTo: "Ahmed", deliveryDetails: {} };
    for (const patch of [{ preparationMode: "invalid" }, { assignedTo: " " }, { saveCustomerLocation: "yes" }, { saveCustomerLocation: true }]) {
      assert.equal((await api(path, { method: "PUT", body: { ...body, ...patch } })).status, 400);
    }
    assert.equal((await api(path, { method: "PUT", body })).status, 200);
    let sheet = (await api(`/orders/${task._id}/fulfillment-sheet`)).body.data;
    assert.equal(sheet.preparationMode, "prepare_only");
    assert.deepEqual(sheet.problems, []);
    const customerBefore = await User.findById(customer._id).lean();
    const originalOtherDestination = (await Order.findById(orderId)).deliveryDetails.address;
    const defaults = { address: "Reusable destination", googleMapsUrl: "https://maps.app.goo.gl/reusable" };
    const request = { expectedRevision: 1, preparationMode: "prepare_deliver", assignedTo: "Ahmed", deliveryDetails: defaults, saveCustomerLocation: true, expectedCustomerLocation: sheet.customerLocation };
    assert.equal((await api(path, { method: "PUT", body: { ...request, deliveryDetails: {} } })).status, 400);
    assert.equal((await api(path, { method: "PUT", body: { ...request, expectedCustomerLocation: undefined } })).status, 400);
    assert.equal((await api(path, { method: "PUT", body: { ...request, expectedRevision: 0 } })).status, 409);
    assert.equal((await User.findById(customer._id)).address, customerBefore.address);
    const saved = await api(path, { method: "PUT", body: request });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.preparationMode, "prepare_deliver");
    const customerAfter = await User.findById(customer._id).lean();
    assert.equal(customerAfter.address, defaults.address);
    assert.equal(customerAfter.deliveryGoogleMapsUrl, defaults.googleMapsUrl);
    for (const key of ["phoneNumber", "deliveryPhoneNumber", "deliveryContactName", "deliveryNotes"]) assert.equal(customerAfter[key], customerBefore[key]);
    assert.equal((await Order.findById(orderId)).deliveryDetails.address, originalOtherDestination);
    sheet = (await api(`/orders/${task._id}/fulfillment-sheet`)).body.data;
    assert.deepEqual(sheet.customerLocation, defaults);
    assert.deepEqual(sheet.problems, []);
    const newQuote = await Quote.create({ user: customer._id, status: "Confirmed", requestedItems: [{ product, qty: 1, unitPrice: 10 }] });
    const newOrder = await api(`/orders/from-quote/${newQuote._id}`, { method: "POST" });
    assert.equal(newOrder.status, 201);
    assert.equal(newOrder.body.deliveryDetails.address, defaults.address);
    assert.equal(newOrder.body.deliveryDetails.googleMapsUrl, defaults.googleMapsUrl);
    // A concurrent customer-profile edit must roll back the order part of the save too.
    await User.updateOne({ _id: customer._id }, { $set: { address: "Changed by another admin" } });
    const stale = await api(path, { method: "PUT", body: { ...request, expectedRevision: 2, expectedCustomerLocation: defaults, assignedTo: "Do not persist" } });
    assert.equal(stale.status, 409);
    const unchanged = await Order.findById(task._id);
    assert.equal(unchanged.deliveryRevision, 2);
    assert.equal(unchanged.assignedTo, "Ahmed");
    assert.equal((await User.findById(customer._id)).address, "Changed by another admin");
    const own = (await api(`/orders/${task._id}`, { as: customer })).body.data;
    assert.equal(own.preparationMode, undefined);
    assert.equal((await api(`/orders/${task._id}`, { method: "PUT", body: { preparationMode: "prepare_only" } })).status, 400);
    // Courier edits omit mode and keep the selected task and customer defaults intact.
    assert.equal((await api(path, { method: "PUT", body: { expectedRevision: 2, deliveryDetails: { address: "One-off address" } } })).status, 200);
    assert.equal((await Order.findById(task._id)).preparationMode, "prepare_deliver");
    assert.equal((await User.findById(customer._id)).address, "Changed by another admin");
  });

  await t.test("courier-only saves can update defaults atomically without changing packing assignment or other orders", async () => {
    const before = await User.findById(customer._id).lean();
    const originalOtherOrder = (await Order.findById(orderId)).deliveryDetails.toObject();
    const task = await Order.create({ user: customer._id, status: "Shipping", packingSentAt: new Date(), packedAt: new Date(), packingWorker: admin._id,
      orderItems: [{ product, sku: "SKU1", qty: 1, unitPrice: 1 }], deliveryDetails: newDetails, deliveryRevision: 1 });
    const next = { ...newDetails, address: "Future warehouse", googleMapsUrl: "https://maps.app.goo.gl/warehouse" };
    const request = { expectedRevision: 1, deliveryDetails: next, saveCustomerLocation: true,
      expectedCustomerLocation: { address: before.address || "", googleMapsUrl: before.deliveryGoogleMapsUrl || "" } };
    assert.equal((await api(`/orders/${task._id}/delivery-details`, { method: "PUT", body: request })).status, 200);
    const saved = await Order.findById(task._id);
    assert.equal(saved.deliveryDetails.address, next.address);
    assert.equal(String(saved.packingWorker), String(admin._id));
    const profile = await User.findById(customer._id);
    assert.equal(profile.address, next.address);
    for (const key of ["phoneNumber", "deliveryContactName", "deliveryPhoneNumber", "deliveryNotes"]) assert.equal(profile[key], before[key]);
    assert.deepEqual((await Order.findById(orderId)).deliveryDetails.toObject(), originalOtherOrder);
    const stale = await api(`/orders/${task._id}/delivery-details`, { method: "PUT", body: { ...request, expectedRevision: 2, deliveryDetails: { ...next, address: "Stale", googleMapsUrl: "" } } });
    assert.equal(stale.status, 409);
    assert.equal((await Order.findById(task._id)).deliveryRevision, 2);
    await Order.updateOne({ _id: task._id }, { $set: { status: "Delivered" } });
    assert.equal((await api(`/orders/${task._id}/delivery-details`, { method: "PUT", body: { ...request, expectedRevision: 2 } })).status, 409);
    assert.equal((await User.findById(customer._id)).address, next.address);
  });

  await t.test("profiles validate location pairs, reject stale forms, and require review of retained map pins", async () => {
    const owner = await User.create({ name: "Location test", email: "location@test.invalid", phoneNumber: "location-phone", password: "test-password", approvalStatus: "Approved", address: "A", deliveryGoogleMapsUrl: "https://maps.app.goo.gl/a" });
    const base = { address: "A", googleMapsUrl: "https://maps.app.goo.gl/a" };
    const path = `/users/${owner._id}`;
    assert.equal((await api(path, { method: "PUT", body: { address: "B" } })).status, 400);
    assert.equal((await api(path, { method: "PUT", body: { address: "B", expectedCustomerLocation: base } })).status, 400);
    assert.equal((await api(path, { method: "PUT", body: { deliveryGoogleMapsUrl: "http://maps.invalid", expectedCustomerLocation: base } })).status, 400);
    assert.equal((await api(path, { method: "PUT", body: { address: "x".repeat(2001), deliveryGoogleMapsUrl: "", expectedCustomerLocation: base } })).status, 400);
    const changed = { address: "B", deliveryGoogleMapsUrl: base.googleMapsUrl, confirmedMapLocation: true, expectedCustomerLocation: base };
    assert.equal((await api(path, { method: "PUT", body: changed })).status, 200);
    assert.equal((await api(path, { method: "PUT", body: { name: "Must not persist", address: "A", deliveryGoogleMapsUrl: base.googleMapsUrl, expectedCustomerLocation: base } })).status, 409);
    assert.equal((await User.findById(owner._id)).name, "Location test");
    assert.equal((await api(path, { method: "PUT", body: { name: "Unrelated change" } })).status, 200);
    assert.equal((await User.findById(owner._id)).address, "B");
    const expected = { address: "B", googleMapsUrl: base.googleMapsUrl };
    assert.equal((await api("/users/account/profile", { as: owner, method: "PUT", body: { address: "C", expectedCustomerLocation: expected } })).status, 400);
    assert.equal((await api("/users/account/profile", { as: owner, method: "PUT", body: { address: "C", deliveryGoogleMapsUrl: "", expectedCustomerLocation: expected } })).status, 200);
    assert.equal((await User.findById(owner._id)).deliveryGoogleMapsUrl, "");

    // Both documents were read before a competing save. The database predicate,
    // rather than only the initial comparison, must reject the stale write.
    const first = await User.findById(owner._id), second = await User.findById(owner._id);
    const old = { address: "C", googleMapsUrl: "" };
    await saveCustomerProfile(second, { address: "D", deliveryGoogleMapsUrl: "", expectedCustomerLocation: old });
    first.name = "Racing name";
    await assert.rejects(saveCustomerProfile(first, { address: "E", deliveryGoogleMapsUrl: "", expectedCustomerLocation: old }), error => error.statusCode === 409);
    assert.equal((await User.findById(owner._id)).address, "D");
    assert.equal((await User.findById(owner._id)).name, "Unrelated change");
  });

});
