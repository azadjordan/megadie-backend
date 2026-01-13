// controllers/productAdminController.js
import Product from "../models/productModel.js";
import PriceRule from "../models/priceRuleModel.js";
import asyncHandler from "../middleware/asyncHandler.js";
import {
  buildProductFilter,
  parsePagination,
  buildSort,
} from "./productController.js";
import {
  PRODUCT_TYPES,
  TAGS,
  SIZES,
  GRADES,
  VARIANTS,
  FINISHES,
  PACKING_UNITS,
  ribbonCatalogCodes,
} from "../constants.js";

const ensureValidPriceRule = async (res, rawRule) => {
  const rule = String(rawRule || "").trim();
  if (!rule) {
    res.status(400);
    throw new Error("priceRule is required.");
  }

  const exists = await PriceRule.findOne({ code: rule }).select("_id").lean();
  if (!exists) {
    res.status(400);
    throw new Error("priceRule must match an existing price rule.");
  }

  return rule;
};

/* =========================
   GET /api/products/meta
   Private/Admin
   Returns product enums and catalog codes for create/edit UI
   ========================= */
export const getProductMeta = asyncHandler(async (_req, res) => {
  res.status(200).json({
    success: true,
    message: "Product meta retrieved successfully.",
    data: {
      productTypes: PRODUCT_TYPES,
      sizes: SIZES,
      grades: GRADES,
      variants: VARIANTS,
      finishes: FINISHES,
      packingUnits: PACKING_UNITS,
      tags: TAGS,
      ribbonCatalogCodes,
    },
  });
});

/* =========================
   POST /api/products
   Private/Admin
   Create a new product
   ========================= */
export const createProduct = asyncHandler(async (req, res) => {
  const payload = { ...(req.body || {}) };
  payload.priceRule = await ensureValidPriceRule(res, payload.priceRule);

  const product = new Product(payload); // model handles validation + sku + name
  const created = await product.save();

  res.setHeader("Location", `/api/products/${created._id}`);

  res.status(201).json({
    success: true,
    message: "Product created successfully.",
    data: created,
  });
});

/* =========================
   GET /api/products/admin
   Private/Admin
   Filtered products for admin view (optional pagination)
   ========================= */
export const getProductsAdmin = asyncHandler(async (req, res) => {
  const { productType } = req.query;

  const hasPaging = !!(req.query.page || req.query.limit);
  const { page, limit, skip } = parsePagination(req, {
    defaultLimit: 50,
    maxLimit: 200,
  });

  const filter = await buildProductFilter(req, { forAdmin: true });
  const sort = buildSort(productType);

  if (hasPaging) {
    const [total, products] = await Promise.all([
      Product.countDocuments(filter),
      Product.find(filter)
        .populate("category", "name displayName productType key")
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const totalPages = Math.max(Math.ceil(total / limit), 1);

    return res.status(200).json({
      success: true,
      message: "Products (admin) retrieved successfully.",
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasPrev: page > 1,
        hasNext: page < totalPages,
      },
      data: products,
    });
  }

  const products = await Product.find(filter)
    .populate("category", "name displayName productType key")
    .sort(sort)
    .lean();

  res.status(200).json({
    success: true,
    message: "Products (admin) retrieved successfully.",
    data: products,
  });
});

/* =========================
   PUT /api/products/:id
   Private/Admin
   Update product (auto-rebuilds sku & name via model hook)
   ========================= */
export const updateProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) {
    res.status(404);
    throw new Error("Product not found.");
  }

  const incoming = { ...(req.body || {}) };
  if (Object.prototype.hasOwnProperty.call(incoming, "priceRule")) {
    incoming.priceRule = await ensureValidPriceRule(res, incoming.priceRule);
  }
  const changes = {};

  Object.keys(incoming).forEach((key) => {
    // Skip immutable / derived fields
    if (key === "_id" || key === "id" || key === "sku") return;

    const before = product[key];
    const after = incoming[key] ?? before;

    const changed =
      (before instanceof Date &&
        after instanceof Date &&
        +before !== +after) ||
      (!(before instanceof Date) && before !== after);

    if (changed) {
      changes[key] = { from: before ?? null, to: after ?? null };
      product[key] = after;
    }
  });

  const updated = await product.save(); // triggers validation + pre('validate') -> sku + name

  const changedKeys = Object.keys(changes);
  const message = changedKeys.length
    ? `Product updated successfully (${changedKeys.join(", ")}).`
    : "Product saved (no changes detected).";

  res.status(200).json({
    success: true,
    message,
    changed: changes,
    data: updated,
  });
});

/* =========================
   DELETE /api/products/:id
   Private/Admin
   Delete product
   ========================= */
export const deleteProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) {
    res.status(404);
    throw new Error("Product not found.");
  }

  const snapshot = {
    productId: product._id,
    name: product.name,
    sku: product.sku,
  };

  await product.deleteOne();

  res.status(200).json({
    success: true,
    message: "Product deleted successfully.",
    data: snapshot,
  });
});
