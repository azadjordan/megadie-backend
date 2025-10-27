// routes/orderRoutes.js
import express from "express";
import {
  getOrders,
  createOrderFromQuote,
  getMyOrders,
  getOrderById,
  deleteOrder,
  updateOrder,
} from "../controllers/orderController.js";
import { createInvoice } from "../controllers/invoiceController.js"; // ✅ add invoice creation here
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

// ✅ Create an invoice for a specific order (admin)
// POST /api/orders/:orderId/invoice
router.post("/:orderId/invoice", protect, admin, createInvoice);

// ✅ Get all orders (admin)
router.get("/", protect, admin, getOrders);

// ✅ Get my orders (user)
router.get("/my", protect, getMyOrders);

// ✅ Create order from quote (admin)
router.post("/from-quote/:quoteId", protect, admin, createOrderFromQuote);

// ✅ Get / Update / Delete order by ID
router
  .route("/:id")
  .get(protect, getOrderById)
  .put(protect, admin, updateOrder)
  .delete(protect, admin, deleteOrder);

export default router;
