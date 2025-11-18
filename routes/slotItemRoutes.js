// routes/slotItemRoutes.js
import express from "express";
import {
  getSlotItems,
  getByProduct,
  getBySlot,
  receiveToSlot,
  updateSlotItemQty,
  deleteSlotItem,
} from "../controllers/slotItemController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

// Base: /api/slot-items
router.get("/", protect, admin, getSlotItems);                // ?slotId=&productId=
router.get("/by-product/:productId", protect, admin, getByProduct);
router.get("/by-slot/:slotId", protect, admin, getBySlot);
router.post("/receive", protect, admin, receiveToSlot);       // Add / insert or receive qty
router.put("/:id", protect, admin, updateSlotItemQty);        // Directly set new qty
router.delete("/:id", protect, admin, deleteSlotItem);        // Delete slot-item record

export default router;
