import express from "express";
import { getInventoryProducts } from "../controllers/inventoryController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

// /api/inventory/products
router.get("/products", protect, admin, getInventoryProducts);

export default router;
