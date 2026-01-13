// routes/orderRoutes.js
import express from "express";
import {
  getOrders,
  createOrderFromQuote,
  getMyOrders,
  getOrderById,
  deleteOrder,
  updateOrder,
  markOrderDelivered,
} from "../controllers/orderController.js";
import {
  getOrderAllocations,
  upsertOrderAllocation,
  deleteOrderAllocation,
  finalizeOrderAllocations,
} from "../controllers/orderAllocationController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

// ✅ Get all orders (admin)
router.get("/", protect, admin, getOrders);

// ✅ Get my orders (user)
router.get("/my", protect, getMyOrders);

// ✅ Create order from quote (admin)
router.post("/from-quote/:quoteId", protect, admin, createOrderFromQuote);

// Mark order as delivered (admin)
router.put("/:id/deliver", protect, admin, markOrderDelivered);

// Order allocations (admin)
router.get("/:id/allocations", protect, admin, getOrderAllocations);
router.post("/:id/allocations", protect, admin, upsertOrderAllocation);
router.post("/:id/allocations/finalize", protect, admin, finalizeOrderAllocations);
router.delete("/:id/allocations/:allocationId", protect, admin, deleteOrderAllocation);

// ✅ Get / Update / Delete order by ID
router
  .route("/:id")
  .get(protect, getOrderById)
  .put(protect, admin, updateOrder)
  .delete(protect, admin, deleteOrder);

export default router;
