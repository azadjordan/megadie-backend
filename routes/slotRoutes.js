// routes/slotRoutes.js
import express from "express";
import {
  getSlots,
  getSlotById,
  createSlot,
  updateSlot,
  deleteSlot,
} from "../controllers/slotController.js";

const router = express.Router();

// /api/slots
router.get("/", getSlots);
router.get("/:id", getSlotById);
router.post("/", createSlot);
router.put("/:id", updateSlot);
router.delete("/:id", deleteSlot);

export default router;
