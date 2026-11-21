import { deliveryStockLockReason } from "./deliveryMovementState.js";
import mongoose from "mongoose";
import Order from "../models/orderModel.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import SlotItem from "../models/slotItemModel.js";
import { logInventoryMovement } from "./inventoryMovement.js";
import { buildOrderReservationPlan, isReserved, reservationId as id } from "./orderReservationPlan.js";
import { packingSummary } from "./packingState.js";
import { resolvePackingHelp } from "./packingHelpState.js";

export class ReservationError extends Error {
  constructor(message, statusCode = 409, issues) {
    super(message);
    this.statusCode = statusCode;
    this.issues = issues;
  }
}

export async function recomputeAllocationStatus(orderId, session = null) {
  const order = await Order.findById(orderId).select("orderItems deliveryCharge extraFee totalPrice deliveredAt allocationStatus allocatedAt packingSentAt packingSummary status stockFinalizedAt +packingHelp").session(session);
  if (!order) return null;
  const rows = await OrderAllocation.find({ order: orderId, $or: [{ status: "Reserved" }, { status: "Deducted" }, { status: { $exists: false } }] }).select("product qty pickedQty pickProblem status").session(session).lean();
  const totals = new Map();
  for (const row of rows) totals.set(id(row.product), (totals.get(id(row.product)) || 0) + row.qty);
  const ordered = new Map();
  for (const item of order.orderItems) ordered.set(id(item.product), (ordered.get(id(item.product)) || 0) + item.qty);
  const any = [...totals.values()].some((qty) => qty > 0);
  const full = ordered.size > 0 && [...ordered].every(([product, qty]) => totals.get(product) === qty);
  order.allocationStatus = any && full ? "Allocated" : any ? "PartiallyAllocated" : "Unallocated";
  order.allocatedAt = full && any ? order.allocatedAt || new Date() : null;
  if (order.packingSentAt) order.packingSummary = packingSummary(order, rows);
  resolvePackingHelp(order, rows);
  await order.save({ session });
  return order;
}

export async function transaction(work) {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => work(session), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, timeoutMS: 15000 });
  } finally {
    await session.endSession();
  }
}

export async function lockOrder(orderId, session, { expectedRevision, allowPacked = false, includeItemChanges = false } = {}) {
  // Actual writes, rather than read-only checks, force competing operations to
  // retry against a fresh snapshot. The order guard also protects its item total.
  const filter = { _id: orderId };
  if (expectedRevision !== undefined) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ReservationError("Reload current packing progress before saving.", 400);
    if (expectedRevision === 0) filter.$or = [{ reservationRevision: 0 }, { reservationRevision: { $exists: false } }];
    else filter.reservationRevision = expectedRevision;
  }
  const order = await Order.findOneAndUpdate(filter, { $inc: { reservationRevision: 1 } }, { new: true, session })
    .select("+reservationRevision +packingReports +packingReportsRevision +packingActivity +packingHelp +deliveryHistory" + (includeItemChanges ? " +itemChanges" : ""));
  if (!order) {
    if (!await Order.exists({ _id: orderId }).session(session)) throw new ReservationError("Order not found.", 404);
    throw new ReservationError("Order changed. Refresh packing progress and review before saving.");
  }
  const movementLock = deliveryStockLockReason(order);
  if (movementLock) throw new ReservationError(movementLock);
  if (order.stockFinalizedAt) throw new ReservationError("Stock finalized. Allocations are locked.");
  if (order.status !== "Shipping") throw new ReservationError("Reservations are allowed only when the order is Shipping.");
  if (order.packedAt && !allowPacked) throw new ReservationError("Order is Packed. An admin must reopen packing before changing collected stock or reservations.");
  if (await OrderAllocation.exists({ order: orderId, status: "Deducted" }).session(session)) throw new ReservationError("Allocations are finalized and cannot be changed.");
  return order;
}

export async function lockStock(filter, session) {
  // Stock edits/moves/finalization write these same documents. Manual and bulk
  // reservations share this guard, preventing cross-order write skew.
  return SlotItem.updateMany(filter, { $inc: { reservationRevision: 1 } }, { session, timestamps: false });
}

