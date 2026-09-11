import express from "express";
import {
  getAnalyticsCustomers,
  getAnalyticsOverview,
} from "../controllers/analyticsController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

router.get("/overview", protect, admin, getAnalyticsOverview);
router.get("/customers", protect, admin, getAnalyticsCustomers);

export default router;
