import asyncHandler from "../middleware/asyncHandler.js";
import Category from "../models/categoryModel.js";

// @desc    Get all categories
// @route   GET /api/categories
// @access  Public
const getCategories = asyncHandler(async (req, res) => {
  const categories = await Category.find().sort({ position: 1, name: 1 });
  res.json(categories);
});

// @desc    Get category by ID
// @route   GET /api/categories/:id
// @access  Public
const getCategoryById = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id);
  if (!category) {
    res.status(404);
    throw new Error("Category not found");
  }
  res.json(category);
});

// @desc    Create a new category with dummy data
// @route   POST /api/categories
// @access  Admin
const createCategory = asyncHandler(async (req, res) => {
  const timestamp = Date.now();

  const category = new Category({
    name: `Sample Category ${timestamp}`,
    displayName: `Sample Display ${timestamp}`, // ✅ NEW
    productType: "Ribbon",
    filters: [
      {
        Key: "Width",
        displayName: "Width",
        values: ["1-inch", "0.5-inch"],
        order: 0, // ✅ NEW
      },
    ],
    description: "This is a sample category. You can update it later.",
    position: 0,
    isActive: true,
    image: `https://picsum.photos/seed/${timestamp}/300/200`,
  });
  

  const created = await category.save();
  res.status(201).json(created);
});

// @desc    Update category
// @route   PUT /api/categories/:id
// @access  Admin
const updateCategory = asyncHandler(async (req, res) => {
  const {
    name,
    displayName,
    productType,
    filters,
    description,
    position,
    isActive,
    image,
  } = req.body;

  const category = await Category.findById(req.params.id);
  if (!category) {
    res.status(404);
    throw new Error("Category not found");
  }

  category.name = name ?? category.name;
  category.displayName = displayName ?? category.displayName;
  category.productType = productType ?? category.productType;
  category.filters = filters ?? category.filters;
  category.description = description ?? category.description;
  category.position = position ?? category.position;
  category.isActive = isActive ?? category.isActive;
  category.image = image ?? category.image;

  const updated = await category.save();
  res.json(updated);
});

// @desc    Delete category
// @route   DELETE /api/categories/:id
// @access  Admin
const deleteCategory = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id);
  if (!category) {
    res.status(404);
    throw new Error("Category not found");
  }

  await category.deleteOne();
  res.json({ message: "Category deleted" });
});

export {
  getCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
};
