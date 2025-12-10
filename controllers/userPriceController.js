// controllers/userPriceController.js
import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import UserPrice from "../models/userPriceModel.js";
import { PRICE_RULES } from "../constants.js";

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

/* =========================
   POST /api/user-prices
   Private/Admin
   Create or update a user-specific price (Pricing page only)
   Body: { userId, priceRule, unitPrice }
   ========================= */
export const upsertUserPrice = asyncHandler(async (req, res) => {
  const { userId, priceRule, unitPrice } = req.body || {};

  if (!userId || !isValidObjectId(userId)) {
    res.status(400);
    throw new Error("Valid userId is required.");
  }

  if (!priceRule || !PRICE_RULES.includes(priceRule)) {
    res.status(400);
    throw new Error("priceRule is required and must be a valid price rule.");
  }

  if (unitPrice === undefined || unitPrice === null || Number(unitPrice) < 0) {
    res.status(400);
    throw new Error("unitPrice is required and must be >= 0.");
  }

  const doc = await UserPrice.findOneAndUpdate(
    { user: userId, priceRule },
    { user: userId, priceRule, unitPrice },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  res.status(200).json({
    success: true,
    message: "User price saved successfully.",
    data: doc,
  });
});

/* =========================
   GET /api/user-prices/:userId
   Private/Admin
   Pricing page: list all price rules that this user has set
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
   DELETE /api/user-prices/:id
   Private/Admin
   Optional: remove a specific user price record (Pricing page)
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

/* =========================
   GET /api/user-prices/rules
   Private/Admin
   Pricing page: list all possible PRICE_RULES
   (so UI can show dropdown of rules to choose from)
   ========================= */
export const getAllPriceRules = asyncHandler(async (_req, res) => {
  res.status(200).json({
    success: true,
    message: "Price rules retrieved successfully.",
    data: PRICE_RULES,
  });
});

/* =========================
   POST /api/user-prices/resolve
   Private (Quote page)
   Read-only: given userId + priceRules, return known prices.
   Body:
   {
     "userId": "...",
     "priceRules": ["RIB-GRO-25MM-100YD-PREM-ROLL", ...]
   }

   Response:
   {
     success: true,
     data: [
       { priceRule, unitPrice, found: true },
       { priceRule, unitPrice: null, found: false },
       ...
     ]
   }
   ========================= */
export const resolveUserPrices = asyncHandler(async (req, res) => {
  const { userId, priceRules } = req.body || {};

  if (!userId || !isValidObjectId(userId)) {
    res.status(400);
    throw new Error("Valid userId is required.");
  }

  const requestedRules = Array.isArray(priceRules)
    ? priceRules.filter((r) => typeof r === "string" && r.trim().length > 0)
    : [];

  if (!requestedRules.length) {
    res.status(400);
    throw new Error("priceRules must be a non-empty array of strings.");
  }

  const validRequestedRules = requestedRules.filter((r) =>
    PRICE_RULES.includes(r)
  );

  if (!validRequestedRules.length) {
    res.status(400);
    throw new Error("No valid priceRules provided.");
  }

  const docs = await UserPrice.find({
    user: userId,
    priceRule: { $in: validRequestedRules },
  })
    .select("priceRule unitPrice")
    .lean();

  const byRule = new Map(docs.map((d) => [d.priceRule, d]));

  const result = validRequestedRules.map((rule) => {
    const hit = byRule.get(rule);
    if (!hit) {
      return { priceRule: rule, unitPrice: null, found: false };
    }
    return { priceRule: rule, unitPrice: hit.unitPrice, found: true };
  });

  res.status(200).json({
    success: true,
    message: "User prices resolved successfully.",
    data: result,
  });
});
