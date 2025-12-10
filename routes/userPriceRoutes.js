// routes/userPriceRoutes.js
import express from "express";
import {
  upsertUserPrice,
  getUserPricesForUser,
  deleteUserPrice,
  getAllPriceRules,
  resolveUserPrices,
} from "../controllers/userPriceController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

/**
 * Admin-only: pricing management (Pricing tab)
 */

// List all possible price rules (for dropdown on Pricing page)
// GET /api/user-prices/rules
router.get("/rules", protect, admin, getAllPriceRules);

// Get all user prices for a specific user
// GET /api/user-prices/:userId
router.get("/:userId", protect, admin, getUserPricesForUser);

// Create or update a user-specific price (upsert)
// POST /api/user-prices
router.post("/", protect, admin, upsertUserPrice);

// Delete a specific user price record
// DELETE /api/user-prices/:id
router.delete("/:id", protect, admin, deleteUserPrice);

/**
 * Quote page: resolve prices (read-only)
 * NOTE: put this AFTER the above to avoid path confusion with /:userId
 */

// Resolve user prices for given priceRules
// POST /api/user-prices/resolve
router.post("/resolve", protect, resolveUserPrices);

export default router;
