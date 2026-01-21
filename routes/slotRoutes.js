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
router.get("/", getSlots);
router.get("/summary", getSlotSummary);
router.post("/occupancy/rebuild", protect, admin, rebuildSlotOccupancy);
router.get("/:id", getSlotById);
router.post("/", createSlot);
router.put("/:id", updateSlot);
router.delete("/:id", deleteSlot);

export default router;
