import express from "express";
import {
  getAnalyticsCharity,
  getAnalyticsCustomers,
  getAnalyticsOverview,
  getAnalyticsSkus,
} from "../controllers/analyticsController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

router.get("/overview", protect, admin, getAnalyticsOverview);
router.get("/customers", protect, admin, getAnalyticsCustomers);
router.get("/skus", protect, admin, getAnalyticsSkus);
router.get("/charity", protect, admin, getAnalyticsCharity);

export default router;
