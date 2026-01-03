import asyncHandler from "../middleware/asyncHandler.js";
import mongoose from "mongoose";
import SlotItem from "../models/slotItemModel.js";

/* =========================
   GET /api/slot-items/by-product/:productId
   Lists all slot items for a product (for picking UI)
   ========================= */
export const getSlotItemsByProduct = asyncHandler(async (req, res) => {
  const { productId } = req.params;

  if (!mongoose.isValidObjectId(productId)) {
    res.status(400);
    throw new Error("Invalid product id.");
  }

  const items = await SlotItem.find({ product: productId })
    .populate("slot", "label store unit position")
    .sort({ qty: 1, createdAt: -1 })
    .lean();

  res.status(200).json({
    success: true,
    message: "Slot items retrieved successfully.",
    data: items,
  });
});
