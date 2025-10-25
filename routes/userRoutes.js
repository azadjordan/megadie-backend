import express from "express";
const router = express.Router();

import {
  authUser,          // POST /auth  (or POST /login if you prefer)
  registerUser,      // POST /
  logoutUser,        // POST /logout
  getUserProfile,    // GET  /account/profile
  updateUserProfile, // PUT  /account/profile
  getUsers,          // GET  /
  deleteUser,        // DELETE /:id
  getUserById,       // GET  /:id
  updateUser,        // PUT  /:id
} from "../controllers/userController.js";

import { protect, admin } from "../middleware/authMiddleware.js";

// Public
router.route("/").post(registerUser);
router.post("/logout", logoutUser);
// keep your original path name:
router.post("/auth", authUser); // (optional rename: "/login")

// Self profile
router
  .route("/account/profile")
  .get(protect, getUserProfile)
  .put(protect, updateUserProfile);

// Admin
router
  .route("/")
  .get(protect, admin, getUsers);

router
  .route("/:id")
  .get(protect, admin, getUserById)
  .put(protect, admin, updateUser)
  .delete(protect, admin, deleteUser);

export default router;
