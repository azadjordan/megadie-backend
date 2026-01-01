// routes/priceRuleRoutes.js
import express from "express";
import {
  getPriceRules,
  createPriceRule,
  updatePriceRule,
  deletePriceRule,
} from "../controllers/priceRuleController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

// List all price rules
// GET /api/price-rules
router.get("/", protect, admin, getPriceRules);

// Create a price rule
// POST /api/price-rules
router.post("/", protect, admin, createPriceRule);

// Update default price
// PUT /api/price-rules/:id
router.put("/:id", protect, admin, updatePriceRule);

// Delete price rule (blocked if in use)
// DELETE /api/price-rules/:id
router.delete("/:id", protect, admin, deletePriceRule);

export default router;
