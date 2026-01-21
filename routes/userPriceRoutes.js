// routes/userPriceRoutes.js
import express from "express";
import {
  getUserPricesForUser,
  upsertUserPrice,
  deleteUserPrice,
} from "../controllers/userPriceController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

// Get all user prices for a specific user
// GET /api/user-prices/:userId
router.get("/:userId", protect, admin, getUserPricesForUser);

// Create or update a user-specific price (upsert)
// POST /api/user-prices
router.post("/", protect, admin, upsertUserPrice);

// Delete a specific user price record
// DELETE /api/user-prices/:id
router.delete("/:id", protect, admin, deleteUserPrice);

export default router;
