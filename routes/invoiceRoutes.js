// ✅ invoiceRoutes.js
import express from "express";
import {
  createInvoice,
  getInvoices,
  getInvoiceById,
  updateInvoice,
  deleteInvoice,
  getMyInvoices,
  getInvoicePDF,
} from "../controllers/invoiceController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

// ✅ Generate a PDF version of an invoice
router.get("/:id/pdf", protect, admin, getInvoicePDF);

// ✅ Create a new invoice (admin only)
router.route("/").post(protect, admin, createInvoice);

// ✅ Get current user's own invoices
router.get("/my", protect, getMyInvoices); // 👈 this MUST come before "/:id"

// ✅ Get all invoices (admin only)
router.route("/").get(protect, admin, getInvoices);

// ✅ Get / update / delete a specific invoice
router
  .route("/:id")
  .get(protect, getInvoiceById)
  .put(protect, admin, updateInvoice)
  .delete(protect, admin, deleteInvoice);

export default router;
