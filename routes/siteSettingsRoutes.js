import express from "express";
import { protect, admin } from "../middleware/authMiddleware.js";
import { getMaintenanceNotice, getAdminMaintenanceNotice, updateMaintenanceNotice } from "../controllers/siteSettingsController.js";

const router = express.Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.get("/maintenance-notice", getMaintenanceNotice);
router.get("/maintenance-notice/admin", protect, admin, getAdminMaintenanceNotice);
router.put("/maintenance-notice", protect, admin, updateMaintenanceNotice);
export default router;
