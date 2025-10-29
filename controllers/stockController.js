// controllers/stockController.js
import asyncHandler from "../middleware/asyncHandler.js";
import mongoose from "mongoose";
import Order from "../models/orderModel.js";
import Slot from "../models/slotModel.js";
import SlotItem from "../models/slotItemModel.js";
import Product from "../models/productModel.js";

/* =========================
   Helper: capacity check up to 140%
   Used for reversals (adds back into slots)
   ========================= */
const canFitUpTo140 = async (slotId, adds, session) => {
  // adds: [{ productId, qty }]
  const slot = await Slot.findById(slotId).session(session);
  if (!slot) throw new Error("Slot not found.");

  // Current occupied CBM in this slot
  const usage = await SlotItem.aggregate([
    { $match: { slot: slot._id } },
    { $lookup: { from: "products", localField: "product", foreignField: "_id", as: "p" } },
    { $unwind: "$p" },
    { $group: { _id: null, cbm: { $sum: { $multiply: ["$qty", "$p.cbm"] } } } }
  ]).session(session);

  const current = usage[0]?.cbm ?? 0;

  // Incoming CBM for the adds
  const ids = adds.map(a => a.productId);
  const prods = await Product.find({ _id: { $in: ids } }, "_id cbm").session(session);
  const cbmMap = Object.fromEntries(prods.map(p => [p._id.toString(), p.cbm]));
  const incoming = adds.reduce((s, a) => s + Number(a.qty) * (cbmMap[a.productId.toString()] || 0), 0);

  return current + incoming <= slot.cbm * 1.4; // allow up to 140%
};

/* =========================
   GET /api/stock/orders/:orderId/picklist
   Private/Admin
   Returns, per ordered product, all candidate slots with their quantities.
   ========================= */
export const getOrderPicklist = asyncHandler(async (req, res) => {
  const { orderId } = req.params;

  const order = await Order.findById(orderId).select("orderItems status");
  if (!order) {
    res.status(404);
    throw new Error("Order not found.");
  }

  const productIds = order.orderItems.map(i => i.product);
  if (productIds.length === 0) {
    return res.status(200).json({
      success: true,
      message: "Order has no items.",
      data: { orderId, status: order.status, items: [] },
    });
  }

  const slotItems = await SlotItem.aggregate([
    { $match: { product: { $in: productIds } } },
    { $lookup: { from: "slots", localField: "slot", foreignField: "_id", as: "slot" } },
    { $unwind: "$slot" },
    { $project: {
        product: 1,
        productSKU: 1,
        qty: "$qty",
        slotId: "$slot._id",
        slotLabel: "$slot.label",
        slotStore: "$slot.store"
    }}
  ]);

  const byProduct = slotItems.reduce((acc, si) => {
    const key = si.product.toString();
    (acc[key] ||= []).push({
      slotId: si.slotId,
      slotLabel: si.slotLabel,
      slotStore: si.slotStore,
      qty: si.qty,
    });
    return acc;
  }, {});

  const items = order.orderItems.map(oi => ({
    orderItemId: oi._id,
    productId: oi.product,
    sku: oi.sku,
    orderedQty: oi.qty,
    slots: (byProduct[oi.product.toString()] || []).sort((a, b) =>
      String(a.slotLabel).localeCompare(String(b.slotLabel))
    ),
  }));

  res.status(200).json({
    success: true,
    message: "Picklist generated successfully.",
    data: { orderId, status: order.status, items },
  });
});

/* =========================
   POST /api/stock/orders/:orderId/deliver-apply
   Private/Admin
   Body:
     - picks: [{ productId, slotId, qty }, ...]  (required)
   Rules:
     - Order must be in status "Delivered".
     - Deducts quantities from the chosen slots (per product).
     - Deletes SlotItem rows that reach 0.
     - Saves deliveredPicks, sets stockDeducted = true, timestamps appliedAt.
     - Idempotent via stockDeducted flag.
   ========================= */
