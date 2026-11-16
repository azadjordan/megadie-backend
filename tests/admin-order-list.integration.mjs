// Read routes against an explicitly named disposable local DB. Never loads .env.
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import express from 'express';
import cookieParser from 'cookie-parser';
import User from '../models/userModel.js';
import Order from '../models/orderModel.js';
import Invoice from '../models/invoiceModel.js';
import OrderAllocation from '../models/orderAllocationModel.js';
import orderRoutes from '../routes/orderRoutes.js';
import { activePackingHelp } from '../utils/packingHelpState.js';
import { errorHandler } from '../middleware/errorMiddleware.js';
import { testSessionCookies } from './helpers/sessionCookie.mjs';

const uri = process.env.ADMIN_LIST_TEST_URI;
test('admin order list facts, shortcuts and legacy filters agree across all pages', { skip: !uri, timeout: 60000 }, async t => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/megadie_admin_list_test(?:\?|$)/);
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'isolated-admin-list-tests';
  await mongoose.connect(uri, { autoIndex: false }); await mongoose.connection.dropDatabase();
  let server;
  t.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  const user = (name, flags = {}) => User.create({ name, email: name + '@test.invalid', password: 'test-password', phoneNumber: name, approvalStatus: 'Approved', ...flags });
  const owner = await user('Owner', { isAdmin: true }), worker = await user('Worker', { isWorker: true }), customer = await user('Client');
  const oid = () => new mongoose.Types.ObjectId(), product = oid(), slot = oid();
  const created = [], expected = new Map();
  async function fixture(name, action, { status = 'Shipping', allocated = true, published = false, packed = false, billed = false, payment = 'Unpaid', balance = 1000, finalized = false, help = false, short = false, checked = false, report = false, invoiceMissing = false, cancelledInvoice = false, missingAllocationStatus = false } = {}) {
    const id = oid(), invoice = billed || invoiceMissing ? oid() : null;
    const order = { _id: id, user: customer._id, orderNumber: name, createdAt: new Date(2026, 10, 14, 10, created.length), status, allocationStatus: allocated ? 'Allocated' : 'Unallocated', orderItems: [{ product, sku: 'RIB-RED', qty: 37, unitPrice: 2.5 }], invoice,
      ...(published ? { packingSentAt: new Date(), packingWorker: worker._id, assignedTo: worker.name } : {}), ...(packed ? { packedAt: new Date() } : {}), ...(finalized ? { stockFinalizedAt: new Date() } : {}),
      ...(help ? { packingHelp: [{ _id: oid(), product, requestedAt: new Date(), notification: { lastError: 'PRIVATE' } }, { _id: oid(), product, requestedAt: new Date() }] } : {}),
      ...(report ? { packingReports: [{ _id: oid(), product, checkedAt: checked ? new Date() : null }] } : {}),
    };
    await Order.collection.insertOne(order);
    if (allocated) await OrderAllocation.collection.insertOne({ order: id, product, slot, qty: 37, pickedQty: short ? 7 : packed ? 37 : 0, pickProblem: short, ...(missingAllocationStatus ? {} : { status: finalized ? 'Deducted' : 'Reserved' }) });
    if (billed) await Invoice.collection.insertOne({ _id: invoice, order: id, user: customer._id, status: cancelledInvoice ? 'Cancelled' : 'Issued', invoiceNumber: 'INV-' + name, paymentStatus: payment, amountMinor: balance === 0 ? 0 : 1000, paidTotalMinor: payment === 'PartiallyPaid' ? 500 : 0, balanceDueMinor: balance, currency: 'AED', minorUnitFactor: 100 });
    created.push(order); expected.set(name, action); return order;
  }
  await fixture('PROCESSING', 'mark-shipping', { status: 'Processing', allocated: false });
  await fixture('RESERVE', 'reserve-stock', { allocated: false });
  await fixture('ASSIGN', 'send-worker');
  await fixture('PICKING', 'view-packing', { published: true });
  await fixture('WORKER-SHORTAGE', 'view-packing', { published: true, short: true, report: true });
  await fixture('HELP-A', 'review-help', { published: true, short: true, help: true, report: true });
  await fixture('HELP-B', 'review-help', { published: true, short: true, help: true, missingAllocationStatus: true });
  await fixture('STALE-HELP', 'view-packing', { published: true, help: true });
  await fixture('PACKED', 'create-invoice', { published: true, packed: true });
  await fixture('DELIVER', 'mark-delivered', { published: true, packed: true, billed: true });
  await fixture('DELIVERED-NO-INVOICE', 'create-invoice', { status: 'Delivered' });
  await fixture('FINALIZE', 'finalize-stock', { status: 'Delivered', billed: true, report: true });
  await fixture('COMPLETE', null, { status: 'Delivered', billed: true, finalized: true, report: true, checked: true });
  await fixture('CANCELLED', null, { status: 'Cancelled', report: true, help: true });
  await fixture('CANCELLED-INVOICE', 'open-order', { billed: true, cancelledInvoice: true });
  await fixture('BROKEN-INVOICE', 'open-order', { invoiceMissing: true });
  await fixture('ZERO', 'mark-delivered', { published: true, packed: true, billed: true, balance: 0 });
  await fixture('LEGACY-INVOICE', 'mark-delivered', { billed: true, payment: 'PartiallyPaid', balance: 500 });
  await fixture('FINALIZED-PROCESSING', 'open-order', { status: 'Processing', finalized: true });
  await fixture('PACKED-RESERVATIONS', 'open-order', { published: true, packed: true, allocated: false });
  await fixture('BAD-DELIVERED', 'open-order', { status: 'Delivered', published: true });
  const app = express(); app.use(cookieParser()); app.use('/api/orders', orderRoutes); app.use(errorHandler);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const cookieFor = testSessionCookies(), base = 'http://127.0.0.1:' + server.address().port + '/api/orders';
  async function get(query = '', actor = owner) { const response = await fetch(base + query, { headers: { Cookie: await cookieFor(actor) } }); return { status: response.status, body: await response.json() }; }
  const all = await get('?limit=100'); assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(all.body.data.length, created.length);
  for (const row of all.body.data) {
    assert.equal(row.listAction, expected.get(row.orderNumber), row.orderNumber);
    const source = created.find(order => String(order._id) === row._id);
    const allocations = await OrderAllocation.find({ order: source._id }).lean();
    const count = new Set(activePackingHelp(source, allocations).map(request => String(request.product))).size;
    assert.equal(row.helpRequestedItems, count, row.orderNumber);
    for (const field of ['packingHelp', 'packingReports', 'packingActivity', '_listInvoice', '_listHelpProducts', '_listHelpAllocations']) assert.equal(Object.hasOwn(row, field), false, field);
    assert.equal(JSON.stringify(row).includes('PRIVATE'), false);
  }
  const byCustomer = await get('?user=' + customer._id + '&limit=100');
  assert.equal(byCustomer.status, 200);
  assert.equal(byCustomer.body.pagination.total, created.length, 'Customer filter must retain ObjectId matching through aggregation');
  assert.equal((await get('?user=' + owner._id)).body.pagination.total, 0);
  assert.equal((await get('?user=invalid')).status, 400);
  const summary = await get('/work-summary'); assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.body.data.all, created.length);
  for (const key of ['needsAdmin', 'preparation', 'toInvoice', 'toDeliver', 'toFinalize', 'needsStockCheck']) {
    const first = await get('?work=' + key + '&limit=1');
    assert.equal(first.status, 200, key + JSON.stringify(first.body));
    assert.equal(first.body.pagination.total, summary.body.data[key], key);
    const gathered = [];
    for (let page = 1; page <= first.body.pagination.totalPages; page++) gathered.push(...(await get('?work=' + key + '&limit=1&page=' + page)).body.data);
    assert.equal(gathered.length, summary.body.data[key], key);
    if (['toInvoice', 'toDeliver', 'toFinalize'].includes(key)) assert.ok(gathered.every(row => row.listAction === ({ toInvoice: 'create-invoice', toDeliver: 'mark-delivered', toFinalize: 'finalize-stock' })[key]));
  }
  const due = await get('?paymentStatus=paymentDue&limit=100');
  assert.deepEqual(due.body.data.map(row => row.orderNumber).sort(), ['DELIVER', 'FINALIZE', 'LEGACY-INVOICE', 'COMPLETE'].sort());
  const noInvoice = await get('?work=noInvoice&limit=100'); assert.ok(noInvoice.body.data.some(row => row.orderNumber === 'PICKING'));
  const oldUnpaid = await get('?paymentStatus=notFullyPaid&limit=100'); assert.ok(oldUnpaid.body.data.some(row => row.orderNumber === 'ASSIGN')); assert.ok(oldUnpaid.body.data.some(row => row.orderNumber === 'ZERO'));
  const oldStock = await get('?work=needsStockDeduction&limit=100'); assert.ok(oldStock.body.data.some(row => row.orderNumber === 'DELIVERED-NO-INVOICE'));
  const combined = await get('?work=toDeliver&paymentStatus=paymentDue&search=LEGACY'); assert.equal(combined.body.pagination.total, 1); assert.equal(combined.body.data[0].orderNumber, 'LEGACY-INVOICE');
  assert.equal((await get('', worker)).status, 403); assert.equal((await get('', customer)).status, 403);
});
