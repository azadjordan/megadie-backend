// routes/quoteRoutes.js
import express from "express";
import {
  createQuote,
  getQuotes,
  getQuoteById,
  updateQuote,
  deleteQuote,
  getMyQuotes,
  getQuotePDF,

  // ✅ NEW (user actions)
  cancelQuoteByUser,
  confirmQuoteByUser,
} from "../controllers/quoteController.js";

import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

// ✅ Create a new quote (client)
router.route("/").post(protect, createQuote);

// ✅ Get current user's own quotes (client)
router.get("/my", protect, getMyQuotes);

// ✅ User actions (owner only)
router.put("/:id/cancel", protect, cancelQuoteByUser);
router.put("/:id/confirm", protect, confirmQuoteByUser);

// ✅ Generate PDF version of a quote (admin only)
router.get("/:id/pdf", protect, admin, getQuotePDF);

// ✅ Get all quotes (admin only)
router.route("/admin").get(protect, admin, getQuotes);

// ✅ Get / update / delete a specific quote
router
  .route("/:id")
  .get(protect, getQuoteById)
  .put(protect, admin, updateQuote)
  .delete(protect, admin, deleteQuote);

export default router;
