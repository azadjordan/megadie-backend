// controllers/priceRuleController.js
import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import PriceRule from "../models/priceRuleModel.js";
import Product from "../models/productModel.js";
import UserPrice from "../models/userPriceModel.js";
import Quote from "../models/quoteModel.js";
import { PRODUCT_TYPES } from "../constants.js";

const normalizeCode = (value) => String(value || "").trim().toUpperCase();
const normalizeProductType = (value) => String(value || "").trim();

const parseNonNegativeNumber = (res, raw, message) => {
  if (raw === "" || raw === null || raw === undefined) {
    res.status(400);
    throw new Error(message);
  }
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) {
    res.status(400);
    throw new Error(message);
  }
  return num;
};

const assertValidProductType = (res, productType) => {
  if (!PRODUCT_TYPES.includes(productType)) {
    res.status(400);
    throw new Error(
      `Invalid productType "${productType}". Allowed: ${PRODUCT_TYPES.join(", ")}`
    );
  }
};

/* =========================
   GET /api/price-rules
   Private/Admin
   List all price rules
   ========================= */
export const getPriceRules = asyncHandler(async (req, res) => {
  const rawProductType = normalizeProductType(req.query?.productType);
  const match = {};
  if (rawProductType) {
    assertValidProductType(res, rawProductType);
    match.productType = rawProductType;
  }

  const [rules, productUsage, userPriceUsage, quoteUsage] = await Promise.all([
    PriceRule.find(match)
      .select("code defaultPrice productType")
      .sort({ code: 1 })
      .lean(),
    Product.aggregate([
      { $match: { priceRule: { $ne: null } } },
      { $group: { _id: "$priceRule", count: { $sum: 1 } } },
    ]),
    UserPrice.aggregate([
      { $match: { priceRule: { $ne: null } } },
      { $group: { _id: "$priceRule", count: { $sum: 1 } } },
    ]),
    Quote.aggregate([
      { $unwind: "$requestedItems" },
      { $match: { "requestedItems.priceRule": { $ne: null } } },
      {
        $group: {
          _id: "$requestedItems.priceRule",
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const usageMap = new Map();
  const ensureUsage = (code) => {
    if (!usageMap.has(code)) {
      usageMap.set(code, { products: 0, userPrices: 0, quoteItems: 0 });
    }
    return usageMap.get(code);
  };

  productUsage.forEach((row) => {
    if (!row?._id) return;
    ensureUsage(row._id).products = row.count || 0;
  });
  userPriceUsage.forEach((row) => {
    if (!row?._id) return;
    ensureUsage(row._id).userPrices = row.count || 0;
  });
  quoteUsage.forEach((row) => {
    if (!row?._id) return;
    ensureUsage(row._id).quoteItems = row.count || 0;
  });

  const withUsage = rules.map((rule) => ({
    ...rule,
    usage: usageMap.get(rule.code) || {
      products: 0,
      userPrices: 0,
      quoteItems: 0,
    },
  }));

  res.status(200).json({
    success: true,
    message: "Price rules retrieved successfully.",
    data: withUsage,
  });
});

/* =========================
   POST /api/price-rules
   Private/Admin
   Create a price rule
   Body: { code, defaultPrice, productType }
   ========================= */
export const createPriceRule = asyncHandler(async (req, res) => {
  const { code, defaultPrice, productType: rawProductType } = req.body || {};
  const normalizedCode = normalizeCode(code);
  if (!normalizedCode) {
    res.status(400);
    throw new Error("code is required.");
  }

  const productType = normalizeProductType(rawProductType);
  if (!productType) {
    res.status(400);
    throw new Error("productType is required.");
  }
  assertValidProductType(res, productType);

  const price = parseNonNegativeNumber(
    res,
    defaultPrice,
    "defaultPrice is required and must be >= 0."
  );

  const existing = await PriceRule.findOne({ code: normalizedCode })
    .select("_id")
    .lean();
  if (existing) {
    res.status(409);
    throw new Error("Price rule already exists.");
  }

  const created = await PriceRule.create({
    code: normalizedCode,
    productType,
    defaultPrice: price,
  });

  res.status(201).json({
    success: true,
    message: "Price rule created successfully.",
    data: created,
  });
});

/* =========================
   PUT /api/price-rules/:id
   Private/Admin
   Update default price (and optional productType)
   Body: { defaultPrice, productType? }
   ========================= */
export const updatePriceRule = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!id || !mongoose.isValidObjectId(id)) {
    res.status(400);
    throw new Error("Valid price rule id is required.");
  }

  const rawProductType = req.body?.productType;
  const price = parseNonNegativeNumber(
    res,
    req.body?.defaultPrice,
    "defaultPrice is required and must be >= 0."
  );

  const rule = await PriceRule.findById(id);
  if (!rule) {
    res.status(404);
    throw new Error("Price rule not found.");
  }

  rule.defaultPrice = price;
  if (typeof rawProductType !== "undefined") {
    const productType = normalizeProductType(rawProductType);
    if (!productType) {
      res.status(400);
      throw new Error("productType is required.");
    }
    assertValidProductType(res, productType);
    rule.productType = productType;
  }
  const updated = await rule.save();

  res.status(200).json({
    success: true,
    message: "Price rule updated successfully.",
    data: updated,
  });
});

/* =========================
   DELETE /api/price-rules/:id
   Private/Admin
   Delete a price rule (blocked if in use)
   ========================= */
export const deletePriceRule = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!id || !mongoose.isValidObjectId(id)) {
    res.status(400);
    throw new Error("Valid price rule id is required.");
  }

  const rule = await PriceRule.findById(id);
  if (!rule) {
    res.status(404);
    throw new Error("Price rule not found.");
  }

  const code = rule.code;
  const [productCount, userPriceCount, quoteCount] = await Promise.all([
    Product.countDocuments({ priceRule: code }),
    UserPrice.countDocuments({ priceRule: code }),
    Quote.countDocuments({ "requestedItems.priceRule": code }),
  ]);

  if (productCount + userPriceCount + quoteCount > 0) {
    res.status(409);
    throw new Error(
      "Cannot delete price rule while it is used by products, user prices, or quotes."
    );
  }

  await rule.deleteOne();

  res.status(200).json({
    success: true,
    message: "Price rule deleted successfully.",
    data: { id: rule._id, code: rule.code },
  });
});
