import express from "express";
import { getProducts, getProductById } from "../controllers/productController.js";
import {
  getProductsAdmin,     // ✅ Admin: list all with filters/pagination
  createProduct,
  updateProduct,
  deleteProduct,
} from "../controllers/productAdminController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

// ✅ Public route for shop (filtered by users)
router.route("/").get(getProducts);

// ✅ Admin route for backend product management
router.route("/admin").get(protect, admin, getProductsAdmin);

// ✅ Admin can create product
router.route("/").post(protect, admin, createProduct);

// ✅ Individual product routes
router
  .route("/:id")
  .get(getProductById)
  .put(protect, admin, updateProduct)
  .delete(protect, admin, deleteProduct);

export default router;
