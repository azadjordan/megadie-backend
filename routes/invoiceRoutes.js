// routes/invoiceRoutes.js
import express from "express";
import {
  // createInvoice,  // ❌ moved to orderRoutes (nested under /orders/:orderId/invoice)
  getInvoices,
  getInvoiceById,
  updateInvoice,
  deleteInvoice,
  getMyInvoices,
  getInvoicePDF,
} from "../controllers/invoiceController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

// PDF (admin only)
router.get("/:id/pdf", protect, admin, getInvoicePDF);

// My invoices (owner) — keep before "/:id"
router.get("/my", protect, getMyInvoices);

// All invoices (admin)
router.get("/", protect, admin, getInvoices);

// Single invoice: get / update / delete
router
  .route("/:id")
  .get(protect, getInvoiceById)     // admin or owner (checked in controller)
  .put(protect, admin, updateInvoice)
  .delete(protect, admin, deleteInvoice);

export default router;
