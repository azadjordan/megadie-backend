// routes/slotItemRoutes.js
import express from "express";
import { getSlotItemsByProduct } from "../controllers/slotItemController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

// List slot items for a product (used by picking UI)
router.get("/by-product/:productId", protect, admin, getSlotItemsByProduct);

export default router;