export async function saveOrderReservation({ orderId, productId, slotId, qty, note, actor }) {
  return transaction(async (session) => {
    const order = await lockOrder(orderId, session);
    const orderedQty = order.orderItems.filter((item) => id(item.product) === productId).reduce((sum, item) => sum + item.qty, 0);
    if (!orderedQty) throw new ReservationError("Product is not part of this order.", 400);
    await lockStock({ product: productId, slot: slotId }, session);
    const stock = await SlotItem.findOne({ product: productId, slot: slotId }).select("qty").session(session).lean();
    if (!stock) throw new ReservationError("Slot item not found for this product.", 404);
    const rows = await OrderAllocation.find({ order: orderId, product: productId }).session(session).lean();
    const own = rows.filter(isReserved);
    const existing = own.find((row) => id(row.slot) === slotId);
    const existingQty = existing?.qty || 0;
    if (qty < (existing?.pickedQty || 0)) throw new ReservationError("Return or correct the collected quantity before reducing this reservation.");
    const others = await OrderAllocation.find({ product: productId, slot: slotId, order: { $ne: orderId }, $or: [{ status: "Reserved" }, { status: { $exists: false } }] }).select("qty").session(session).lean();
    const available = Math.max(0, stock.qty - others.reduce((sum, row) => sum + row.qty, 0));
    if (qty > available) throw new ReservationError(`Reserve qty exceeds available stock (${available}).`, 400);
    if (own.reduce((sum, row) => sum + row.qty, 0) - existingQty + qty > orderedQty) throw new ReservationError("Reserve qty exceeds ordered quantity.", 400);
    const allocation = await OrderAllocation.findOneAndUpdate({ order: orderId, product: productId, slot: slotId }, { $set: { qty, note: note ? String(note).trim() : "", by: actor, status: "Reserved", deductedAt: null, deductedBy: null }, $unset: { expiresAt: "" } }, { new: true, upsert: true, setDefaultsOnInsert: true, session });
    const delta = qty - existingQty;
    if (delta) await logInventoryMovement({ type: delta > 0 ? "RESERVE" : "RELEASE", product: productId, slot: slotId, order: orderId, allocation: allocation._id, qty: Math.abs(delta), actor, note: note ? String(note).trim() : undefined }, session);
    await recomputeAllocationStatus(orderId, session);
    await allocation.populate([{ path: "product", select: "name sku" }, { path: "slot", select: "label store unit position" }, { path: "by", select: "name email" }]);
    return { allocation, hasInvoice: Boolean(order.invoice) };
  });
}

export async function removeOrderReservation({ orderId, allocationId, actor }) {
  return transaction(async (session) => {
    const order = await lockOrder(orderId, session);
    const allocation = await OrderAllocation.findById(allocationId).session(session);
    if (!allocation) throw new ReservationError("Allocation not found.", 404);
    if (id(allocation.order) !== orderId) throw new ReservationError("Allocation does not belong to this order.", 400);
    if (allocation.pickedQty > 0) throw new ReservationError("Collected stock cannot be released. Confirm its physical return or correct the picked quantity first.");
    await lockStock({ product: allocation.product, slot: allocation.slot }, session);
    if (isReserved(allocation)) await logInventoryMovement({ type: "RELEASE", product: allocation.product, slot: allocation.slot, order: orderId, allocation: allocation._id, qty: allocation.qty, actor, note: allocation.note }, session);
    await allocation.deleteOne({ session });
    await recomputeAllocationStatus(orderId, session);
    return { hasInvoice: Boolean(order.invoice) };
  });
}

export async function reserveAllOrderItems({ orderId, actor }) {
  return transaction(async (session) => {
    const order = await lockOrder(orderId, session);
    const productIds = [...new Set(order.orderItems.map((item) => id(item.product)))];
    await lockStock({ product: { $in: productIds } }, session);
    const stock = await SlotItem.find({ product: { $in: productIds } }).populate("slot", "label store").session(session).lean();
    const own = await OrderAllocation.find({ order: orderId }).session(session).lean();
    const others = await OrderAllocation.find({ product: { $in: productIds }, order: { $ne: orderId }, $or: [{ status: "Reserved" }, { status: { $exists: false } }] }).select("product slot qty status").session(session).lean();
    const plan = buildOrderReservationPlan(order, own, stock, others);
    if (plan.issues.length) throw new ReservationError("No new reservations made. Resolve the reported issues, then check the whole order again.", 409, plan.issues);
    // No allocation writes occur until every item has passed validation.
    for (const row of plan.changes) {
      const allocation = await OrderAllocation.findOneAndUpdate({ order: orderId, product: row.productId, slot: row.slotId }, { $set: { qty: row.qty, by: actor, status: "Reserved", note: "", deductedAt: null, deductedBy: null }, $unset: { expiresAt: "" } }, { new: true, upsert: true, setDefaultsOnInsert: true, session });
      await logInventoryMovement({ type: "RESERVE", product: row.productId, slot: row.slotId, order: orderId, allocation: allocation._id, qty: row.qty, actor }, session);
    }
    await recomputeAllocationStatus(orderId, session);
    return { itemCount: plan.itemCount, addedQty: plan.addedQty, reservationCount: plan.changes.length, hasInvoice: Boolean(order.invoice) };
  });
}
