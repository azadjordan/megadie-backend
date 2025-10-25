// controllers/productController.js
import mongoose from "mongoose";
import Product from "../models/productModel.js";
import asyncHandler from "../middleware/asyncHandler.js";

// ------------------------
// Helpers
// ------------------------
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
    const clean = values.filter((x) => x !== undefined && x !== null && String(x).length > 0);
    if (clean.length) filter[key] = { $in: clean };
  }
};

const parsePagination = (req, { defaultLimit = 48, maxLimit = 100 } = {}) => {
  const page  = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || defaultLimit, 1), maxLimit);
  const skip  = (page - 1) * limit;
  return { page, limit, skip };
};

// ------------------------
// Create
// ------------------------
// @desc    Create a new product
// @route   POST /api/products
// @access  Private/Admin
const createProduct = asyncHandler(async (req, res) => {
  try {
    const product = new Product(req.body);
    const created = await product.save();
    res.status(201).json(created);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        message: "Duplicate SKU — please modify one of the product fields to make it unique.",
        keyValue: error.keyValue,
      });
    }
    if (error?.name === "ValidationError") {
      return res.status(400).json({
        message: "Validation failed. Check provided values.",
        details: error.errors,
      });
    }
    console.error("❌ Failed to create product:", error);
    res.status(500).json({ message: "Server error while creating product." });
  }
});

// ------------------------
// Public listing (shop)
// ------------------------
// @desc    Get filtered products (public-facing shop view) with pagination
// @route   GET /api/products
// @access  Public
const getProducts = asyncHandler(async (req, res) => {
  const { productType } = req.query;
  const { page, limit, skip } = parsePagination(req, { defaultLimit: 48, maxLimit: 100 });

  const filter = { isActive: true }; // Hide inactive by default
  const sort = {};

  if (productType) {
    filter.productType = productType;
    if (productType === "Ribbon") sort.sort = 1;         // curated order
    else sort.createdAt = -1;                             // newest first
  } else {
    sort.createdAt = -1;
  }

  // Category filter
  const categoryIds = parseIds(req.query.categoryIds);
  if (categoryIds.length) filter.category = { $in: categoryIds };

  // Attributes filter
  applyAttributesFilter(filter, req.query.attributes);

  const [total, products] = await Promise.all([
    Product.countDocuments(filter),
    Product.find(filter)
      .select("name images price size parentColor variant sku sort isAvailable productType category") // public projection
      .sort(Object.keys(sort).length ? sort : { createdAt: -1, _id: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  const totalPages = Math.max(Math.ceil(total / limit), 1);

  res.json({
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

// ------------------------
// Admin listing
// ------------------------
// @desc    Get filtered products for admin view (optional pagination)
// @route   GET /api/products/admin
// @access  Private/Admin
const getProductsAdmin = asyncHandler(async (req, res) => {
  const { productType } = req.query;

  // optional pagination for admin; pass ?page and ?limit to use it
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

    return res.json({
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

  // No pagination requested → return full list (be careful on very large datasets)
  const products = await Product.find(filter)
    .populate("category", "name displayName productType key")
    .sort(Object.keys(sort).length ? sort : { createdAt: -1, _id: 1 })
    .lean();

  res.json(products);
});

// ------------------------
// Get by id
// ------------------------
// @desc    Get product by ID
// @route   GET /api/products/:id
// @access  Public
const getProductById = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400);
    throw new Error("Invalid product id");
  }

  const product = await Product.findById(req.params.id)
    .populate("category", "name displayName productType key")
    .lean();

  if (!product) {
    res.status(404);
    throw new Error("Product not found");
  }

  res.json(product);
});

// ------------------------
// Update
// ------------------------
// @desc    Update product
// @route   PUT /api/products/:id
// @access  Private/Admin
const updateProduct = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400);
    throw new Error("Invalid product id");
  }

  const product = await Product.findById(req.params.id);
  if (!product) {
    res.status(404);
    throw new Error("Product not found");
  }

  // Assign only provided keys (null/undefined handled by ??)
  Object.keys(req.body).forEach((key) => {
    product[key] = req.body[key] ?? product[key];
  });

  try {
    const updated = await product.save();
    res.json(updated);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        message: "Duplicate SKU after update — adjust fields to make SKU unique.",
        keyValue: error.keyValue,
      });
    }
    if (error?.name === "ValidationError") {
      return res.status(400).json({
        message: "Validation failed. Check provided values.",
        details: error.errors,
      });
    }
    console.error("❌ Failed to update product:", error);
    res.status(500).json({ message: "Server error while updating product." });
  }
});

// ------------------------
// Delete
// ------------------------
// @desc    Delete product
// @route   DELETE /api/products/:id
// @access  Private/Admin
const deleteProduct = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400);
    throw new Error("Invalid product id");
  }

  const product = await Product.findById(req.params.id);
  if (!product) {
    res.status(404);
    throw new Error("Product not found");
  }

  await product.deleteOne();
  res.json({ message: "Product removed" });
});

export {
  getProducts,
  getProductsAdmin,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
};
