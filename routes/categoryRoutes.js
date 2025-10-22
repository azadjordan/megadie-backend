import express from "express";
const router = express.Router();

import {
  getCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
  deleteAllCategories, // 👈 import it
} from "../controllers/categoryController.js";

import { protect, admin } from "../middleware/authMiddleware.js";

// ✅ Public routes
router.route("/").get(getCategories);
router.route("/:id").get(getCategoryById);

// ✅ Admin-protected routes
router.route("/").post(protect, admin, createCategory);
router
  .route("/:id")
  .put(protect, admin, updateCategory)
  .delete(protect, admin, deleteCategory);

// ✅ Delete all categories
router.delete("/", protect, admin, deleteAllCategories);

export default router;
