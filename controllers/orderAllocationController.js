import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import Order from "../models/orderModel.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import SlotItem from "../models/slotItemModel.js";

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const parsePositiveNumber = (res, value, message) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    res.status(400);
    throw new Error(message);
  }
  return n;
};

const recomputeAllocationStatus = async (orderId) => {
  const order = await Order.findById(orderId).select(
    "orderItems allocationStatus allocatedAt"
  );
  if (!order) return null;

  const allocations = await OrderAllocation.find({ order: orderId })
    .select("product qty")
    .lean();

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

  await order.save();
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

  const qtyValue = parsePositiveNumber(
    res,
    qty,
    "Pick qty must be a positive number."
  );

  const order = await Order.findById(orderId).select("orderItems");
  if (!order) {
    res.status(404);
    throw new Error("Order not found.");
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

  if (qtyValue > Number(slotItem.qty || 0)) {
    res.status(400);
    throw new Error("Pick qty exceeds slot availability.");
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

  const orderedQty = Number(item.qty) || 0;
  const proposedTotal = totalAllocated - existingQty + qtyValue;
  if (proposedTotal > orderedQty) {
    res.status(400);
    throw new Error("Pick qty exceeds ordered quantity.");
  }

  const updated = await OrderAllocation.findOneAndUpdate(
    { order: orderId, product: productId, slot: slotId },
    {
      $set: {
        qty: qtyValue,
        note: note ? String(note).trim() : "",
        by: req.user?._id || null,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  )
    .populate("product", "name sku")
    .populate("slot", "label store unit position")
    .populate("by", "name email");

  await recomputeAllocationStatus(orderId);

  res.status(200).json({
    success: true,
    message: "Order allocation saved.",
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

  if (String(allocation.order) !== String(orderId)) {
    res.status(400);
    throw new Error("Allocation does not belong to this order.");
  }

  await allocation.deleteOne();
  await recomputeAllocationStatus(orderId);

  res.status(200).json({
    success: true,
    message: "Allocation deleted.",
    data: { id: allocationId },
  });
});
