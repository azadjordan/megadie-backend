import mongoose from "mongoose";
import Product from "../models/productModel.js";
import asyncHandler from "../middleware/asyncHandler.js";

/* =========================
   Helpers
   ========================= */
const ALLOWED_ATTRS = new Set([
  "size", "parentColor", "variant", "grade", "source", "packingUnit",
  "catalogCode", "color", "isAvailable",
]);

const parseIds = (input) => {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : String(input).split(",");
  return raw
    .map((s) => s?.trim())
    .filter(Boolean)
    .map((s) => (mongoose.isValidObjectId(s) ? new mongoose.Types.ObjectId(s) : null))
    .filter(Boolean);
};

const applyAttributesFilter = (filter, attributesObj) => {
  if (!attributesObj || typeof attributesObj !== "object") return;
  for (const key of Object.keys(attributesObj)) {
    if (!ALLOWED_ATTRS.has(key)) continue;
    const v = attributesObj[key];
    const values = Array.isArray(v) ? v : [v];
    const clean = values
      .map((x) => (x === undefined || x === null ? "" : String(x)))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (clean.length) filter[key] = { $in: clean };
  }
};

const parsePagination = (req, { defaultLimit = 48, maxLimit = 100 } = {}) => {
  const page  = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || defaultLimit, 1), maxLimit);
  const skip  = (page - 1) * limit;
  return { page, limit, skip };
};

/* =========================
   POST /api/products
   Private/Admin
   Create a new product
   ========================= */
export const createProduct = asyncHandler(async (req, res) => {
  const product = new Product(req.body);
  const created = await product.save(); // validations + hooks

  res.setHeader("Location", `/api/products/${created._id}`);

  res.status(201).json({
    success: true,
    message: "Product created successfully.",
    data: created,
  });
});

/* =========================
   GET /api/products
   Public
   Filtered products (shop view) with pagination
   ========================= */
export const getProducts = asyncHandler(async (req, res) => {
  const { productType } = req.query;
  const { page, limit, skip } = parsePagination(req, { defaultLimit: 48, maxLimit: 100 });

  // Only active products on the public shop
  const filter = { isActive: true };
  const sort = {};

  if (productType) {
    filter.productType = productType;
    // Curated ordering for Ribbons, otherwise newest first
    if (productType === "Ribbon") sort.sort = 1;
    else sort.createdAt = -1;
  } else {
    sort.createdAt = -1;
  }

  // Category filter: by ids
  const categoryIds = parseIds(req.query.categoryIds);

  // Category filter: by keys (map to ids)
  let idsFromKeys = [];
  if (req.query.categoryKeys) {
    const keys = Array.isArray(req.query.categoryKeys)
      ? req.query.categoryKeys
      : String(req.query.categoryKeys)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

    if (keys.length) {
      const Category = mongoose.model("Category");
      const cats = await Category.find({
        key: { $in: keys },
        ...(productType ? { productType } : {}),
      })
        .select("_id")
        .lean();
      idsFromKeys = cats.map((c) => c._id);
    }
  }

  const allCategoryIds = [...categoryIds, ...idsFromKeys];
  if (allCategoryIds.length) filter.category = { $in: allCategoryIds };

  // Attributes filter (size, parentColor, variant, etc.)
  applyAttributesFilter(filter, req.query.attributes);

  const [total, products] = await Promise.all([
    Product.countDocuments(filter),
    Product.find(filter)
      // Lean card payload for shop listing
      .select("name displaySpecs moq images price sku isAvailable")
      .sort(Object.keys(sort).length ? sort : { createdAt: -1, _id: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  const totalPages = Math.max(Math.ceil(total / limit), 1);

  res.status(200).json({
    success: true,
    message: "Products retrieved successfully.",
    data: products,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasPrev: page > 1,
      hasNext: page < totalPages,
    },
  });
});

/* =========================
   GET /api/products/:id
   Public
   Get product by ID
   ========================= */
export const getProductById = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id)
    .populate("category", "name displayName productType key")
    .lean(); // return ALL fields

  if (!product) {
    res.status(404);
    throw new Error("Product not found.");
  }

  // Normalize _id → id for frontend consistency (lean() bypasses toJSON())
  product.id = product._id;
  delete product._id;

  res.status(200).json({
    success: true,
    message: "Product retrieved successfully.",
    data: product,
  });
});

/* =========================
   GET /api/products/admin
   Private/Admin
   Filtered products for admin view (optional pagination)
   ========================= */
export const getProductsAdmin = asyncHandler(async (req, res) => {
  const { productType } = req.query;

  // optional pagination; pass ?page and ?limit to use it
  const hasPaging = !!(req.query.page || req.query.limit);
  const { page, limit, skip } = parsePagination(req, { defaultLimit: 50, maxLimit: 200 });

  const filter = {};
  const sort = {};

  if (productType) {
    filter.productType = productType;
    if (productType === "Ribbon") sort.sort = 1;
    else sort.createdAt = -1;
  } else {
    sort.createdAt = -1;
  }

  const categoryIds = parseIds(req.query.categoryIds);
  if (categoryIds.length) filter.category = { $in: categoryIds };

  applyAttributesFilter(filter, req.query.attributes);

  if (hasPaging) {
    const [total, products] = await Promise.all([
      Product.countDocuments(filter),
      Product.find(filter)
        .populate("category", "name displayName productType key")
        .sort(Object.keys(sort).length ? sort : { createdAt: -1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const totalPages = Math.max(Math.ceil(total / limit), 1);

    return res.status(200).json({
      success: true,
      message: "Products (admin) retrieved successfully.",
      data: products,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasPrev: page > 1,
        hasNext: page < totalPages,
      },
    });
  }

  const products = await Product.find(filter)
    .populate("category", "name displayName productType key")
    .sort(Object.keys(sort).length ? sort : { createdAt: -1, _id: 1 })
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
   Update product (records a small diff)
   ========================= */
export const updateProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id); // CastError → error middleware
  if (!product) {
    res.status(404);
    throw new Error("Product not found.");
  }

  const changes = {};
  const incoming = req.body || {};

  Object.keys(incoming).forEach((key) => {
    // Skip immutable Mongo fields
    if (key === "_id" || key === "id") return;

    const before = product[key];
    const after  = incoming[key] ?? before;

    // Only record/apply if actually different
    const changed =
      (before instanceof Date && after instanceof Date && +before !== +after) ||
      (!(before instanceof Date) && before !== after);

    if (changed) {
      changes[key] = { from: before ?? null, to: after ?? null };
      product[key] = after;
    }
  });

  const updated = await product.save(); // validations + hooks

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
  const product = await Product.findById(req.params.id); // CastError → error middleware
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
    ...snapshot,
  });
});
