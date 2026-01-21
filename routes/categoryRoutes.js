import express from "express";
const router = express.Router();

import {
  getCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
} from "../controllers/categoryController.js";

import { protect, admin, requireApproved } from "../middleware/authMiddleware.js";

// ✅ Public routes
router.route("/").get(protect, requireApproved, getCategories);
router.route("/:id").get(protect, requireApproved, getCategoryById);

// ✅ Admin-protected routes
router.route("/").post(protect, admin, createCategory);
router
  .route("/:id")
  .put(protect, admin, updateCategory)
  .delete(protect, admin, deleteCategory);



export default router;
