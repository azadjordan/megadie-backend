// routes/quoteRoutes.js
import express from "express";
import {
  createQuote,
  getQuotes,
  getQuoteById,
  deleteQuote,
  getMyQuotes,
  getQuotePDF,
  getQuoteShare,
  mergeQuotesByAdmin,

  // User actions
  cancelQuoteByUser,
  confirmQuoteByUser,
  updateQuoteQuantitiesByUser,

  // Admin step endpoints
  updateQuoteOwnerByAdmin,
  updateQuoteItemsByAdmin,
  updateQuoteQuantitiesByAdmin,
  updateQuotePricingByAdmin,
  assignUserPricesByAdmin,
  updateQuoteNotesByAdmin,
  updateQuoteStatusByAdmin,
  recheckQuoteAvailabilityByAdmin,
  getQuoteStockCheckByAdmin,
} from "../controllers/quoteController.js";

import { protect, admin, requireApproved } from "../middleware/authMiddleware.js";

const router = express.Router();

// Create a new quote (client)
router.route("/").post(protect, requireApproved, createQuote);

// Get current user's own quotes (client)
router.get("/my", protect, requireApproved, getMyQuotes);

// User actions (owner only)
router.put("/:id/cancel", protect, requireApproved, cancelQuoteByUser);
router.put("/:id/confirm", protect, requireApproved, confirmQuoteByUser);
router.put(
  "/:id/update-quantities",
  protect,
  requireApproved,
  updateQuoteQuantitiesByUser
);

// Generate PDF version of a quote (admin only)
router.get("/:id/pdf", protect, admin, getQuotePDF);
router.get("/:id/share", protect, admin, getQuoteShare);

// Get all quotes (admin only)
router.route("/admin").get(protect, admin, getQuotes);
router.post("/admin/merge", protect, admin, mergeQuotesByAdmin);

// Admin-only step endpoints
// NOTE: Put these BEFORE "/:id" routes to avoid path conflicts.
router.put("/admin/:id/owner", protect, admin, updateQuoteOwnerByAdmin);
router.put("/admin/:id/items", protect, admin, updateQuoteItemsByAdmin);
router.put(
  "/admin/:id/quantities",
  protect,
  admin,
  updateQuoteQuantitiesByAdmin
);
router.put("/admin/:id/pricing", protect, admin, updateQuotePricingByAdmin);
router.post(
  "/admin/:id/assign-user-prices",
  protect,
  admin,
  assignUserPricesByAdmin
);
router.put("/admin/:id/notes", protect, admin, updateQuoteNotesByAdmin);
router.put("/admin/:id/status", protect, admin, updateQuoteStatusByAdmin);
router.put(
  "/admin/:id/recheck-availability",
  protect,
  admin,
  recheckQuoteAvailabilityByAdmin
);
router.get(
  "/admin/:id/stock-check",
  protect,
  admin,
  getQuoteStockCheckByAdmin
);

// Get / delete a specific quote
router
  .route("/:id")
  .get(protect, requireApproved, getQuoteById)
  .delete(protect, admin, deleteQuote);

export default router;
