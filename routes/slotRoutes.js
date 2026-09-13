// routes/slotRoutes.js
import express from "express";
import {
  getSlots,
  getSlotSummary,
  getSlotById,
  createSlot,
  updateSlot,
  deleteSlot,
  rebuildSlotOccupancy,
} from "../controllers/slotController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

// /api/slots
router.get("/", protect, admin, getSlots);
router.get("/summary", protect, admin, getSlotSummary);
router.post("/occupancy/rebuild", protect, admin, rebuildSlotOccupancy);
router.get("/:id", protect, admin, getSlotById);
router.post("/", protect, admin, createSlot);
router.put("/:id", protect, admin, updateSlot);
router.delete("/:id", protect, admin, deleteSlot);

export default router;
