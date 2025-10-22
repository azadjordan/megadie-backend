import Category from "../models/categoryModel.js";
import asyncHandler from "../middleware/asyncHandler.js";

// @desc    Get all categories
// @route   GET /api/categories
// @access  Public
const getCategories = asyncHandler(async (req, res) => {
  const categories = await Category.find({}).sort({ sort: 1 });
  res.json(categories);
});

// @desc    Get category by ID
// @route   GET /api/categories/:id
// @access  Public
const getCategoryById = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id);
  if (category) {
    res.json(category);
  } else {
    res.status(404);
    throw new Error("Category not found");
  }
});

// @desc    Create a new category
// @route   POST /api/categories
// @access  Private/Admin
const createCategory = asyncHandler(async (req, res) => {
  try {
    const category = new Category(req.body);
    const createdCategory = await category.save();
    res.status(201).json(createdCategory);
  } catch (error) {
    console.error("❌ Failed to create category:", error);

    if (error?.code === 11000) {
      res.status(409).json({
        message: "Category already exists for this product type.",
        keyValue: error.keyValue,
      });
    } else if (error?.name === "ValidationError") {
      res.status(400).json({
        message: "Validation failed. Check required fields and enums.",
        details: error.errors,
      });
    } else {
      res.status(500).json({ message: "Server error while creating category." });
    }
  }
});

// @desc    Update category
// @route   PUT /api/categories/:id
// @access  Private/Admin
const updateCategory = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id);

  if (!category) {
    res.status(404);
    throw new Error("Category not found");
  }

  Object.assign(category, req.body);
  const updatedCategory = await category.save();
  res.json(updatedCategory);
});

// @desc    Delete category
// @route   DELETE /api/categories/:id
// @access  Private/Admin
const deleteCategory = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id);

  if (!category) {
    res.status(404);
    throw new Error("Category not found");
  }

  await category.deleteOne();
  res.json({ message: "Category removed" });
});

// @desc    Delete all categories
// @route   DELETE /api/categories
// @access  Private/Admin
const deleteAllCategories = asyncHandler(async (req, res) => {
  try {
    const result = await Category.deleteMany({});
    res.json({
      message: `All categories deleted successfully.`,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error("❌ Failed to delete all categories:", error);
    res.status(500).json({ message: "Server error while deleting all categories." });
  }
});

export {
  getCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
  deleteAllCategories, // 👈 export it
};
