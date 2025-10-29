// routes/slotItemRoutes.js
import express from "express";
import {
  getSlotItems,
  getByProduct,
  getBySlot,
  receiveToSlot,
  deleteSlotItem,
} from "../controllers/slotItemController.js";

const router = express.Router();

// /api/slot-items
router.get("/", getSlotItems);
router.get("/by-product/:productId", getByProduct);
router.get("/by-slot/:slotId", getBySlot);
router.post("/receive", receiveToSlot);
router.delete("/:id", deleteSlotItem);

export default router;
