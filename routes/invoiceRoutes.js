import express from "express";
import {
  getInvoices,            // admin list (filters + pagination + computed totals)
  getInvoiceById,         // admin or owner
  updateInvoice,          // admin
  deleteInvoice,          // admin
  getMyInvoices,          // owner (list, computed totals/status)
  getInvoicePDF,          // owner or admin (PDF)
  createInvoiceForOrder,  // admin: create from order
} from "../controllers/invoiceController.js";
import { protect, admin } from "../middleware/authMiddleware.js";

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
