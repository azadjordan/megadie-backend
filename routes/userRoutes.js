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
  updateUserPasswordByAdmin,
  updateUserApprovalStatus,

  forgotPassword,
  resetPassword,
} from "../controllers/userController.js";

import { protect, admin } from "../middleware/authMiddleware.js";
import {
  blockHoneypotSubmission,
  rateLimit,
} from "../middleware/abuseProtectionMiddleware.js";

// Public
router.route("/").post(
  rateLimit({ windowMs: 60 * 60 * 1000, max: 5, keyPrefix: "register" }),
  blockHoneypotSubmission(["companyWebsite", "website"]),
  registerUser
);
router.post("/logout", logoutUser);
router.post(
  "/auth",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 20, keyPrefix: "login" }),
  authUser
);

// ✅ Public: forgot/reset password
router.post(
  "/forgot-password",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 5, keyPrefix: "forgot-password" }),
  forgotPassword
);
router.post(
  "/reset-password/:token",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 5, keyPrefix: "reset-password" }),
  resetPassword
);

// Self profile (protected)
router
  .route("/account/profile")
  .get(protect, getUserProfile)
  .put(protect, updateUserProfile);

// Admin (protected)
router.route("/").get(protect, admin, getUsers);

router.put("/:id/password", protect, admin, updateUserPasswordByAdmin);
router.put("/:id/approval", protect, admin, updateUserApprovalStatus);

router
  .route("/:id")
  .get(protect, admin, getUserById)
  .put(protect, admin, updateUser)
  .delete(protect, admin, deleteUser);

export default router;
