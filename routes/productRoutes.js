import express from "express";
import { getProducts, getProductById } from "../controllers/productController.js";
import {
  getProductsAdmin,     // ✅ Admin: list all with filters/pagination
  getProductMeta,
  createProduct,
  updateProduct,
  deleteProduct,
} from "../controllers/productAdminController.js";
import { protect, admin, requireApproved } from "../middleware/authMiddleware.js";

const router = express.Router();

// ✅ Public route for shop (filtered by users)
router.route("/").get(protect, requireApproved, getProducts);

// ✅ Admin route for backend product management
router.route("/admin").get(protect, admin, getProductsAdmin);

// バ. Admin product meta (enums for create/edit UI)
router.route("/meta").get(protect, admin, getProductMeta);

// ✅ Admin can create product
router.route("/").post(protect, admin, createProduct);

// ✅ Individual product routes
router
  .route("/:id")
  .get(protect, requireApproved, getProductById)
  .put(protect, admin, updateProduct)
  .delete(protect, admin, deleteProduct);

export default router;
