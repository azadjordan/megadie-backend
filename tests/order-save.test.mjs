import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Order from '../models/orderModel.js';

const item = () => ({ product: new mongoose.Types.ObjectId(), sku: 'SAVE-CHECK', qty: 10, unitPrice: 12, lineTotal: 120 });
const projection = { status: 1, orderItems: 1, allocationStatus: 1, stockFinalizedAt: 1 };

test('projected metadata validation preserves unloaded totals, fees and delivery dates', async () => {
  const order = Order.hydrate({ _id: new mongoose.Types.ObjectId(), status: 'Delivered', orderItems: [item()], allocationStatus: 'Allocated' }, projection);
  await order.validate();
  for (const field of ['deliveredAt', 'totalPrice', 'orderItems']) assert.equal(order.isModified(field), false, field);
});

test('a projected price edit requires loading all pricing inputs', async () => {
  const order = Order.hydrate({ _id: new mongoose.Types.ObjectId(), status: 'Shipping', orderItems: [item()] }, projection);
  order.orderItems[0].qty = 11;
  await assert.rejects(order.validate(), /Load order items and fees/);
});

test('complete pricing inputs calculate totals and preserve an existing delivery timestamp', async () => {
  const deliveredAt = new Date('2026-11-17T10:00:00Z');
  const order = new Order({ user: new mongoose.Types.ObjectId(), status: 'Delivered', deliveredAt, orderItems: [item()], deliveryCharge: 10, extraFee: 5 });
  await order.validate(); assert.equal(order.totalPrice, 135); assert.deepEqual(order.deliveredAt, deliveredAt);
});

test('editing a fully loaded existing order still recalculates item and order totals', async () => {
  const order = Order.hydrate({ _id: new mongoose.Types.ObjectId(), user: new mongoose.Types.ObjectId(), orderNumber: 'ORDER-EDIT-CHECK', status: 'Shipping', orderItems: [item()], deliveryCharge: 10, extraFee: 5, totalPrice: 135 });
  order.orderItems[0].qty = 11;
  await order.validate();
  assert.equal(order.orderItems[0].lineTotal, 132); assert.equal(order.totalPrice, 147);
});
