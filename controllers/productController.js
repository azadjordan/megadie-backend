// controllers/productController.js
import mongoose from "mongoose";
import Product from "../models/productModel.js";
import asyncHandler from "../middleware/asyncHandler.js";
import { getAvailabilityTotalsByProduct } from "../utils/quoteAvailability.js";
import {
  getCachedCategoryIdsByKeys,
  getCachedFilterConfig,
} from "../utils/productFilterCache.js";

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
export const parsePagination = (
  req,
  { defaultLimit = 48, maxLimit = 100 } = {}
) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(
    Math.max(parseInt(req.query.limit, 10) || defaultLimit, 1),
    maxLimit
  );
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

/**
 * Build a sort object:
 * - Ribbons: curated "sort" field first
 * - Others: newest first
 */
export const buildSort = (productType) => {
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
export const buildProductFilter = async (req, { forAdmin = false } = {}) => {
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
      idsFromKeys = await getCachedCategoryIdsByKeys({ productType, keys });
    }
  }

  const allCategoryIds = [...categoryIds, ...idsFromKeys];
  if (allCategoryIds.length) {
    filter.category = { $in: allCategoryIds };
  }

  // Load FilterConfig for this productType (if any)
  let filterConfigDoc = null;
  if (productType) {
    filterConfigDoc = await getCachedFilterConfig(productType);
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
  const featuredFirst = String(req.query.featuredFirst || "").toLowerCase()
  const includeAvailability =
    !["false", "0", "no"].includes(
      String(req.query.includeAvailability || "").toLowerCase()
    )
  const sortWithFeatured =
    featuredFirst === "true" || featuredFirst === "1"
      ? { isFeatured: -1, featuredRank: 1, ...sort }
      : sort

  const [total, products] = await Promise.all([
    Product.countDocuments(filter),
    Product.find(filter)
      .select(
        "name productType category size color catalogCode variant grade finish packingUnit images sku priceRule sort moq isAvailable"
      )
      .sort(sortWithFeatured)
      .skip(skip)
      .limit(limit)
      .lean(),
  ])

  let data = products.map((product) => ({
    ...product,
    availability: null,
  }))

  if (includeAvailability) {
    const availabilityCheckedAt = new Date()
    const totalsMap = await getAvailabilityTotalsByProduct(
      products.map((product) => product._id)
    )
    data = products.map((product) => ({
      ...product,
      availability: {
        availableNow: totalsMap.get(String(product._id)) || 0,
        checkedAt: availabilityCheckedAt,
      },
    }))
  }

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
    data,
  })
})

/* =========================
   POST /api/products/availability
   Public
   Batch availability snapshots for cart review
   ========================= */
export const getProductsAvailability = asyncHandler(async (req, res) => {
  const rawProductIds = Array.isArray(req.body?.productIds)
    ? req.body.productIds
    : [];

  const productIds = Array.from(
    new Set(
      rawProductIds
        .map((id) => (id == null ? "" : String(id).trim()))
        .filter(Boolean)
    )
  );

  if (productIds.length > 100) {
    res.status(400);
    throw new Error("Too many products requested.");
  }

  const validProductIds = productIds.filter((id) =>
    mongoose.Types.ObjectId.isValid(id)
  );

  const objectIds = validProductIds.map(
    (id) => new mongoose.Types.ObjectId(id)
  );

  const [products, totalsMap] = await Promise.all([
    objectIds.length
      ? Product.find({ _id: { $in: objectIds } })
          .select("_id isActive isAvailable")
          .lean()
      : [],
    getAvailabilityTotalsByProduct(validProductIds),
  ]);

  const productById = new Map(
    products.map((product) => [String(product._id), product])
  );
  const availabilityCheckedAt = new Date();

  const data = productIds.map((productId) => {
    const product = productById.get(productId);
    const isRequestable =
      Boolean(product) &&
      product.isActive !== false &&
      product.isAvailable !== false;

    return {
      productId,
      exists: Boolean(product),
      isAvailable: isRequestable,
      availability: {
        availableNow: product ? totalsMap.get(productId) || 0 : 0,
        checkedAt: availabilityCheckedAt,
      },
    };
  });

  res.status(200).json({
    success: true,
    message: "Product availability retrieved successfully.",
    data,
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
    .lean();

  if (!product) {
    res.status(404);
    throw new Error("Product not found.");
  }

  const availabilityCheckedAt = new Date();
  const totalsMap = await getAvailabilityTotalsByProduct([product._id]);
  product.availability = {
    availableNow: totalsMap.get(String(product._id)) || 0,
    checkedAt: availabilityCheckedAt,
  };

  // Normalize _id → id
  product.id = product._id;
  delete product._id;

  res.status(200).json({
    success: true,
    message: "Product retrieved successfully.",
    data: product,
  });
});
