// routes/filterConfigRoutes.js
import express from "express";
const router = express.Router();

import {
  getFilterConfigs,        // GET /api/filter-configs
  getFilterConfig,         // GET /api/filter-configs/:productType
  createFilterConfig,      // POST /api/filter-configs/:productType
  updateFilterConfig,      // PUT /api/filter-configs/:productType
  deleteFilterConfig,      // DELETE /api/filter-configs/:productType
} from "../controllers/filterConfigController.js";

import { protect, admin, requireApproved } from "../middleware/authMiddleware.js";

// Public
router.get("/", protect, requireApproved, getFilterConfigs);
router.get("/:productType", protect, requireApproved, getFilterConfig);

// Admin
router.post("/:productType", protect, admin, createFilterConfig);   // create only (409 if exists)
router.put("/:productType", protect, admin, updateFilterConfig);    // update only (404 if missing)
router.delete("/:productType", protect, admin, deleteFilterConfig);

export default router;
