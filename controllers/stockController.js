import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import Order from "../models/orderModel.js";
import SlotItem from "../models/slotItemModel.js";

/* ---------- Helper: autosuggest simple pick plan ---------- */
const suggestPicksForProduct = async ({ productId, needQty }, { session }) => {
  if (needQty <= 0) return [];

  // Largest quantities first keeps fragmentation low and is easy to reason about
  const slotItems = await SlotItem.find({
    product: productId,
    quantity: { $gt: 0 },
  })
    .sort({ quantity: -1, updatedAt: 1 })
    .session(session)
    .lean();

  const plan = [];
  let remaining = needQty;

  for (const si of slotItems) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, si.quantity);
    if (take > 0) {
      plan.push({ slot: si.slot, qty: take });
      remaining -= take;
    }
  }

  if (remaining > 0) {
    const have = needQty - remaining;
    const err = new Error(
      `Insufficient stock for product ${productId}. Need ${needQty}, have ${have}.`
    );
    err.code = "INSUFFICIENT_STOCK";
    throw err;
  }

  return plan;
};

/* ---------- GET /api/stock/:orderId/autosuggest (read-only) ---------- */
export const autosuggestPicks = asyncHandler(async (req, res) => {
  const { orderId } = req.params;

  const order = await Order.findById(orderId);
  if (!order) return res.status(404).json({ message: "Order not found." });
  if (!order.orderItems?.length)
    return res.json({ message: "Order has no items.", suggestions: [] });

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const suggestions = [];

    for (const it of order.orderItems) {
      const picks = await suggestPicksForProduct(
        { productId: it.product, needQty: it.qty },
        { session }
      );
      suggestions.push({
        product: it.product,
        sku: it.sku,
        qty: it.qty,
        picks, // [{ slot, qty }]
      });
    }

    await session.abortTransaction();
    session.endSession();

    res.json({ orderId, status: order.status, suggestions });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    res.status(400).json({ message: err.message });
  }
});

/* ---------- POST /api/stock/:orderId/apply ----------
   Rules:
   - Order must be in status "Delivered"
   - If body.picks is absent/empty → autosuggest & apply
   - Deducts with $gte guards (transactional)
   - Saves deliveredPicks snapshot; sets stockDeducted = true
----------------------------------------------------- */
export const applyPicks = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const reqPicks = req.body?.picks;

  const order = await Order.findById(orderId);
  if (!order) return res.status(404).json({ message: "Order not found." });

  if (order.status !== "Delivered") {
    return res
      .status(400)
      .json({ message: "You can only deduct stock when the order status is 'Delivered'." });
  }
  if (order.stockDeducted)
    return res.status(400).json({ message: "Stock already deducted for this order." });

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Build plan (from client or autosuggest)
    let plan = Array.isArray(reqPicks) && reqPicks.length > 0 ? reqPicks : [];

    if (plan.length === 0) {
      for (const it of order.orderItems) {
        const picks = await suggestPicksForProduct(
          { productId: it.product, needQty: it.qty },
          { session }
        );
        for (const p of picks) plan.push({ product: it.product, slot: p.slot, qty: p.qty });
      }
    }

    // Ensure plan matches ordered quantities EXACTLY per product
    const wantByProduct = new Map();
    for (const it of order.orderItems) {
      wantByProduct.set(String(it.product), (wantByProduct.get(String(it.product)) || 0) + it.qty);
    }
    const gotByProduct = new Map();
    for (const p of plan) {
      const pid = String(p.product);
      const q = Number(p.qty);
      if (!Number.isFinite(q) || q <= 0) {
        throw new Error("Pick qty must be > 0.");
      }
      gotByProduct.set(pid, (gotByProduct.get(pid) || 0) + q);
    }
    for (const [pid, want] of wantByProduct.entries()) {
      const got = gotByProduct.get(pid) || 0;
      if (got !== want) {
        throw new Error(`Pick plan mismatch for product ${pid}. Need ${want}, got ${got}.`);
      }
    }

    // Deduct atomically using $gte guards
    const bulkOps = plan.map((p) => ({
      updateOne: {
        filter: { product: p.product, slot: p.slot, quantity: { $gte: Number(p.qty) } },
        update: { $inc: { quantity: -Number(p.qty) } },
      },
    }));
    const bulkRes = await SlotItem.bulkWrite(bulkOps, { session, ordered: true });
    const nModified =
      bulkRes?.result?.nModified ??
      Object.values(bulkRes?.result || {}).reduce((a, b) => a + (b || 0), 0);
    if (nModified < plan.length)
      throw new Error("Concurrent stock change detected. Please refresh and try again.");

    // Cleanup rows that hit 0
    await SlotItem.deleteMany({ quantity: { $lte: 0 } }, { session });

    // Snapshot on order (use SKUs from order items)
    const skuByProduct = new Map(order.orderItems.map((it) => [String(it.product), it.sku]));
    order.deliveredPicks = plan.map((p) => ({
      product: p.product,
      sku: skuByProduct.get(String(p.product)) || "N/A",
      slot: p.slot,
      qty: Number(p.qty),
      at: new Date(),
    }));
    order.stockDeducted = true;
    order.appliedAt = new Date();
    order.reversedAt = undefined;

    await order.save({ session });
    await session.commitTransaction();
    session.endSession();

    res.json({
      message: "Stock deducted.",
      orderId: order._id,
      status: order.status,
      stockDeducted: true,
      deliveredPicks: order.deliveredPicks,
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    res.status(400).json({ message: err.message });
  }
});

/* ---------- POST /api/stock/:orderId/reverse ----------
   Rules:
   - Order must be in status "Cancelled"
   - Restores quantities by deliveredPicks snapshot
   - Clears snapshot; sets stockDeducted = false
----------------------------------------------------- */
export const reversePicks = asyncHandler(async (req, res) => {
  const { orderId } = req.params;

  const order = await Order.findById(orderId);
  if (!order) return res.status(404).json({ message: "Order not found." });

  if (order.status !== "Cancelled") {
    return res
      .status(400)
      .json({ message: "You can only reverse stock when the order status is 'Cancelled'." });
  }
  if (!order.stockDeducted || !order.deliveredPicks?.length) {
    return res.status(400).json({ message: "No deducted stock to reverse." });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Upsert back exactly where it was taken from
    const bulkOps = order.deliveredPicks.map((p) => ({
      updateOne: {
        filter: { product: p.product, slot: p.slot },
        update: { $inc: { quantity: Number(p.qty) } },
        upsert: true,
      },
    }));
    await SlotItem.bulkWrite(bulkOps, { session, ordered: true });

    order.deliveredPicks = [];
    order.stockDeducted = false;
    order.reversedAt = new Date();
    await order.save({ session });

    await session.commitTransaction();
    session.endSession();

    res.json({
      message: "Stock reversal completed.",
      orderId: order._id,
      status: order.status,
      stockDeducted: false,
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    res.status(400).json({ message: err.message });
  }
});
