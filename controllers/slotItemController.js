// controllers/slotItemController.js
import asyncHandler from "../middleware/asyncHandler.js";
import mongoose from "mongoose";
import Slot from "../models/slotModel.js";
import SlotItem from "../models/slotItemModel.js";
import Product from "../models/productModel.js";

/* ========== helper: capacity up to 140% for adds ========== */
const canFitUpTo140 = async (slotId, adds, session) => {
  const slot = await Slot.findById(slotId).session(session);
  if (!slot) throw new Error("Slot not found.");

  const usage = await SlotItem.aggregate([
    { $match: { slot: slot._id } },
    { $lookup: { from: "products", localField: "product", foreignField: "_id", as: "p" } },
    { $unwind: "$p" },
    { $group: { _id: null, cbm: { $sum: { $multiply: ["$qty", "$p.cbm"] } } } }
  ]).session(session);

  const current = usage[0]?.cbm ?? 0;
  const ids = adds.map(a => a.productId);
  const prods = await Product.find({ _id: { $in: ids } }, "_id cbm").session(session);
  const cbmMap = Object.fromEntries(prods.map(p => [p._id.toString(), p.cbm]));
  const incoming = adds.reduce((s, a) => s + Number(a.qty) * (cbmMap[a.productId.toString()] || 0), 0);

  return current + incoming <= slot.cbm * 1.4;
};

/* =========================
   GET /api/slot-items
   Private/Admin
   Filters: productId, slotId, sku
   Pagination: page, limit
   ========================= */
export const getSlotItems = asyncHandler(async (req, res) => {
  const { productId, slotId, sku, page = 1, limit = 50 } = req.query;

  const filter = {};
  if (productId) filter.product = productId;
  if (slotId) filter.slot = slotId;
  if (sku && sku.trim()) filter.productSKU = { $regex: sku.trim(), $options: "i" };

  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const perPage = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

  const total = await SlotItem.countDocuments(filter);
  const data = await SlotItem.find(filter)
    .populate("slot", "store unit position label cbm")
    .populate("product", "name sku cbm")
    .sort({ "slot.store": 1, "slot.unit": 1, "slot.position": 1 })
    .skip((pageNum - 1) * perPage)
    .limit(perPage);

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
   Private/Admin
   Returns per-slot breakdown + totals
   ========================= */
export const getByProduct = asyncHandler(async (req, res) => {
  const { productId } = req.params;

  const rows = await SlotItem.aggregate([
    { $match: { product: new mongoose.Types.ObjectId(productId) } },
    { $lookup: { from: "slots", localField: "slot", foreignField: "_id", as: "slot" } },
    { $unwind: "$slot" },
    { $project: { qty: 1, productSKU: 1, slotId: "$slot._id", slotLabel: "$slot.label", slotStore: "$slot.store" } },
    { $group: {
        _id: null,
        totalOnHand: { $sum: "$qty" },
        slots: { $push: { slotId: "$slotId", slotLabel: "$slotLabel", slotStore: "$slotStore", qty: "$qty" } }
    }},
    { $project: { _id: 0, totalOnHand: 1, available: "$totalOnHand", slots: 1 } }
  ]);

  res.status(200).json({
    success: true,
    message: "Stock by product calculated successfully.",
    data: rows[0] || { totalOnHand: 0, available: 0, slots: [] },
  });
});

/* =========================
   GET /api/slot-items/by-slot/:slotId
   Private/Admin
   Returns all products in a slot with qty
   ========================= */
export const getBySlot = asyncHandler(async (req, res) => {
  const { slotId } = req.params;
  const items = await SlotItem.find({ slot: slotId })
    .populate("product", "name sku cbm")
    .sort({ "product.sku": 1 });

  res.status(200).json({
    success: true,
    message: "Stock by slot retrieved successfully.",
    data: items,
  });
});

/* =========================
   POST /api/slot-items/receive
   Private/Admin
   Upsert/increase quantity in a slot (with 140% capacity cap)
   Body:
     - slotId (ObjectId, required)
     - productId (ObjectId, required)
     - productSKU (string, required)
     - qty (number > 0, required)
   ========================= */
export const receiveToSlot = asyncHandler(async (req, res) => {
  const { slotId, productId, productSKU, qty } = req.body || {};
  if (!slotId || !productId || !productSKU || !qty || Number(qty) <= 0) {
    res.status(400);
    throw new Error("slotId, productId, productSKU, and positive qty are required.");
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // Capacity check for adds to this slot
    const ok = await canFitUpTo140(slotId, [{ productId, qty: Number(qty) }], session);
    if (!ok) throw new Error("Receiving would exceed 140% of slot capacity.");

    const existing = await SlotItem.findOne({ slot: slotId, product: productId }).session(session);
    if (!existing) {
      const created = await SlotItem.create([{
        slot: slotId,
        product: productId,
        productSKU: String(productSKU).trim(),
        qty: Number(qty),
      }], { session });
      await session.commitTransaction(); session.endSession();
      return res.status(201).json({
        success: true,
        message: "Slot item created and quantity received.",
        data: created[0],
      });
    } else {
      existing.productSKU = String(productSKU).trim(); // keep SKU snapshot fresh
      existing.qty += Number(qty);
      const saved = await existing.save({ session });
      await session.commitTransaction(); session.endSession();
      return res.status(200).json({
        success: true,
        message: "Quantity received into existing slot item.",
        data: saved,
      });
    }
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    res.status(400).json({ success: false, message: err.message });
  }
});

/* =========================
   DELETE /api/slot-items/:id
   Private/Admin
   Removes a SlotItem join (danger if qty > 0)
   ========================= */
export const deleteSlotItem = asyncHandler(async (req, res) => {
  const item = await SlotItem.findById(req.params.id);
  if (!item) {
    res.status(404);
    throw new Error("Slot item not found.");
  }
  await item.deleteOne();
  res.status(200).json({ success: true, message: "Slot item deleted successfully.", slotItemId: item._id });
});
