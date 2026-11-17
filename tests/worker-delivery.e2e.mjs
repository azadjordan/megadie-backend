// Real cookies, APIs and MongoDB transactions; all traffic is redirected to this
// disposable local server. Never imports server.js or loads the development .env.
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { chromium } from "playwright";
import User from "../models/userModel.js";
import Order from "../models/orderModel.js";
import Product from "../models/productModel.js";
import Slot from "../models/slotModel.js";
import SlotItem from "../models/slotItemModel.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import userRoutes from "../routes/userRoutes.js";
import packingRoutes from "../routes/packingRoutes.js";
import orderRoutes from "../routes/orderRoutes.js";
import siteSettingsRoutes from "../routes/siteSettingsRoutes.js";
import { errorHandler } from "../middleware/errorMiddleware.js";

const uri = process.env.WORKER_DELIVERY_E2E_URI, frontend = 'http://localhost:5173';
test('admin assigns a separate driver while workers only pack and record delivery events', { skip: !uri, timeout: 60000 }, async t => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/megadie_worker_delivery_e2e_test(?:\?|$)/);
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'isolated-driver-e2e';
  await mongoose.connect(uri, { autoIndex: false }); await mongoose.connection.dropDatabase();
  let browser, server;
  t.after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  await OrderAllocation.createIndexes();
  const makeUser = (name, values = {}) => User.create({ name, email: name + '@test.invalid', phoneNumber: name, password: 'test-password', approvalStatus: 'Approved', ...values });
  const admin = await makeUser('Owner', { isAdmin: true });
  const packer = await makeUser('Ahmed', { isWorker: true }), driver = await makeUser('Omar', { isWorker: true }), customer = await makeUser('Client');
  const productId = new mongoose.Types.ObjectId();
  await Product.collection.insertOne({ _id: productId, name: 'Ribbon', sku: 'RIB-TEST', packingUnit: '100yd Roll', cbm: 1 });
  const slot = await Slot.create({ store: 'AE1', unit: 'A', position: 1, cbm: 1000 });
  await SlotItem.collection.insertOne({ product: productId, slot: slot._id, qty: 20, cbm: 20 });
  const order = await Order.create({ user: customer._id, status: 'Shipping', orderItems: [{ product: productId, sku: 'RIB-TEST', qty: 10, unitPrice: 12 }], allocationStatus: 'Allocated', packingWorker: packer._id, packingSentAt: new Date(), packedAt: new Date(), packedBy: packer._id, preparationMode: 'prepare_only', deliveryWorker: null, deliveryDetails: { contactName: 'Warehouse recipient', address: 'Al Ain warehouse', phoneNumber: '+971501234567', notes: 'Side entrance' }, totalPrice: 120 });
  await OrderAllocation.create({ order: order._id, product: productId, slot: slot._id, qty: 10, pickedQty: 10, by: packer._id });
  const app = express(); app.use(cors({ origin: frontend, credentials: true }), express.json(), cookieParser());
  app.use('/api/users', userRoutes); app.use('/api/packing', packingRoutes); app.use('/api/orders', orderRoutes); app.use('/api/site-settings', siteSettingsRoutes); app.use(errorHandler);
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  browser = await chromium.launch({ headless: true });
  async function login(user) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) return route.continue({ url: 'http://localhost:' + server.address().port + url.pathname + url.search });
      return url.origin === frontend ? route.continue() : route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => assert.fail(error.message));
    if (user.isAdmin) {
      const response = await context.request.post('http://localhost:' + server.address().port + '/api/users/auth', { headers: { Origin: frontend }, data: { email: user.email, password: 'test-password' } });
      assert.equal(response.status(), 200); await page.goto(frontend + '/packing');
    } else {
      await page.goto(frontend + '/login'); await page.getByLabel('Email', { exact: true }).fill(user.email); await page.getByLabel('Password', { exact: true }).fill('test-password'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    }
    await page.getByRole('heading', { name: 'My work', exact: true }).waitFor();
    return page;
  }
  const packingPage = await login(packer);
  await packingPage.getByText('Waiting for delivery assignment', { exact: true }).waitFor();
  assert.equal(await packingPage.getByRole('button', { name: /Assign delivery|Change delivery worker/ }).count(), 0);
  const ownerPage = await login(admin);
  await ownerPage.getByRole('button', { name: 'Assign delivery', exact: true }).click();
  const assignment = ownerPage.getByRole('dialog'); await assignment.getByLabel('Delivery worker', { exact: true }).selectOption(String(driver._id));
  await assignment.getByRole('button', { name: 'Save delivery assignment' }).click(); await assignment.waitFor({ state: 'hidden' });
  assert.equal(String((await Order.findById(order._id)).deliveryWorker), String(driver._id));
  const deliveryPage = await login(driver);
  await deliveryPage.getByRole('link', { name: 'View delivery', exact: true }).click();
  await deliveryPage.getByText('Warehouse recipient', { exact: true }).waitFor();
  assert.equal(await deliveryPage.getByRole('link', { name: 'Get directions', exact: true }).count(), 1);
  assert.equal(await deliveryPage.getByRole('button', { name: 'Mark packed', exact: true }).count(), 0);
  assert.equal(await deliveryPage.getByRole('button', { name: /Assign delivery|Change delivery worker/ }).count(), 0);
  await deliveryPage.getByRole('button', { name: 'Mark out for delivery', exact: true }).click();
  let dialog = deliveryPage.getByRole('dialog'); await dialog.getByRole('button', { name: 'Mark out for delivery', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  let saved = await Order.findById(order._id); assert.equal(saved.status, 'Shipping'); assert.ok(saved.deliveryMovement.departedAt); assert.equal(saved.deliveryMovement.handler, 'Omar');
  await deliveryPage.getByRole('button', { name: 'Mark delivered', exact: true }).click();
  await dialog.getByRole('button', { name: 'Mark delivered', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await deliveryPage.getByText('Delivered', { exact: true }).waitFor();
  saved = await Order.findById(order._id).select('+deliveryHistory');
  assert.equal(saved.status, 'Delivered'); assert.equal(String(saved.packingWorker), String(packer._id)); assert.equal(saved.deliveredBy, 'Omar');
  assert.deepEqual(saved.deliveryHistory.map(event => event.action), ['assigned', 'departed', 'delivered']);
  assert.equal((await OrderAllocation.findOne({ order: order._id })).pickedQty, 10);
  assert.equal((await SlotItem.findOne({ product: productId, slot: slot._id })).qty, 20); assert.equal(saved.stockFinalizedAt, undefined);
  await deliveryPage.screenshot({ path: '../output/worker-delivery-real-e2e-mobile.png', fullPage: true });
});
