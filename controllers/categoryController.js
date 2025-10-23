// controllers/categoryController.js
import asyncHandler from "../middleware/asyncHandler.js";
import Category from "../models/categoryModel.js";

/**
 * @desc   Get categories (with optional filters + pagination)
 * @route  GET /api/categories
 * @access Public
 * Query params:
 *  - productType=Ribbon|Creasing Matrix|Double Face Tape|...
 *  - isActive=true|false
 *  - q=search string (matches key or label)
 *  - page=1
 *  - limit=50
 */
export const getCategories = asyncHandler(async (req, res) => {
  const {
    productType,
    isActive,
    q,
    page = 1,
    limit = 50,
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
    .sort({ sort: 1, label: 1 }) // primary sort by "sort", then "label"
    .skip((pageNum - 1) * perPage)
    .limit(perPage);

  res.status(200).json({
    page: pageNum,
    pages: Math.ceil(total / perPage) || 1,
    limit: perPage,
    total,
    data: categories,
  });
});

/**
 * @desc   Get single category by ID
 * @route  GET /api/categories/:id
 * @access Public
 */
export const getCategoryById = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id);

  if (!category) {
    res.status(404);
    throw new Error("Category not found");
  }

  res.status(200).json(category);
});

/**
 * @desc   Create a category
 * @route  POST /api/categories
 * @access Admin
 * Body:
 *  - key (string, required)
 *  - label (string, required)
 *  - productType (string, required; must be in enum)
 *  - imageUrl (string, optional)
 *  - isActive (boolean, optional)
 *  - sort (number, optional)
 */
export const createCategory = asyncHandler(async (req, res) => {
  const { key, label, productType, imageUrl, isActive, sort } = req.body;

  if (!key || !label || !productType) {
    res.status(400);
    throw new Error("key, label, and productType are required");
  }

  const category = await Category.create({
    key: String(key).trim(),
    label: String(label).trim(),
    productType,
    imageUrl: imageUrl?.trim(),
    isActive: typeof isActive === "boolean" ? isActive : true,
    sort: typeof sort === "number" ? sort : 0,
  });

  res.status(201).json(category);
});

/**
 * @desc   Update a category
 * @route  PUT /api/categories/:id
 * @access Admin
 */
export const updateCategory = asyncHandler(async (req, res) => {
  const { key, label, productType, imageUrl, isActive, sort } = req.body;

  const category = await Category.findById(req.params.id);

  if (!category) {
    res.status(404);
    throw new Error("Category not found");
  }

  if (typeof key !== "undefined") category.key = String(key).trim();
  if (typeof label !== "undefined") category.label = String(label).trim();
  if (typeof productType !== "undefined") category.productType = productType;
  if (typeof imageUrl !== "undefined") category.imageUrl = imageUrl?.trim();
  if (typeof isActive !== "undefined") category.isActive = !!isActive;
  if (typeof sort !== "undefined") category.sort = Number(sort) || 0;

  const updated = await category.save();
  res.status(200).json(updated);
});

/**
 * @desc   Delete a category
 * @route  DELETE /api/categories/:id
 * @access Admin
 */
export const deleteCategory = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id);

  if (!category) {
    res.status(404);
    throw new Error("Category not found");
  }

  await category.deleteOne();
  res.status(200).json({ message: "Category removed", id: req.params.id });
});

/**
 * @desc   Delete ALL categories (danger!)
 * @route  DELETE /api/categories
 * @access Admin
 */
export const deleteAllCategories = asyncHandler(async (req, res) => {
  const result = await Category.deleteMany({});
  res
    .status(200)
    .json({ message: "All categories deleted", deletedCount: result.deletedCount });
});
