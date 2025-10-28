// routes/invoiceRoutes.js
import express from "express";
import {
  getInvoices,        // admin list (filters + pagination + computed totals)
  getInvoiceById,     // admin or owner
  updateInvoice,      // admin
  deleteInvoice,      // admin
  getMyInvoices,      // owner
  getInvoicePDF,      // admin
  createInvoiceForOrder, // admin: create from order
} from "../controllers/invoiceController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

const router = express.Router();

/* ----- Owner endpoints ----- */
router.get("/my", protect, getMyInvoices);

/* ----- Admin-only extras ----- */
router.get("/:id/pdf", protect, admin, getInvoicePDF);

/* ----- Admin or Owner ----- */
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
