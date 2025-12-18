// routes/invoiceRoutes.js
import express from "express";
import { protect, admin } from "../middleware/authMiddleware.js";

// Owner + shared (admin OR owner) endpoints
import {
  getMyInvoices,
  getInvoiceById,
  getInvoicePDF,
} from "../controllers/invoiceUserController.js";

// Admin-only endpoints
import {
  getInvoices,
  updateInvoice,
  deleteInvoice,
  createInvoiceForOrder,
} from "../controllers/invoiceAdminController.js";

const router = express.Router();

/* ----- Owner endpoints ----- */
router.get("/my", protect, getMyInvoices);

/* ----- Admin or Owner ----- */
router.get("/:id/pdf", protect, getInvoicePDF);
router.get("/:id", protect, getInvoiceById);

/* ----- Admin mutate ----- */
router.put("/:id", protect, admin, updateInvoice);
router.delete("/:id", protect, admin, deleteInvoice);

/* ----- Admin list (filters + pagination) ----- */
router.get("/", protect, admin, getInvoices);

/* ----- Admin create-from-order (canonical) ----- */
// POST /api/invoices/from-order/:orderId
router.post("/from-order/:orderId", protect, admin, createInvoiceForOrder);

export default router;
