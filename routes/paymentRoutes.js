import express from "express";
import {
  addPaymentToInvoice,
  updatePaymentMeta,
  deletePayment,
  getPaymentById,
  getAllPayments,
  getPaymentsByInvoice,
  getMyPayments,
} from "../controllers/paymentController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

/* ---------- Self-service (auth user) ---------- */
router.get("/my", protect, getMyPayments);

/* ---------- Admin filters & creation ---------- */
router.get("/by-invoice", protect, admin, getPaymentsByInvoice); // ?invoice=<invoiceId>
router.get("/", protect, admin, getAllPayments);                  // filters via query
router.post("/from-invoice/:invoiceId", protect, admin, addPaymentToInvoice);

/* ---------- Single payment ops ---------- */
router.get("/:id", protect, admin, getPaymentById);
router.patch("/:id", protect, admin, updatePaymentMeta);          // non-financial fields only
router.delete("/:id", protect, admin, deletePayment);             // hard delete (startup policy)

export default router;
