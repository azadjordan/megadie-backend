import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import Order from "../models/orderModel.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import SlotItem from "../models/slotItemModel.js";
import { applySlotOccupancyDelta } from "../utils/slotOccupancy.js";
import { logInventoryMovement } from "../utils/inventoryMovement.js";
import { ReservationError, recomputeAllocationStatus, saveOrderReservation, removeOrderReservation, reserveAllOrderItems } from "../utils/orderReservations.js";

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const resolveId = (value) => {
  if (!value) return "";
  if (typeof value === "object") {
    if (value._id) return String(value._id);
    if (value.id) return String(value.id);
    if (typeof value.toString === "function") return String(value);
  }
  return String(value);
};

const parsePositiveInteger = (res, value, message) => {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    res.status(400);
    throw new Error(message);
  }
  return n;
};

const reservationWarning = "Invoice exists for this order. Verify shipment documents after reservation changes.";

function sendReservationError(error, res) {
  if (!(error instanceof ReservationError)) throw error;
  return res.status(error.statusCode).json({
    success: false,
    code: error.issues ? "RESERVATION_BLOCKED" : "RESERVATION_REJECTED",
    message: error.message,
    noNewReservations: true,
    ...(error.issues ? { issues: error.issues } : {}),
  });
}

/* =========================
   GET /api/orders/:id/allocations
   Private/Admin
   ========================= */
export const getOrderAllocations = asyncHandler(async (req, res) => {
  const { id: orderId } = req.params;
  if (!isValidId(orderId)) {
    res.status(400);
    throw new Error("Invalid order id.");
  }

  const allocations = await OrderAllocation.find({ order: orderId })
    .populate("product", "name sku")
    .populate("slot", "label store unit position")
    .populate("by", "name email")
    .populate("deductedBy", "name email")
    .sort({ createdAt: -1 });

  res.status(200).json({
    success: true,
    message: "Order allocations retrieved successfully.",
    data: allocations,
  });
});

/* =========================
   POST /api/orders/:id/allocations
   Private/Admin
   Body: { productId, slotId, qty, note }
   ========================= */
export const upsertOrderAllocation = asyncHandler(async (req, res) => {
  const { id: orderId } = req.params;
  const { productId, slotId, qty, note } = req.body || {};
  for (const [value, label] of [[orderId, "order"], [productId, "product"], [slotId, "slot"]]) {
    if (!isValidId(value)) { res.status(400); throw new Error(`Invalid ${label} id.`); }
  }
  const qtyValue = parsePositiveInteger(res, qty, "Reserve qty must be a positive integer.");
  try {
    const result = await saveOrderReservation({ orderId, productId: String(productId), slotId: String(slotId), qty: qtyValue, note, actor: req.user?._id || null });
    res.json({ success: true, message: "Order allocation saved.", ...(result.hasInvoice ? { warning: reservationWarning } : {}), data: result.allocation });
  } catch (error) { sendReservationError(error, res); }
});

export const reserveAllOrderAllocations = asyncHandler(async (req, res) => {
  const orderId = req.params.id;
  if (!isValidId(orderId)) { res.status(400); throw new Error("Invalid order id."); }
  try {
    const result = await reserveAllOrderItems({ orderId, actor: req.user?._id || null });
    res.json({ success: true, message: "All items fully reserved.", ...(result.hasInvoice ? { warning: reservationWarning } : {}), data: result });
  } catch (error) { sendReservationError(error, res); }
});

/* =========================
   DELETE /api/orders/:id/allocations/:allocationId
   Private/Admin
   ========================= */
export const deleteOrderAllocation = asyncHandler(async (req, res) => {
  const { id: orderId, allocationId } = req.params;
  for (const [value, label] of [[orderId, "order"], [allocationId, "allocation"]]) {
    if (!isValidId(value)) { res.status(400); throw new Error(`Invalid ${label} id.`); }
  }
  try {
    const result = await removeOrderReservation({ orderId, allocationId, actor: req.user?._id || null });
    res.json({ success: true, message: "Allocation deleted.", ...(result.hasInvoice ? { warning: reservationWarning } : {}), data: { id: allocationId } });
  } catch (error) { sendReservationError(error, res); }
});

/* =========================
   POST /api/orders/:id/allocations/finalize
   Private/Admin
   Finalize allocations (deduct stock)
   ========================= */
