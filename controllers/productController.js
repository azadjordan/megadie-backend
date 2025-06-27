import Product from "../models/productModel.js";
import asyncHandler from "../middleware/asyncHandler.js";

// @desc    Get filtered products for admin view
// @route   GET /api/products/admin
// @access  Private/Admin
const getProductsAdmin = async (req, res) => {
  const { productType, categoryIds } = req.query;
  const filter = {};
  const sort = {};

  if (productType) {
    filter.productType = productType;

    // Admins also benefit from structured sorting for Ribbons
    if (productType === "Ribbon") {
      sort.sort = 1;
    } else {
      sort.createdAt = -1;
    }
  } else {
    sort.createdAt = -1; // default sort if no productType specified
  }

  if (categoryIds) {
    const ids = Array.isArray(categoryIds) ? categoryIds : [categoryIds];
    filter.category = { $in: ids };
  }

  if (req.query.attributes) {
    for (const key in req.query.attributes) {
      const values = req.query.attributes[key];
      filter[key] = {
        $in: Array.isArray(values) ? values : [values],
      };
    }
  }

  const products = await Product.find(filter)
    .populate("category", "name displayName productType")
    .sort(sort);

  res.json(products);
};

// @desc    Get filtered products (public-facing shop view)
// @route   GET /api/products
// @access  Public
const getProducts = async (req, res) => {
  const { productType, categoryIds } = req.query;
 
  const filter = {};
  const sort = {};

  if (productType) {
    filter.productType = productType;

    // Sort Ribbon products by numeric sort field
    if (productType === "Ribbon") {
      sort.sort = 1; // ascending
    }
  }

  if (categoryIds) {
    const ids = Array.isArray(categoryIds) ? categoryIds : [categoryIds];
    filter.category = { $in: ids };
  }

  if (req.query.attributes) {
    for (const key in req.query.attributes) {
      const values = req.query.attributes[key];
      filter[key] = {
        $in: Array.isArray(values) ? values : [values],
      };
    }
  }

  const products = await Product.find(filter).sort(sort);
  res.json(products);
};

// @desc    Get product by ID
// @route   GET /api/products/:id
// @access  Public
const getProductById = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id).populate("category", "name displayName");

  if (product) {
    res.json(product);
  } else {
    res.status(404);
    throw new Error("Product not found");
  }
});

// @desc    Create a new product
// @route   POST /api/products
// @access  Private/Admin
const createProduct = async (req, res) => {
  try {
    const product = new Product(req.body);
    const createdProduct = await product.save();
    res.status(201).json(createdProduct);
  } catch (error) {
    console.error("❌ Failed to create product:", error);
    res.status(400).json({ message: "Product creation failed.", error: error.message });
  }
};

// @desc    Update product
// @route   PUT /api/products/:id
// @access  Admin
const updateProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);

  if (!product) {
    res.status(404);
    throw new Error("Product not found");
  }

  Object.keys(req.body).forEach((key) => {
    product[key] = req.body[key] ?? product[key];
  });

  const updated = await product.save();
  res.json(updated);
});

// @desc    Delete product
// @route   DELETE /api/products/:id
// @access  Admin
const deleteProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);

  if (!product) {
    res.status(404);
    throw new Error("Product not found");
  }

  await product.deleteOne();
  res.json({ message: "Product removed" });
});

export {
  getProductsAdmin,
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
};
