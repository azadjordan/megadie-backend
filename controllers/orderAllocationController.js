import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import Order from "../models/orderModel.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import SlotItem from "../models/slotItemModel.js";
import { applySlotOccupancyDelta } from "../utils/slotOccupancy.js";
import { logInventoryMovement } from "../utils/inventoryMovement.js";

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

const recomputeAllocationStatus = async (orderId, session = null) => {
  const orderQuery = Order.findById(orderId).select(
    "orderItems allocationStatus allocatedAt"
  );
  if (session) {
    orderQuery.session(session);
  }
  const order = await orderQuery;
  if (!order) return null;

  const allocationsQuery = OrderAllocation.find({
    order: orderId,
    $or: [
      { status: "Reserved" },
      { status: "Deducted" },
      { status: { $exists: false } },
    ],
  })
    .select("product qty")
    .lean();
  if (session) {
    allocationsQuery.session(session);
  }
  const allocations = await allocationsQuery;

  const totalsByProduct = new Map();
  for (const row of allocations) {
    const key = String(row.product);
    const qty = Number(row.qty) || 0;
    totalsByProduct.set(key, (totalsByProduct.get(key) || 0) + qty);
  }

  let anyAllocated = false;
  let fullyAllocated = true;

  for (const item of order.orderItems || []) {
    const productId = String(item.product);
    const orderedQty = Number(item.qty) || 0;
    const allocatedQty = totalsByProduct.get(productId) || 0;

    if (allocatedQty > 0) {
      anyAllocated = true;
    }
    if (allocatedQty < orderedQty) {
      fullyAllocated = false;
    }
  }

  const nextStatus = fullyAllocated && anyAllocated
    ? "Allocated"
    : anyAllocated
    ? "PartiallyAllocated"
    : "Unallocated";

  if (order.allocationStatus !== nextStatus) {
    order.allocationStatus = nextStatus;
  }

  if (nextStatus === "Allocated") {
    if (!order.allocatedAt) order.allocatedAt = new Date();
  } else if (order.allocatedAt) {
    order.allocatedAt = null;
  }

  if (session) {
    await order.save({ session });
  } else {
    await order.save();
  }
  return order;
};

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

  if (!isValidId(orderId)) {
    res.status(400);
    throw new Error("Invalid order id.");
  }
  if (!isValidId(productId)) {
    res.status(400);
    throw new Error("Invalid product id.");
  }
  if (!isValidId(slotId)) {
    res.status(400);
    throw new Error("Invalid slot id.");
  }

  const qtyValue = parsePositiveInteger(
    res,
    qty,
    "Reserve qty must be a positive integer."
  );

  const order = await Order.findById(orderId).select(
    "orderItems status invoice stockFinalizedAt"
  );
  if (!order) {
    res.status(404);
    throw new Error("Order not found.");
  }
  if (order.stockFinalizedAt) {
    res.status(409);
    throw new Error("Stock finalized. Allocations are locked.");
  }
  if (["Delivered", "Cancelled"].includes(order.status)) {
    res.status(409);
    throw new Error("Allocations are locked for delivered or cancelled orders.");
  }
  if (order.status !== "Shipping") {
    res.status(409);
    throw new Error("Reservations are allowed only when the order is Shipping.");
  }
  const hasDeducted = await OrderAllocation.exists({
    order: orderId,
    status: "Deducted",
  });
  if (hasDeducted) {
    res.status(409);
    throw new Error("Allocations are finalized and cannot be changed.");
  }

  const item = (order.orderItems || []).find(
    (it) => String(it.product) === String(productId)
  );
  if (!item) {
    res.status(400);
    throw new Error("Product is not part of this order.");
  }

  const slotItem = await SlotItem.findOne({
    product: productId,
    slot: slotId,
  })
    .select("qty")
    .lean();
  if (!slotItem) {
    res.status(404);
    throw new Error("Slot item not found for this product.");
  }

  const existing = await OrderAllocation.find({
    order: orderId,
    product: productId,
  })
    .select("slot qty")
    .lean();

  let existingQty = 0;
  let totalAllocated = 0;
  for (const row of existing) {
    const rowQty = Number(row.qty) || 0;
    totalAllocated += rowQty;
    if (String(row.slot) === String(slotId)) {
      existingQty = rowQty;
    }
  }

  const reservedRows = await OrderAllocation.find({
    product: productId,
    slot: slotId,
    order: { $ne: orderId },
    $or: [{ status: "Reserved" }, { status: { $exists: false } }],
  })
    .select("qty")
    .lean();
  const reservedQty = reservedRows.reduce(
    (sum, row) => sum + (Number(row.qty) || 0),
    0
  );
  const availableQty = Math.max(0, Number(slotItem.qty || 0) - reservedQty);
  const availableForOrder = Math.max(0, availableQty - existingQty);
  if (availableForOrder <= 0 && qtyValue >= existingQty) {
    res.status(400);
    throw new Error("No available stock in this slot.");
  }
  if (qtyValue > availableQty) {
    res.status(400);
    throw new Error(`Reserve qty exceeds available stock (${availableQty}).`);
  }

  const orderedQty = Number(item.qty) || 0;
  const proposedTotal = totalAllocated - existingQty + qtyValue;
  if (proposedTotal > orderedQty) {
    res.status(400);
    throw new Error("Reserve qty exceeds ordered quantity.");
  }

  const updated = await OrderAllocation.findOneAndUpdate(
    { order: orderId, product: productId, slot: slotId },
    {
      $set: {
        qty: qtyValue,
        note: note ? String(note).trim() : "",
        by: req.user?._id || null,
        status: "Reserved",
        deductedAt: null,
        deductedBy: null,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  )
    .populate("product", "name sku")
    .populate("slot", "label store unit position")
    .populate("by", "name email");

  await recomputeAllocationStatus(orderId);

  const deltaQty = qtyValue - existingQty;
  if (deltaQty !== 0) {
    await logInventoryMovement({
      type: deltaQty > 0 ? "RESERVE" : "RELEASE",
      product: productId,
      slot: slotId,
      order: orderId,
      allocation: updated?._id || null,
      qty: Math.abs(deltaQty),
      actor: req.user?._id || null,
      note: note ? String(note).trim() : undefined,
    });
  }

  const warning = order.invoice
    ? "Invoice exists for this order. Verify shipment documents after reservation changes."
    : "";

  res.status(200).json({
    success: true,
    message: "Order allocation saved.",
    ...(warning ? { warning } : {}),
    data: updated,
  });
});

