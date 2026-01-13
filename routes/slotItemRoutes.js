// routes/slotItemRoutes.js
import express from "express";
import {
  getSlotItemsByProduct,
  getSlotItemsBySlot,
  adjustSlotItem,
  moveSlotItems,
  clearSlotItems,
} from "../controllers/slotItemController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

// List slot items for a product (used by picking UI)
router.get("/by-product/:productId", protect, admin, getSlotItemsByProduct);
router.get("/by-slot/:slotId", protect, admin, getSlotItemsBySlot);
router.post("/adjust", protect, admin, adjustSlotItem);
router.post("/move", protect, admin, moveSlotItems);
router.post("/clear", protect, admin, clearSlotItems);

export default router;
