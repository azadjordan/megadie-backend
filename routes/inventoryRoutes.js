// routes/inventoryRoutes.js
import express from "express";
import { rebuildStoreSnapshot, getStoreSnapshot } from "../controllers/storeSnapshotController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

// Rebuild on demand
router.post("/stores/:store/snapshot/rebuild", protect, admin, rebuildStoreSnapshot);

// Read-only, super fast
router.get("/stores/:store/snapshot", protect, admin, getStoreSnapshot);

export default router;
