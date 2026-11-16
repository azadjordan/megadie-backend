import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import Order from "../models/orderModel.js";
import User from "../models/userModel.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import { ReservationError } from "../utils/orderReservations.js";
import { getPackingView, sendToWorker, changePacking, reviewPackingReport, unassignPacking } from "../utils/orderPacking.js";
import { packingSummary, packingUnitSummary, packingReadyToFinish } from "../utils/packingState.js";
import { buildCartonLabel } from "../utils/orderDelivery.js";
import { activePackingHelp } from "../utils/packingHelpState.js";
import { queuePackingHelpNotifications } from "../utils/packingHelpNotifications.js";

const orderId = req => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ReservationError("Invalid order id.", 400);
  return req.params.id;
};
const handle = work => asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  try { await work(req, res); }
  catch (error) {
    if (!(error instanceof ReservationError)) throw error;
    res.status(error.statusCode).json({ message: error.message, code: "PACKING_REJECTED" });
  }
});

export const listPackingWorkers = handle(async (_req, res) => {
  const workers = await User.find({ isWorker: true }).select("name").sort({ name: 1, _id: 1 }).lean();
  res.json({ data: workers });
});

export const listPackingOrders = handle(async (req, res) => {
  const page = Math.max(1, Math.min(10000, parseInt(req.query.page, 10) || 1));
  const limit = 50;
  const filter = { status: "Shipping", packingSentAt: { $ne: null }, ...(req.user.isAdmin ? {} : { packingWorker: req.user._id }) };
  if (req.query.view === "board") {
    // Each queue has its own pagination. Counts cover every assignment, so an
    // empty section never means merely "none on this page of a flat list".
    const inDelivery = { 'deliveryMovement.departedAt': { $ne: null }, 'deliveryMovement.returnedAt': null, 'deliveryMovement.slotsReturnedAt': null };
    const inStore = { $or: [{ 'deliveryMovement.departedAt': null }, { 'deliveryMovement.returnedAt': { $ne: null } }, { 'deliveryMovement.slotsReturnedAt': { $ne: null } }] };
    const definitions = {
      to_pack: { packedAt: null, ...inStore },
      ready_delivery: { ...inStore, packedAt: { $ne: null }, preparationMode: "prepare_deliver" },
      ready_handoff: { ...inStore, packedAt: { $ne: null }, preparationMode: { $ne: "prepare_deliver" } },
      in_delivery: inDelivery,
    };
    const counts = await Order.aggregate([
      { $match: filter },
      { $group: { _id: { $cond: [
        { $and: [ { $ne: [{ $ifNull: ['$deliveryMovement.departedAt', null] }, null] }, { $eq: [{ $ifNull: ['$deliveryMovement.returnedAt', null] }, null] }, { $eq: [{ $ifNull: ['$deliveryMovement.slotsReturnedAt', null] }, null] } ] }, 'in_delivery',
        { $cond: [
        { $eq: [{ $ifNull: ["$packedAt", null] }, null] }, "to_pack",
        { $cond: [{ $eq: ["$preparationMode", "prepare_deliver"] }, "ready_delivery", "ready_handoff"] },
      ] } ] }, total: { $sum: 1 } } },
    ]);
    const queues = await Promise.all(Object.entries(definitions).map(async ([key, match]) => {
      const total = counts.find(row => row._id === key)?.total || 0;
      const queueLimit = 12;
      const requested = Math.max(1, Math.min(10000, parseInt(req.query[`${key}Page`], 10) || 1));
      const queuePage = Math.min(requested, Math.max(1, Math.ceil(total / queueLimit)));
      const rows = total ? await Order.find({ ...filter, ...match })
        .select("orderNumber user assignedTo preparationMode packingSentAt packedAt deliveryMovement orderItems status stockFinalizedAt +packingHelp +reservationRevision")
        .populate("user", "name").sort({ packingSentAt: 1, _id: 1 })
        .skip((queuePage - 1) * queueLimit).limit(queueLimit).lean() : [];
      return { key, rows, pagination: { page: queuePage, total, hasNext: queuePage * queueLimit < total } };
    }));
    const ids = queues.flatMap(queue => queue.rows.map(order => order._id));
    const allocations = ids.length ? await OrderAllocation.find({ order: { $in: ids }, status: { $ne: "Cancelled" } })
      .select("order product slot qty pickedQty pickProblem status").populate("slot", "label store isActive").lean() : [];
    const byOrder = new Map();
    for (const row of allocations) {
      const key = String(row.order);
      if (!byOrder.has(key)) byOrder.set(key, []);
      byOrder.get(key).push(row);
    }
    return res.json({ groups: Object.fromEntries(queues.map(queue => [queue.key, {
      data: queue.rows.map(order => ({
        orderId: String(order._id), orderNumber: order.orderNumber,
        customerName: order.user?.name || "Unknown client",
        label: buildCartonLabel(order.user?.name, order.orderNumber, String(order._id)),
        preparationMode: order.preparationMode, sentAt: order.packingSentAt,
        packedAt: order.packedAt || null, version: order.reservationRevision || 0,
        canPack: packingReadyToFinish(order, byOrder.get(String(order._id)) || []),
        deliveryState: order.deliveryMovement?.departedAt && !order.deliveryMovement?.slotsReturnedAt ? (order.deliveryMovement.returnedAt ? 'returned' : order.deliveryMovement.method === 'courier' ? 'courier' : 'company') : null,
        summary: { ...packingSummary(order, byOrder.get(String(order._id)) || []), ...packingUnitSummary(order, byOrder.get(String(order._id)) || []) },
        helpRequestedItems: new Set(activePackingHelp(order, byOrder.get(String(order._id)) || []).map(request => String(request.product))).size,
      })), pagination: queue.pagination,
    }])) });
  }
  const [rows, total] = await Promise.all([
    Order.find(filter).select("orderNumber user assignedTo packingWorker preparationMode packingSentAt packedAt packingSummary")
      .populate("user", "name").populate("packingWorker", "name").sort({ packedAt: 1, packingSentAt: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(filter),
  ]);
  res.json({ data: rows.map(order => ({ orderId: String(order._id), orderNumber: order.orderNumber, customerName: order.user?.name || "Unknown client", workerName: order.packingWorker?.name || order.assignedTo, preparationMode: order.preparationMode, sentAt: order.packingSentAt, packedAt: order.packedAt || null, summary: order.packingSummary })), pagination: { page, total, hasNext: page * limit < total } });
});

export const readPackingOrder = handle(async (req, res) => {
  res.json({ data: await getPackingView(orderId(req), req.user) });
});

export const publishPackingOrder = handle(async (req, res) => {
  if (!Number.isSafeInteger(req.body?.expectedRevision) || req.body.expectedRevision < 0) throw new ReservationError("Reload packing progress before sending.", 400);
  res.json({ message: "Order sent to worker.", data: await sendToWorker({ ...req.body, orderId: orderId(req), actor: req.user }) });
});

export const updatePackingOrder = handle(async (req, res) => {
  const messages = { pick: "Picked quantity saved.", problem: "Picked quantity and shortage saved.", help: "Admin help requested. Continue picking the other items.", correct: "Corrected quantity saved. Reservation retained.", replace: "Reservation changed. Collect from the new location, then confirm Picked.", packed: "Order marked Packed.", reopen: "Packing reopened. Collected quantities retained." };
  const data = await changePacking({ ...req.body, orderId: orderId(req), action: req.params.action, actor: req.user });
  queuePackingHelpNotifications();
  res.json({ message: messages[req.params.action], data });
});

export const removePackingAssignment = handle(async (req, res) => {
  const data = await unassignPacking({ orderId: orderId(req), actor: req.user, expectedRevision: req.body?.expectedRevision, expectedDeliveryRevision: req.body?.expectedDeliveryRevision, confirmedPhysicalReturn: req.body?.confirmedPhysicalReturn });
  res.json({ message: 'Worker assignment removed. Reservations kept.', data });
});

export const checkPackingStockReport = handle(async (req, res) => {
  const data = await reviewPackingReport({ orderId: orderId(req), reportId: req.params.reportId, actor: req.user, checked: req.body?.checked, expectedReportsVersion: req.body?.expectedReportsVersion });
  res.json({ message: req.body.checked ? 'Stock report marked checked.' : 'Stock check reopened.', data });
});
