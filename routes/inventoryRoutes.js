import express from "express";
import {
  getInventoryProducts,
  getInventoryAllocations,
  getInventoryMovements,
} from "../controllers/inventoryController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

// /api/inventory/products
router.get("/products", protect, admin, getInventoryProducts);
router.get("/allocations", protect, admin, getInventoryAllocations);
router.get("/movements", protect, admin, getInventoryMovements);

export default router;
