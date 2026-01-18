// controllers/categoryController.js
import asyncHandler from "../middleware/asyncHandler.js";
import Category from "../models/categoryModel.js";
import Product from "../models/productModel.js";

/* =========================
   GET /api/categories
   Public
   Supports filters, search, and pagination
   ========================= */
export const getCategories = asyncHandler(async (req, res) => {
  const {
    productType,
    isActive,
    q,
    page = 1,
    limit = 50,
    includeUsage,
  } = req.query;

  const filter = {};
  if (productType) filter.productType = productType;
  if (typeof isActive !== "undefined") {
    filter.isActive = String(isActive).toLowerCase() === "true";
  }
  if (q && q.trim()) {
    const regex = { $regex: q.trim(), $options: "i" };
    filter.$or = [{ key: regex }, { label: regex }];
  }

  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const perPage = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

  const total = await Category.countDocuments(filter);
  const categories = await Category.find(filter)
    .sort({ sort: 1, label: 1 })
    .skip((pageNum - 1) * perPage)
    .limit(perPage)
    .lean();

  const includeUsageCounts =
    String(includeUsage || "").toLowerCase() === "true";

  let data = categories;
  if (includeUsageCounts && categories.length) {
    const categoryIds = categories.map((category) => category._id);
    const usageRows = await Product.aggregate([
      { $match: { category: { $in: categoryIds } } },
      { $group: { _id: "$category", count: { $sum: 1 } } },
    ]);

    const usageMap = new Map();
    usageRows.forEach((row) => {
      if (!row?._id) return;
      usageMap.set(String(row._id), row.count || 0);
    });

    data = categories.map((category) => {
      const usageCount = usageMap.get(String(category._id)) || 0;
      return {
        ...category,
        usageCount,
        canDelete: usageCount === 0,
      };
    });
  }

  res.status(200).json({
    success: true,
    message: "Categories retrieved successfully.",
    page: pageNum,
    pages: Math.ceil(total / perPage) || 1,
    limit: perPage,
    total,
    data,
  });
});

/* =========================
   GET /api/categories/:id
   Public
   Returns a single category by ID
   ========================= */
export const getCategoryById = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id);
  if (!category) {
    res.status(404);
    throw new Error("Category not found.");
  }

  res.status(200).json({
    success: true,
    message: "Category retrieved successfully.",
    data: category,
  });
});

/* =========================
   POST /api/categories
   Private/Admin
   Body:
     - key (string, required)
     - label (string, required)
     - productType (string, required; must match enum)
     - imageUrl (string, optional)
     - isActive (boolean|string, optional)
     - sort (number|string, optional)
   ========================= */
export const createCategory = asyncHandler(async (req, res) => {
  const { key, label, productType, imageUrl, isActive, sort } = req.body || {};

  if (!key || !label || !productType) {
    res.status(400);
    throw new Error("key, label, and productType are required.");
  }

  const trimmedKey = String(key).trim();
  const trimmedLabel = String(label).trim();

  // Normalise isActive (supports boolean or "true"/"false" strings)
  let isActiveValue = true;
  if (typeof isActive !== "undefined") {
    isActiveValue =
      typeof isActive === "boolean"
        ? isActive
        : String(isActive).toLowerCase() === "true";
  }

  // Normalise sort (supports numbers or numeric strings)
  let sortValue = 0;
  if (typeof sort !== "undefined") {
    const num = Number(sort);
    sortValue = Number.isFinite(num) ? num : 0;
  }

  const category = await Category.create({
    key: trimmedKey,
    label: trimmedLabel,
    productType,
    imageUrl: typeof imageUrl === "string" ? imageUrl.trim() : undefined,
    isActive: isActiveValue,
    sort: sortValue,
  });

  res.status(201).json({
    success: true,
    message: "Category created successfully.",
    data: category,
  });
});

/* =========================
   PUT /api/categories/:id
   Private/Admin
   Updates existing category fields
   ========================= */
export const updateCategory = asyncHandler(async (req, res) => {
  const { key, label, productType, imageUrl, isActive, sort } = req.body || {};

  const category = await Category.findById(req.params.id);
  if (!category) {
    res.status(404);
    throw new Error("Category not found.");
  }

  const changes = {};

  // Safe key update (String + trim)
  if (typeof key !== "undefined") {
    const nextKey = String(key).trim();
    if (nextKey !== category.key) {
      changes.key = { from: category.key, to: nextKey };
      category.key = nextKey;
    }
  }

  // Safe label update (String + trim)
  if (typeof label !== "undefined") {
    const nextLabel = String(label).trim();
    if (nextLabel !== category.label) {
      changes.label = { from: category.label, to: nextLabel };
      category.label = nextLabel;
    }
  }

  // productType (assumed string / enum handled by schema)
  if (typeof productType !== "undefined" && productType !== category.productType) {
    changes.productType = { from: category.productType, to: productType };
    category.productType = productType;
  }

  // Safe imageUrl update
  if (typeof imageUrl !== "undefined") {
    const nextImageUrl =
      typeof imageUrl === "string" ? imageUrl.trim() : undefined;

    if (nextImageUrl !== category.imageUrl) {
      changes.imageUrl = { from: category.imageUrl, to: nextImageUrl };
      category.imageUrl = nextImageUrl;
    }
  }

  // Normalised isActive update (boolean or "true"/"false" string)
  if (typeof isActive !== "undefined") {
    const nextIsActive =
      typeof isActive === "boolean"
        ? isActive
        : String(isActive).toLowerCase() === "true";

    if (nextIsActive !== category.isActive) {
      changes.isActive = { from: category.isActive, to: nextIsActive };
      category.isActive = nextIsActive;
    }
  }

  // Safe sort update (number or numeric string)
  if (typeof sort !== "undefined") {
    const nextSort = Number(sort);
    if (Number.isFinite(nextSort) && nextSort !== category.sort) {
      changes.sort = { from: category.sort, to: nextSort };
      category.sort = nextSort;
    }
  }

  const updated = await category.save();

  const changedKeys = Object.keys(changes);
  const message = changedKeys.length
    ? `Category updated successfully (${changedKeys.join(", ")}).`
    : "Category saved (no changes detected).";

  res.status(200).json({
    success: true,
    message,
    changed: changes,
    data: updated,
  });
});

/* =========================
   DELETE /api/categories/:id
   Private/Admin
   Deletes a specific category
   ========================= */
export const deleteCategory = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id);
  if (!category) {
    res.status(404);
    throw new Error("Category not found.");
  }

  const usageCount = await Product.countDocuments({ category: category._id });
  if (usageCount > 0) {
    res.status(409);
    throw new Error("Cannot delete category while it is used by products.");
  }

  await category.deleteOne();

  res.status(200).json({
    success: true,
    message: `Category '${category.label}' deleted successfully.`,
    categoryId: category._id,
  });
});
