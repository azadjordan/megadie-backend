import express from "express";
const router = express.Router();

import {
  authUser,
  registerUser,
  logoutUser,
  getUserProfile,
  updateUserProfile,
  getUsers,
  deleteUser,
  getUserById,
  updateUser,

  forgotPassword,
  resetPassword,
} from "../controllers/userController.js";

import { protect, admin } from "../middleware/authMiddleware.js";

// Public
router.route("/").post(registerUser);
router.post("/logout", logoutUser);
router.post("/auth", authUser);

// ✅ Public: forgot/reset password
router.post("/forgot-password", forgotPassword);
router.post("/reset-password/:token", resetPassword);

// Self profile (protected)
router
  .route("/account/profile")
  .get(protect, getUserProfile)
  .put(protect, updateUserProfile);

// Admin (protected)
router.route("/").get(protect, admin, getUsers);

router
  .route("/:id")
  .get(protect, admin, getUserById)
  .put(protect, admin, updateUser)
  .delete(protect, admin, deleteUser);

export default router;
