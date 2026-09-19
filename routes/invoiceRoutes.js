// routes/invoiceRoutes.js
import express from "express";
import { protect, admin, requireApproved } from "../middleware/authMiddleware.js";

// Owner + shared (admin OR owner) endpoints
import {
  getMyInvoices,
  getMyInvoiceSummary,
  getInvoiceById,
  getInvoicePDF,
  getOutstandingBalancePDF,
  getStatementOfAccountPDF,
} from "../controllers/invoiceController.js";

// Admin-only endpoints
import {
  getInvoices,
  getInvoicesSummary,
  updateInvoice,
  deleteInvoice,
  createInvoiceFromOrder,
  createManualInvoice,
} from "../controllers/invoiceAdminController.js";

const router = express.Router();

/* ----- Owner endpoints ----- */
router.get("/my", protect, requireApproved, getMyInvoices);
router.get("/my/summary", protect, requireApproved, getMyInvoiceSummary);

/* ----- Admin summary ----- */
router.get("/summary", protect, admin, getInvoicesSummary);
router.get("/soa/:userId", protect, admin, getStatementOfAccountPDF);
router.get(
  "/outstanding-balance/:userId",
  protect,
  admin,
  getOutstandingBalancePDF
);

/* ----- Admin or Owner ----- */
router.get("/:id/pdf", protect, requireApproved, getInvoicePDF);
router.get("/:id", protect, requireApproved, getInvoiceById);

/* ----- Admin mutate ----- */
router.post("/from-order/:orderId", protect, admin, createInvoiceFromOrder);
router.post("/manual", protect, admin, createManualInvoice);
router.put("/:id", protect, admin, updateInvoice);
router.delete("/:id", protect, admin, deleteInvoice);

/* ----- Admin list (filters + pagination) ----- */
router.get("/", protect, admin, getInvoices);


export default router;
