import express from "express";
import {
  getAllPayments,
  getPaymentById,
  deletePayment,
  addPaymentToInvoice,
  getMyPayments,
} from "../controllers/paymentController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

// ✅ THIS MUST COME FIRST
router.route("/my").get(protect, getMyPayments);

// THEN admin-only routes
router.route("/").get(protect, admin, getAllPayments);
router.route("/from-invoice/:invoiceId").post(protect, admin, addPaymentToInvoice);
router.route("/:id").get(protect, admin, getPaymentById);
router.route("/:id").delete(protect, admin, deletePayment);


export default router;
