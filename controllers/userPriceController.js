// controllers/userPriceController.js
import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import UserPrice from "../models/userPriceModel.js";
import PriceRule from "../models/priceRuleModel.js";

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

/* =========================
   GET /api/user-prices/:userId
   Private/Admin
   List all prices for a user
   ========================= */
export const getUserPricesForUser = asyncHandler(async (req, res) => {
  const { userId } = req.params;

  if (!userId || !isValidObjectId(userId)) {
    res.status(400);
    throw new Error("Valid userId is required.");
  }

  const prices = await UserPrice.find({ user: userId })
    .sort({ priceRule: 1 })
    .lean();

  res.status(200).json({
    success: true,
    message: "User prices retrieved successfully.",
    data: prices,
  });
});

/* =========================
   POST /api/user-prices
   Private/Admin
   Create or update a user-specific price
   Body: { userId, priceRule, unitPrice }
   ========================= */
export const upsertUserPrice = asyncHandler(async (req, res) => {
  const { userId, priceRule, unitPrice } = req.body || {};

  if (!userId || !isValidObjectId(userId)) {
    res.status(400);
    throw new Error("Valid userId is required.");
  }

  const rule = String(priceRule || "").trim();
  if (!rule) {
    res.status(400);
    throw new Error("priceRule is required.");
  }

  const price = Number(unitPrice);
  if (!Number.isFinite(price) || price < 0) {
    res.status(400);
    throw new Error("unitPrice is required and must be >= 0.");
  }

  const ruleDoc = await PriceRule.findOne({ code: rule }).select("_id").lean();
  if (!ruleDoc) {
    res.status(400);
    throw new Error("priceRule must match an existing price rule.");
  }

  const doc = await UserPrice.findOneAndUpdate(
    { user: userId, priceRule: rule },
    { user: userId, priceRule: rule, unitPrice: price },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  res.status(200).json({
    success: true,
    message: "User price saved successfully.",
    data: doc,
  });
});

/* =========================
   DELETE /api/user-prices/:id
   Private/Admin
   Delete a specific user price
   ========================= */
export const deleteUserPrice = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!id || !isValidObjectId(id)) {
    res.status(400);
    throw new Error("Valid userPrice id is required.");
  }

  const doc = await UserPrice.findById(id);
  if (!doc) {
    res.status(404);
    throw new Error("User price not found.");
  }

  const snapshot = {
    id: doc._id,
    user: doc.user,
    priceRule: doc.priceRule,
  };

  await doc.deleteOne();

  res.status(200).json({
    success: true,
    message: "User price deleted successfully.",
    data: snapshot,
  });
});
