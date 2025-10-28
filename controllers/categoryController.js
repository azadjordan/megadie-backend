// controllers/categoryController.js
import asyncHandler from "../middleware/asyncHandler.js";
import Category from "../models/categoryModel.js";

/* =========================
   GET /api/categories
   Public
   Supports filters, search, and pagination
   ========================= */
export const getCategories = asyncHandler(async (req, res) => {
  const { productType, isActive, q, page = 1, limit = 50 } = req.query;

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
    .limit(perPage);

  res.status(200).json({
    success: true,
    message: "Categories retrieved successfully.",
    page: pageNum,
    pages: Math.ceil(total / perPage) || 1,
    limit: perPage,
    total,
    data: categories,
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
     - isActive (boolean, optional)
     - sort (number, optional)
   ========================= */
export const createCategory = asyncHandler(async (req, res) => {
  const { key, label, productType, imageUrl, isActive, sort } = req.body || {};

  if (!key || !label || !productType) {
    res.status(400);
    throw new Error("key, label, and productType are required.");
  }

  const category = await Category.create({
    key: String(key).trim(),
    label: String(label).trim(),
    productType,
    imageUrl: typeof imageUrl === "string" ? imageUrl.trim() : undefined,
    isActive: typeof isActive === "boolean" ? isActive : true,
    sort: typeof sort === "number" ? sort : 0,
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

  if (typeof key !== "undefined" && key.trim() !== category.key) {
    changes.key = { from: category.key, to: key.trim() };
    category.key = key.trim();
  }
  if (typeof label !== "undefined" && label.trim() !== category.label) {
    changes.label = { from: category.label, to: label.trim() };
    category.label = label.trim();
  }
  if (typeof productType !== "undefined" && productType !== category.productType) {
    changes.productType = { from: category.productType, to: productType };
    category.productType = productType;
  }
  if (typeof imageUrl !== "undefined" && imageUrl !== category.imageUrl) {
    changes.imageUrl = { from: category.imageUrl, to: imageUrl };
    category.imageUrl = imageUrl?.trim();
  }
  if (typeof isActive !== "undefined" && isActive !== category.isActive) {
    changes.isActive = { from: category.isActive, to: !!isActive };
    category.isActive = !!isActive;
  }
  if (typeof sort !== "undefined" && Number(sort) !== category.sort) {
    changes.sort = { from: category.sort, to: Number(sort) };
    category.sort = Number(sort);
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

  await category.deleteOne();

  res.status(200).json({
    success: true,
    message: `Category '${category.label}' deleted successfully.`,
    categoryId: category._id,
  });
});

/* =========================
   DELETE /api/categories
   Private/Admin
   Danger: Deletes ALL categories
   ========================= */
export const deleteAllCategories = asyncHandler(async (_req, res) => {
  const result = await Category.deleteMany({});
  const deletedCount = result.deletedCount || 0;

  res.status(200).json({
    success: true,
    message: `All categories deleted successfully. (${deletedCount} removed.)`,
    deletedCount,
  });
});
