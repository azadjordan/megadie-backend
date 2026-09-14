import express from "express";
import {
  addPaymentToInvoice,
  allocateCustomerPayment,
  deletePayment,
  getPaymentsAdmin,
  previewCustomerPaymentAllocation,
} from "../controllers/paymentController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

/* ---------- Admin: payments list ---------- */
router.get("/", protect, admin, getPaymentsAdmin);
router.post(
  "/customer/:userId/preview",
  protect,
  admin,
  previewCustomerPaymentAllocation
);
router.post("/customer/:userId/allocate", protect, admin, allocateCustomerPayment);
router.post("/from-invoice/:invoiceId", protect, admin, addPaymentToInvoice);
router.delete("/:id", protect, admin, deletePayment);

export default router;