export const finalizeOrderAllocations = asyncHandler(async (req, res) => {
  const { id: orderId } = req.params;
  if (!isValidId(orderId)) {
    res.status(400);
    throw new Error("Invalid order id.");
  }

  const session = await mongoose.startSession();
  let summary = null;

  try {
    await session.withTransaction(async () => {
      const order = await Order.findById(orderId)
        .select("status orderItems allocationStatus invoice stockFinalizedAt packingSentAt packedAt")
        .session(session);
      if (!order) {
        res.status(404);
        throw new Error("Order not found.");
      }
      if (order.status === "Cancelled") {
        res.status(409);
        throw new Error("Allocations are locked for cancelled orders.");
      }
      if (order.status !== "Delivered") {
        res.status(409);
        throw new Error("Finalize is allowed only when the order is Delivered.");
      }
      if (order.packingSentAt && !order.packedAt) { res.status(409); throw new Error("Packing must be complete before stock finalization."); }
      if (!order.invoice) {
        res.status(409);
        throw new Error("Invoice required before finalizing stock.");
      }

      const allocations = await OrderAllocation.find({ order: orderId })
        .select("_id product slot qty status")
        .lean()
        .session(session);

      const finalizedAt = order.stockFinalizedAt || null;
      const expiresAt = new Date(
        (finalizedAt || new Date()).getTime() + 60 * 24 * 60 * 60 * 1000
      );

      // Digital packing records retain the actual collection sources with the order.
      const expiryUpdate = order.packingSentAt ? { $unset: { expiresAt: "" } } : { $set: { expiresAt } };

      if (order.stockFinalizedAt) {
        if (allocations.length) {
          await OrderAllocation.updateMany(
            { order: orderId },
            expiryUpdate,
            { session }
          );
        }
        summary = {
          orderId,
          alreadyFinalized: true,
          deductedCount: 0,
          deductedQty: 0,
        };
        return;
      }

      if (!allocations.length) {
        res.status(409);
        throw new Error("Order has no reservations to finalize.");
      }

      const reservedAllocations = allocations.filter(
        (row) => !row.status || row.status === "Reserved"
      );
      const deductedAllocations = allocations.filter(
        (row) => row.status === "Deducted"
      );

      if (deductedAllocations.length > 0 && reservedAllocations.length > 0) {
        res.status(409);
        throw new Error(
          "Order allocations are partially deducted. Resolve before finalizing."
        );
      }

      const orderedByProduct = new Map();
      for (const item of order.orderItems || []) {
        const productKey = resolveId(item.product);
        if (!isValidId(productKey)) {
          res.status(400);
          throw new Error("Order item has an invalid product reference.");
        }
        orderedByProduct.set(productKey, Number(item.qty) || 0);
      }

      for (const allocation of allocations) {
        const productKey = resolveId(allocation.product);
        if (!isValidId(productKey)) {
          res.status(400);
          throw new Error("Allocation has an invalid product reference.");
        }
        if (!orderedByProduct.has(productKey)) {
          res.status(409);
          throw new Error(
            "Allocation references a product that is not in this order."
          );
        }
      }

      const deductedTotals = new Map();
      for (const row of deductedAllocations) {
        const key = resolveId(row.product);
        deductedTotals.set(
          key,
          (deductedTotals.get(key) || 0) + (Number(row.qty) || 0)
        );
      }

      const reservedTotals = new Map();
      for (const row of reservedAllocations) {
        const key = resolveId(row.product);
        reservedTotals.set(
          key,
          (reservedTotals.get(key) || 0) + (Number(row.qty) || 0)
        );
      }

      const hasReserved = reservedAllocations.length > 0;
      const isAlreadyDeducted = deductedAllocations.length > 0;
      const isFullyDeducted = Array.from(orderedByProduct.entries()).every(
        ([productId, orderedQty]) =>
          (deductedTotals.get(productId) || 0) === orderedQty
      );

      if (isAlreadyDeducted && !isFullyDeducted) {
        res.status(409);
        throw new Error(
          "Order allocations are partially deducted. Resolve before finalizing."
        );
      }

      if (!hasReserved && isAlreadyDeducted && isFullyDeducted) {
        await recomputeAllocationStatus(orderId, session);
        if (!order.stockFinalizedAt) {
          order.stockFinalizedAt = new Date();
          await order.save({ session });
        }
        await OrderAllocation.updateMany(
          { order: orderId },
          expiryUpdate,
          { session }
        );
        summary = {
          orderId,
          alreadyFinalized: true,
          deductedCount: deductedAllocations.length,
          deductedQty: Array.from(deductedTotals.values()).reduce(
            (sum, qty) => sum + qty,
            0
          ),
        };
        return;
      }

      if (!hasReserved) {
        res.status(409);
        throw new Error("Order has no reservations to finalize.");
      }

      const isFullyReserved = Array.from(orderedByProduct.entries()).every(
        ([productId, orderedQty]) =>
          (reservedTotals.get(productId) || 0) === orderedQty
      );

      if (!isFullyReserved) {
        res.status(409);
        throw new Error(
          "All items must be fully reserved before finalizing stock."
        );
      }

      const updatedAllocations = [];
      const occupancyDeltas = new Map();
      const addDelta = (slotKey, delta) => {
        const key = String(slotKey);
        occupancyDeltas.set(key, (occupancyDeltas.get(key) || 0) + delta);
      };
      let deductedQty = 0;

      for (const allocation of reservedAllocations) {
        const productKey = resolveId(allocation.product);
        const slotKey = resolveId(allocation.slot);
        if (!isValidId(productKey) || !isValidId(slotKey)) {
          res.status(400);
          throw new Error("Allocation has an invalid slot or product reference.");
        }

        const slotItem = await SlotItem.findOne({
          product: productKey,
          slot: slotKey,
        })
          .select("qty product cbm")
          .session(session);

        if (!slotItem) {
          res.status(404);
          throw new Error("Slot item not found for this allocation.");
        }

        const qtyValue = Number(allocation.qty) || 0;
        if (qtyValue <= 0 || !Number.isInteger(qtyValue)) {
          res.status(400);
          throw new Error("Allocation qty must be a positive integer.");
        }

        if (Number(slotItem.qty || 0) < qtyValue) {
          res.status(409);
          throw new Error(
            "Insufficient stock to finalize allocations. Refresh and try again."
          );
        }

        const slotQty = Number(slotItem.qty || 0);
        const unitCbm =
          slotQty > 0 ? (Number(slotItem.cbm || 0) / slotQty) : 0;
        const deltaCbm = qtyValue * unitCbm;
        if (deltaCbm) {
          addDelta(slotKey, -deltaCbm);
        }

        await logInventoryMovement(
          {
            type: "DEDUCT",
            product: productKey,
            slot: slotKey,
            order: orderId,
            allocation: allocation._id,
            qty: qtyValue,
            unitCbm: unitCbm || undefined,
            cbm: deltaCbm || undefined,
            actor: req.user?._id || null,
          },
          session
        );

        const nextQty = Number(slotItem.qty || 0) - qtyValue;
        if (nextQty <= 0) {
          await slotItem.deleteOne({ session });
        } else {
          slotItem.qty = nextQty;
          await slotItem.save({ session });
        }

        updatedAllocations.push(allocation._id);
        deductedQty += qtyValue;
      }

      for (const [slotKey, delta] of occupancyDeltas.entries()) {
        if (!delta) continue;
        await applySlotOccupancyDelta(slotKey, delta, session);
      }

      if (updatedAllocations.length > 0) {
        await OrderAllocation.updateMany(
          { _id: { $in: updatedAllocations } },
          {
            $set: {
              status: "Deducted",
              deductedAt: new Date(),
              deductedBy: req.user?._id || null,
            },
          },
          { session }
        );
      }

      await recomputeAllocationStatus(orderId, session);
      if (!order.stockFinalizedAt) {
        order.stockFinalizedAt = new Date();
        await order.save({ session });
      }
      await OrderAllocation.updateMany(
        { order: orderId },
        expiryUpdate,
        { session }
      );

      summary = {
        orderId,
        deductedCount: updatedAllocations.length,
        deductedQty,
      };
    });
  } finally {
    session.endSession();
  }

  res.status(200).json({
    success: true,
    message: summary?.alreadyFinalized
      ? "Order allocations already finalized."
      : "Order allocations finalized.",
    data: summary,
  });
});
