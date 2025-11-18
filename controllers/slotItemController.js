// controllers/slotItemController.js
import asyncHandler from "../middleware/asyncHandler.js";
import mongoose from "mongoose";
import SlotItem from "../models/slotItemModel.js";

/* =========================
   GET /api/slot-items
   Filters: productId, slotId
   Pagination: page, limit
   ========================= */
export const getSlotItems = asyncHandler(async (req, res) => {
  const { productId, slotId, page = 1, limit = 50 } = req.query;

  const filter = {};
  if (productId) filter.product = new mongoose.Types.ObjectId(productId);
  if (slotId)    filter.slot    = new mongoose.Types.ObjectId(slotId);

  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const perPage = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

  const [total, data] = await Promise.all([
    SlotItem.countDocuments(filter),
    SlotItem.find(filter)
      .populate("slot", "store unit position label")
      .populate("product", "name sku")
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * perPage)
      .limit(perPage),
  ]);

  res.status(200).json({
    success: true,
    message: "Slot items retrieved successfully.",
    page: pageNum,
    pages: Math.ceil(total / perPage) || 1,
    limit: perPage,
    total,
    data,
  });
});

/* =========================
   GET /api/slot-items/by-product/:productId
   Simple per-slot breakdown + totals
   ========================= */
export const getByProduct = asyncHandler(async (req, res) => {
  const { productId } = req.params;

  const rows = await SlotItem.find({ product: productId })
    .populate("slot", "label store")
    .lean();

  const totalOnHand = rows.reduce((s, r) => s + (r.qty || 0), 0);
  const slots = rows.map(r => ({
    slotId: r.slot?._id,
    slotLabel: r.slot?.label,
    slotStore: r.slot?.store,
    qty: r.qty,
  }));

  res.status(200).json({
    success: true,
    message: "Stock by product calculated successfully.",
    data: { totalOnHand, available: totalOnHand, slots },
  });
});

/* =========================
   GET /api/slot-items/by-slot/:slotId
   All products in a slot with qty
   ========================= */
export const getBySlot = asyncHandler(async (req, res) => {
  const { slotId } = req.params;

  const items = await SlotItem.find({ slot: slotId })
    .populate("product", "name sku")
    .sort({ "product.sku": 1 }) // harmless even if sku missing
    .lean();

  res.status(200).json({
    success: true,
    message: "Stock by slot retrieved successfully.",
    data: items,
  });
});

/* =========================
   POST /api/slot-items/receive
   Upsert/increase qty in a slot
   Body: slotId, productId, qty (>0)
   ========================= */
export const receiveToSlot = asyncHandler(async (req, res) => {
  const { slotId, productId, qty } = req.body || {};
  if (!slotId || !productId || !qty || Number(qty) <= 0) {
    res.status(400);
    throw new Error("slotId, productId, and positive qty are required.");
  }

  const existing = await SlotItem.findOne({ slot: slotId, product: productId });
  if (!existing) {
    const created = await SlotItem.create({
      slot: slotId,
      product: productId,
      qty: Number(qty),
    });
    return res.status(201).json({
      success: true,
      message: "Slot item created and quantity received.",
      data: created,
    });
  }

  existing.qty += Number(qty);
  const saved = await existing.save();
  res.status(200).json({
    success: true,
    message: "Quantity received into existing slot item.",
    data: saved,
  });
});

/* =========================
   DELETE /api/slot-items/:id
   Removes a SlotItem join (no guard)
   ========================= */
export const deleteSlotItem = asyncHandler(async (req, res) => {
  const item = await SlotItem.findById(req.params.id);
  if (!item) {
    res.status(404);
    throw new Error("Slot item not found.");
  }
  await item.deleteOne();
  res.status(200).json({
    success: true,
    message: "Slot item deleted successfully.",
    slotItemId: item._id,
  });
});

/* =========================
   PUT /api/slot-items/:id
   Body: qty (>=0)
   ========================= */
export const updateSlotItemQty = asyncHandler(async (req, res) => {
  const { qty } = req.body || {};
  if (typeof qty === "undefined" || isNaN(qty) || qty < 0) {
    res.status(400);
    throw new Error("Valid qty is required.");
  }

  const item = await SlotItem.findById(req.params.id);
  if (!item) {
    res.status(404);
    throw new Error("Slot item not found.");
  }

  const oldQty = item.qty;
  item.qty = Number(qty);
  const saved = await item.save();

  res.status(200).json({
    success: true,
    message: `Slot item quantity updated from ${oldQty} to ${saved.qty}.`,
    data: saved,
  });
});

