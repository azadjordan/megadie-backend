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

  // User actions
  cancelQuoteByUser,
  confirmQuoteByUser,
  updateQuoteQuantitiesByUser,

  // Admin step endpoints
  updateQuoteOwnerByAdmin,
  updateQuoteQuantitiesByAdmin,
  updateQuotePricingByAdmin,
  updateQuoteNotesByAdmin,
  updateQuoteStatusByAdmin,
  recheckQuoteAvailabilityByAdmin,
} from "../controllers/quoteController.js";

import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

// Create a new quote (client)
router.route("/").post(protect, createQuote);

// Get current user's own quotes (client)
router.get("/my", protect, getMyQuotes);

// User actions (owner only)
router.put("/:id/cancel", protect, cancelQuoteByUser);
router.put("/:id/confirm", protect, confirmQuoteByUser);
router.put("/:id/update-quantities", protect, updateQuoteQuantitiesByUser);

// Generate PDF version of a quote (admin only)
router.get("/:id/pdf", protect, admin, getQuotePDF);
router.get("/:id/share", protect, admin, getQuoteShare);

// Get all quotes (admin only)
router.route("/admin").get(protect, admin, getQuotes);

// Admin-only step endpoints
// NOTE: Put these BEFORE "/:id" routes to avoid path conflicts.
router.put("/admin/:id/owner", protect, admin, updateQuoteOwnerByAdmin);
router.put(
  "/admin/:id/quantities",
  protect,
  admin,
  updateQuoteQuantitiesByAdmin
);
router.put("/admin/:id/pricing", protect, admin, updateQuotePricingByAdmin);
router.put("/admin/:id/notes", protect, admin, updateQuoteNotesByAdmin);
router.put("/admin/:id/status", protect, admin, updateQuoteStatusByAdmin);
router.put(
  "/admin/:id/recheck-availability",
  protect,
  admin,
  recheckQuoteAvailabilityByAdmin
);

// Get / delete a specific quote
router
  .route("/:id")
  .get(protect, getQuoteById)
  .delete(protect, admin, deleteQuote);

export default router;