/* =========================
   DELETE /api/orders/:id/allocations/:allocationId
   Private/Admin
   ========================= */
export const deleteOrderAllocation = asyncHandler(async (req, res) => {
  const { id: orderId, allocationId } = req.params;

  if (!isValidId(orderId)) {
    res.status(400);
    throw new Error("Invalid order id.");
  }
  if (!isValidId(allocationId)) {
    res.status(400);
    throw new Error("Invalid allocation id.");
  }

  const allocation = await OrderAllocation.findById(allocationId);
  if (!allocation) {
    res.status(404);
    throw new Error("Allocation not found.");
  }
  const order = await Order.findById(orderId).select(
    "status invoice stockFinalizedAt"
  );
  if (!order) {
    res.status(404);
    throw new Error("Order not found.");
  }
  if (order.stockFinalizedAt) {
    res.status(409);
    throw new Error("Stock finalized. Allocations are locked.");
  }
  if (["Delivered", "Cancelled"].includes(order.status)) {
    res.status(409);
    throw new Error("Allocations are locked for delivered or cancelled orders.");
  }
  if (order.status !== "Shipping") {
    res.status(409);
    throw new Error("Reservations are allowed only when the order is Shipping.");
  }
  const hasDeducted = await OrderAllocation.exists({
    order: orderId,
    status: "Deducted",
  });
  if (hasDeducted) {
    res.status(409);
    throw new Error("Allocations are finalized and cannot be changed.");
  }

  if (String(allocation.order) !== String(orderId)) {
    res.status(400);
    throw new Error("Allocation does not belong to this order.");
  }

  await logInventoryMovement({
    type: "RELEASE",
    product: allocation.product,
    slot: allocation.slot,
    order: allocation.order,
    allocation: allocation._id,
    qty: Number(allocation.qty) || 0,
    actor: req.user?._id || null,
    note: allocation.note || undefined,
  });

  await allocation.deleteOne();
  await recomputeAllocationStatus(orderId);

  const warning = order.invoice
    ? "Invoice exists for this order. Verify shipment documents after reservation changes."
    : "";

  res.status(200).json({
    success: true,
    message: "Allocation deleted.",
    ...(warning ? { warning } : {}),
    data: { id: allocationId },
  });
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
        .select("status orderItems allocationStatus invoice stockFinalizedAt")
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

      if (order.stockFinalizedAt) {
        if (allocations.length) {
          await OrderAllocation.updateMany(
            { order: orderId },
            { $set: { expiresAt } },
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
          { $set: { expiresAt } },
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
        { $set: { expiresAt } },
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