export const applyDeliveryPicks = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const { picks = [] } = req.body || {};

  if (!Array.isArray(picks) || picks.length === 0) {
    res.status(400);
    throw new Error("No picks provided.");
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new Error("Order not found.");

    if (order.status !== "Delivered") {
      throw new Error("You can only deduct stock when the order status is 'Delivered'.");
    }
    if (order.stockDeducted) {
      throw new Error("Delivery picks already applied for this order.");
    }

    // Validate picks against order items
    const orderMap = new Map(order.orderItems.map(oi => [oi.product.toString(), { qty: oi.qty }]));
    const sumByProduct = {};
    for (const p of picks) {
      if (!orderMap.has(p.productId)) throw new Error("Pick contains a product not found in this order.");
      if (!Number.isFinite(Number(p.qty)) || Number(p.qty) <= 0) {
        throw new Error("Pick qty must be greater than 0.");
      }
      sumByProduct[p.productId] = (sumByProduct[p.productId] || 0) + Number(p.qty);
    }
    for (const [pid, sum] of Object.entries(sumByProduct)) {
      const orderedQty = orderMap.get(pid).qty;
      if (sum > orderedQty) {
        throw new Error(`Delivered qty (${sum}) exceeds ordered qty (${orderedQty}) for product ${pid}.`);
      }
    }

    // Deduct from SlotItems; delete join if qty hits 0
    for (const p of picks) {
      const item = await SlotItem.findOne({ slot: p.slotId, product: p.productId }).session(session);
      if (!item) throw new Error("SlotItem not found for a pick.");
      if (item.qty < Number(p.qty)) throw new Error("Insufficient quantity in selected slot.");

      item.qty -= Number(p.qty);
      if (item.qty === 0) {
        await item.deleteOne({ session });
      } else {
        await item.save({ session });
      }
    }

    // Fetch SKUs server-side and snapshot them into deliveredPicks
    const uniqueProductIds = [...new Set(picks.map(p => p.productId))];
    const prodDocs = await Product.find({ _id: { $in: uniqueProductIds } }, "_id sku").session(session);
    const skuMap = Object.fromEntries(prodDocs.map(d => [d._id.toString(), d.sku]));

    order.deliveredPicks = picks.map(p => ({
      product: p.productId,
      sku: skuMap[p.productId] || "N/A",
      slot: p.slotId,
      qty: Number(p.qty),
      at: new Date(),
    }));
    order.stockDeducted = true;
    order.appliedAt = new Date();
    order.reversedAt = undefined;

    const saved = await order.save({ session });

    await session.commitTransaction();
    session.endSession();

    res.status(200).json({
      success: true,
      message: "Stock deduction applied successfully.",
      data: {
        orderId: saved._id,
        status: saved.status,
        appliedCount: picks.length,
        stockDeducted: true,
      },
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    res.status(400).json({ success: false, message: err.message });
  }
});

/* =========================
   POST /api/stock/orders/:orderId/deliver-reverse
   Private/Admin
   Body: none
   Rules:
     - Order must be in status "Cancelled".
     - Restores the previously deducted quantities (to the same slots).
     - Honors capacity up to 140% on each target slot.
     - Idempotent via stockDeducted flag.
     - Sets stockDeducted = false, timestamps reversedAt.
   ========================= */
export const reverseDeliveryToSlots = asyncHandler(async (req, res) => {
  const { orderId } = req.params;

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new Error("Order not found.");

    if (order.status !== "Cancelled") {
      throw new Error("You can only reverse delivery when the order status is 'Cancelled'.");
    }
    if (!order.stockDeducted || !Array.isArray(order.deliveredPicks) || order.deliveredPicks.length === 0) {
      throw new Error("No delivery picks recorded to reverse.");
    }

    // Capacity check per slot (batched) with 140% limit
    const addsBySlot = {};
    for (const p of order.deliveredPicks) {
      const k = p.slot.toString();
      (addsBySlot[k] ||= []).push({ productId: p.product, qty: p.qty });
    }
    for (const [slotId, adds] of Object.entries(addsBySlot)) {
      const ok = await canFitUpTo140(slotId, adds, session);
      if (!ok) throw new Error(`Cannot restock to slot ${slotId}: would exceed 140% capacity.`);
    }

    // Re-add quantities (upsert SlotItem joins)
    for (const p of order.deliveredPicks) {
      const existing = await SlotItem.findOne({ slot: p.slot, product: p.product }).session(session);
      if (!existing) {
        await SlotItem.create([{
          slot: p.slot,
          product: p.product,
          productSKU: p.sku,
          qty: Number(p.qty),
        }], { session });
      } else {
        existing.qty += Number(p.qty);
        await existing.save({ session });
      }
    }

    order.stockDeducted = false;
    order.reversedAt = new Date();

    const saved = await order.save({ session });

    await session.commitTransaction();
    session.endSession();

    res.status(200).json({
      success: true,
      message: "Stock deduction reversed successfully.",
      data: {
        orderId: saved._id,
        status: saved.status,
        reversedCount: order.deliveredPicks.length,
        stockDeducted: false,
      },
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    res.status(400).json({ success: false, message: err.message });
  }
});
