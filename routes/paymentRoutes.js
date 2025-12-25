import express from "express";
import {
  addPaymentToInvoice,
  deletePayment,
  getPaymentsAdmin,
} from "../controllers/paymentController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

/* ---------- Admin: payments list ---------- */
router.get("/", protect, admin, getPaymentsAdmin);
router.post("/from-invoice/:invoiceId", protect, admin, addPaymentToInvoice);
router.delete("/:id", protect, admin, deletePayment);

export default router;
