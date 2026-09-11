import express from "express";
import { getAnalyticsOverview } from "../controllers/analyticsController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

router.get("/overview", protect, admin, getAnalyticsOverview);

export default router;
