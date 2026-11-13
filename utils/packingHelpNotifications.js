import crypto from "node:crypto";
import mongoose from "mongoose";
import Order from "../models/orderModel.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import { activePackingHelp } from "./packingHelpState.js";
import { reservationId as id, isReserved } from "./orderReservationPlan.js";
import sendTelegramAlert from "./sendTelegramAlert.js";
import { transaction } from "./orderReservations.js";

export function packingHelpMessage(order, request, rows, frontend = process.env.FRONTEND_URL || "https://www.megadie.com") {
  const productId = id(request.product);
  const ordered = order.orderItems.filter(item => id(item.product) === productId).reduce((sum, item) => sum + item.qty, 0);
  const allocations = rows.filter(row => isReserved(row) && id(row.product) === productId);
  const picked = allocations.reduce((sum, row) => sum + (row.pickedQty || 0), 0);
  const unit = String(allocations.find(row => row.product?.packingUnit)?.product.packingUnit || 'units').slice(0, 80);
  const affected = allocations.filter(row => row.pickProblem && row.qty > (row.pickedQty || 0));
  const lines = affected.slice(0, 12).map(row => `${String(row.slot?.label || 'Unknown slot').slice(0, 120)}: ${row.pickedQty || 0} picked of ${row.qty}; ${row.qty - (row.pickedQty || 0)} missing`);
  if (affected.length > 12) lines.push(`+ ${affected.length - 12} other locations; open the order for details.`);
  const reports = (order.packingReports || []).filter(report => id(report.product) === productId);
  const notes = [...new Set(reports.map(report => report.note).filter(Boolean))].slice(-3).join(' | ');
  const url = new URL('/admin/orders/' + id(order) + '/packing', frontend).href;
  return [
    'Packing needs admin help',
    `Client: ${String(order.user?.name || 'Unknown client').slice(0, 180)}`,
    `Order: ${order.orderNumber}`,
    `Product: ${String(request.sku || 'Unknown SKU').slice(0, 180)}`,
    `Worker: ${String(request.requestedByName || 'Worker').slice(0, 120)}`,
    `Ordered: ${ordered} · Picked: ${picked} · Remaining: ${Math.max(0, ordered - picked)} (${unit})`,
    `Reported missing: ${affected.reduce((sum, row) => sum + row.qty - (row.pickedQty || 0), 0)}`,
    ...lines,
    request.reason === 'worker_requested' ? 'Worker could not use the suggested replacement locations.' : 'No available replacement location remains.',
    ...(notes || request.note ? ['Note: ' + (notes || request.note).slice(0, 650)] : []),
    'Open packing order: ' + url,
  ].join('\n');
}

// The order document is a small durable outbox. Claiming a request prevents two
// app processes from sending it concurrently; expired claims survive restarts.
export async function dispatchPackingHelpNotifications({ send = message => sendTelegramAlert(message, { plainText: true, strict: true }), now: fixedNow, limit = 10 } = {}) {
  let processed = 0;
  for (let index = 0; index < limit; index++) {
    const now = fixedNow || new Date();
    const claim = crypto.randomUUID();
    const due = { resolvedAt: null, 'notification.sentAt': null, 'notification.nextAttemptAt': { $lte: now }, $or: [{ 'notification.leaseUntil': null }, { 'notification.leaseUntil': { $lte: now } }] };
    const order = await Order.findOneAndUpdate(
      { status: 'Shipping', packingSentAt: { $ne: null }, stockFinalizedAt: null, packingHelp: { $elemMatch: due } },
      { $set: { 'packingHelp.$.notification.claim': claim, 'packingHelp.$.notification.leaseUntil': new Date(now.getTime() + 60000) }, $inc: { 'packingHelp.$.notification.attempts': 1 } },
      { new: true, timestamps: false },
    ).select('_id +packingHelp').lean();
    if (!order) break;
    const request = order.packingHelp.find(request => request.notification?.claim === claim);
    const filter = { _id: order._id, packingHelp: { $elemMatch: { _id: request._id, 'notification.claim': claim } } };
    const unset = { 'packingHelp.$.notification.claim': '', 'packingHelp.$.notification.leaseUntil': '' };
    try {
      // Read one consistent, fresh snapshot. An admin may have changed items
      // since the delivery claim; never combine old targets with new allocations.
      const context = await transaction(async session => {
        const current = await Order.findById(order._id).select('user orderNumber orderItems status packingSentAt stockFinalizedAt +packingHelp +packingReports').populate('user', 'name').session(session).lean();
        const rows = await OrderAllocation.find({ order: order._id, status: { $ne: 'Cancelled' } }).populate('slot', 'label').populate('product', 'packingUnit').session(session).lean();
        return { order: current, rows };
      });
      const currentRequest = context.order?.packingHelp.find(current => id(current) === id(request));
      if (!context.order || !activePackingHelp(context.order, context.rows).some(active => id(active) === id(request))) {
        await Order.updateOne(filter, { $set: { 'packingHelp.$.resolvedAt': now }, $unset: unset }, { timestamps: false });
        continue;
      }
      if (await send(packingHelpMessage(context.order, currentRequest, context.rows)) !== true) throw new Error('Telegram did not accept the message.');
      await Order.updateOne(filter, { $set: { 'packingHelp.$.notification.sentAt': now }, $unset: { ...unset, 'packingHelp.$.notification.lastError': '' } }, { timestamps: false });
    } catch {
      const delays = [30000, 120000, 600000, 1800000, 3600000];
      const delay = delays[Math.min((request.notification?.attempts || 1) - 1, delays.length - 1)];
      await Order.updateOne(filter, { $set: { 'packingHelp.$.notification.nextAttemptAt': new Date(now.getTime() + delay), 'packingHelp.$.notification.lastError': 'Telegram delivery failed; queued for retry.' }, $unset: unset }, { timestamps: false });
      console.error('Packing help alert queued for retry:', id(order), id(request));
    }
    processed++;
  }
  return processed;
}

let started = false, running = false;
export function queuePackingHelpNotifications() {
  if (!started || running || mongoose.connection.readyState !== 1) return;
  running = true;
  void dispatchPackingHelpNotifications().catch(() => console.error('Could not process pending packing help alerts.')).finally(() => { running = false; });
}
export function startPackingHelpNotifications() {
  if (started) return;
  started = true;
  const timer = setInterval(queuePackingHelpNotifications, 15000);
  timer.unref();
  queuePackingHelpNotifications();
}
