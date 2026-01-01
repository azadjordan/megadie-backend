// controllers/productController.js
import mongoose from "mongoose";
import Product from "../models/productModel.js";
import FilterConfig from "../models/filterConfigModel.js";
import PriceRule from "../models/priceRuleModel.js";
import asyncHandler from "../middleware/asyncHandler.js";

/* =========================
   Helper utilities
   ========================= */

/**
 * Parse a comma-separated list or array into string[] (trimmed, non-empty)
 */
const parseStringList = (value) => {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  return raw
    .map((v) => (v == null ? "" : String(v)))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

/**
 * Parse a comma-separated list or array of IDs into ObjectId[]
 */
const parseIds = (input) => {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : String(input).split(",");
  return raw
    .map((s) => s?.trim())
    .filter(Boolean)
    .map((s) =>
      mongoose.isValidObjectId(s) ? new mongoose.Types.ObjectId(s) : null
    )
    .filter(Boolean);
};

/**
 * Pagination helper
 */
const parsePagination = (req, { defaultLimit = 48, maxLimit = 100 } = {}) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(
    Math.max(parseInt(req.query.limit, 10) || defaultLimit, 1),
    maxLimit
  );
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

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

/**
 * Build a sort object:
 * - Ribbons: curated "sort" field first
 * - Others: newest first
 */
const buildSort = (productType) => {
  if (productType === "Ribbon") {
    return { sort: 1, createdAt: -1, _id: 1 };
  }
  return { createdAt: -1, _id: 1 };
};

/**
 * Build attribute-level filters based on FilterConfig for a given productType.
 *
 * For each field:
 * - field.key is usually a Product field (size, color, grade, finish, tags, isAvailable, catalogCode, ...)
 * - some keys can be "virtual" (like categoryKeys) that are handled elsewhere and must be skipped here
 * - field.type: "enum", "boolean", "range", "text"
 * - field.multi: whether multiple values are allowed (for enum/text)
 */
const buildAttributeFilterFromConfig = (query, filterConfigDoc) => {
  const filter = {};
  if (!filterConfigDoc || !Array.isArray(filterConfigDoc.fields)) {
    return filter;
  }

  for (const field of filterConfigDoc.fields) {
    const key = field.key;
    const type = field.type;
    const multi = field.multi ?? true;

    // ❗ Skip virtual keys that are not real Product fields
    // (we already translate categoryKeys/categoryIds → category ObjectIds in buildProductFilter)
    if (key === "categoryKeys" || key === "categoryIds") {
      continue;
    }

    // Convention: accept both ?size=25 mm,13 mm and ?sizes=25 mm,13 mm
    const rawValue = query[key] ?? query[`${key}s`];
    if (rawValue === undefined) continue;

    // BOOLEAN filter
    if (type === "boolean") {
      const v = String(rawValue).toLowerCase();
      if (v === "true" || v === "1") filter[key] = true;
      else if (v === "false" || v === "0") filter[key] = false;
      continue;
    }

    // ENUM / TEXT → equality / $in
    if (type === "enum" || type === "text") {
      const values = parseStringList(rawValue);
      if (!values.length) continue;

      if (key === "tags") {
        // Any of the requested tags
        filter.tags = { $in: values };
      } else if (multi) {
        filter[key] = { $in: values };
      } else {
        filter[key] = values[0];
      }
      continue;
    }

    // RANGE filters can be added later for numeric fields like cbm or price.
  }

  return filter;
};

/**
 * Build the full Mongo filter for listing products (public or admin).
 * - Handles productType, categoryIds, categoryKeys
 * - Applies dynamic filters based on FilterConfig for the productType
 */
const buildProductFilter = async (req, { forAdmin = false } = {}) => {
  const { productType } = req.query;
  const filter = {};

  // Public listing must only show active products
  if (!forAdmin) {
    filter.isActive = true;
  }

  if (productType) {
    filter.productType = productType;
  }

  // Category IDs (?categoryIds=..., ?categoryId=...)
  const categoryIds = parseIds(req.query.categoryIds || req.query.categoryId);

  // Category keys → IDs (?categoryKeys=grosgrain,satin)
  let idsFromKeys = [];
  if (req.query.categoryKeys) {
    const keys = parseStringList(req.query.categoryKeys);
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
  if (allCategoryIds.length) {
    filter.category = { $in: allCategoryIds };
  }

  // Load FilterConfig for this productType (if any)
  let filterConfigDoc = null;
  if (productType) {
    filterConfigDoc = await FilterConfig.findOne({ productType }).lean();
  }

  // Apply config-driven filters (size, color, grade, finish, tags, isAvailable, catalogCode, etc.)
  const attributeFilter = buildAttributeFilterFromConfig(
    req.query,
    filterConfigDoc
  );
  Object.assign(filter, attributeFilter);

  return filter;
};

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
   GET /api/products
   Public
   Filtered products (shop view) with pagination
   ========================= */
export const getProducts = asyncHandler(async (req, res) => {
  const { productType } = req.query
  const { page, limit, skip } = parsePagination(req, {
    defaultLimit: 48,
    maxLimit: 100,
  })

  const filter = await buildProductFilter(req, { forAdmin: false })
  const sort = buildSort(productType)

  const [total, products] = await Promise.all([
    Product.countDocuments(filter),
    Product.find(filter)
      .select(
        "name productType category size color catalogCode variant grade finish packingUnit images sku priceRule sort"
      )
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
  ])

  const totalPages = Math.max(Math.ceil(total / limit), 1)

  res.status(200).json({
    success: true,
    message: "Products retrieved successfully.",
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasPrev: page > 1,
      hasNext: page < totalPages,
    },
    data: products,
  })
})

/* =========================
   GET /api/products/:id
   Public
   Get product by ID
   ========================= */
export const getProductById = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id)
    .populate("category", "name displayName productType key")
    .lean();

  if (!product) {
    res.status(404);
    throw new Error("Product not found.");
  }

  // Normalize _id → id
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

  const updated = await product.save(); // triggers validation + pre('validate') → sku + name

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
