// controllers/invoiceController.js
import asyncHandler from "../middleware/asyncHandler.js";
import Invoice from "../models/invoiceModel.js";
import Payment from "../models/paymentModel.js";
import Order from "../models/orderModel.js";
import InvoicePDF from "../utils/InvoicePDF.js";
import { renderToStream } from "@react-pdf/renderer";
import { createElement } from "react";
import { roundToTwo } from "../utils/rounding.js";

/* =========================
   GET /api/invoices/:id/pdf
   Private/Admin (guarded in routes)
   ========================= */
export const getInvoicePDF = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id)
    .populate("user", "name email")
    .populate({
      path: "order",
      select: "orderNumber totalPrice status orderItems deliveredAt",
      populate: { path: "orderItems.product", select: "name" },
    })
    .populate("payments");

  if (!invoice) {
    res.status(404);
    throw new Error("Invoice not found.");
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename=invoice-${invoice.invoiceNumber || invoice._id}.pdf`
  );

  const pdfStream = await renderToStream(
    createElement(InvoicePDF, { invoice, order: invoice.order })
  );
  pdfStream.pipe(res);
});

/* =========================
   GET /api/invoices
   Private/Admin (guarded in routes)
   ========================= */
export const getInvoices = asyncHandler(async (_req, res) => {
  const invoices = await Invoice.find({})
    .populate("user", "name email")
    .populate("order", "orderNumber totalPrice status")
    .populate("payments")
    .sort({ createdAt: -1 });

  res.json(invoices);
});

/* =========================
   GET /api/invoices/:id
   Private/Admin or Owner (route uses protect; owner check here)
   ========================= */
export const getInvoiceById = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id)
    .populate("user", "name email")
    .populate("order", "orderNumber totalPrice status")
    .populate("payments");

  if (!invoice) {
    res.status(404);
    throw new Error("Invoice not found.");
  }

  const isOwner = req.user && invoice.user && req.user._id.equals(invoice.user._id);
  if (!(req.user?.isAdmin || isOwner)) {
    res.status(403);
    throw new Error("Not authorized to view this invoice.");
  }

  res.json(invoice);
});

/* =========================
   POST /api/orders/:orderId/invoice
   Private/Admin (guarded in routes)
   Body: { dueDate?, adminNote? }
   amount is ALWAYS derived from order.totalPrice
   ========================= */
export const createInvoice = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const { dueDate, adminNote } = req.body || {};

  // Load only what's needed
  const orderDoc = await Order.findById(orderId).select(
    "status totalPrice user invoice"
  );

  if (!orderDoc) {
    res.status(404);
    throw new Error("Order not found.");
  }
  if (orderDoc.invoice) {
    res.status(400);
    throw new Error("Invoice already exists for this order.");
  }
  if (orderDoc.status !== "Delivered") {
    res.status(400);
    throw new Error("Invoice can only be created for a Delivered order.");
  }

  // Single source of truth: amount from order.totalPrice
  const derivedAmount = roundToTwo(Math.max(0, orderDoc.totalPrice || 0));

  const invoice = await Invoice.create({
    order: orderDoc._id,
    user: orderDoc.user,     // derive from order
    amount: derivedAmount,   // <- always from order
    dueDate: dueDate || undefined,
    adminNote,
  });

  // Atomic link-back; skip validators on unrelated fields
  await Order.findByIdAndUpdate(
    orderDoc._id,
    { $set: { invoice: invoice._id } },
    { runValidators: false }
  );

  await invoice.populate([
    "payments",
    { path: "order", select: "orderNumber totalPrice status" },
  ]);

  res.status(201).json(invoice);
});

/* =========================
   PUT /api/invoices/:id
   Private/Admin (guarded in routes)
   Allowed fields: dueDate, adminNote
   (user/order/amount immutable after creation)
   ========================= */
export const updateInvoice = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) {
    res.status(404);
    throw new Error("Invoice not found.");
  }

  const { dueDate, adminNote, user, order, amount, ...rest } = req.body || {};

  // Prevent relational key mutation
  if (typeof user !== "undefined" || typeof order !== "undefined") {
    res.status(400);
    throw new Error("Cannot change 'user' or 'order' of an invoice.");
  }

  // Prevent amount changes explicitly (even though schema is immutable)
  if (typeof amount !== "undefined") {
    res.status(400);
    throw new Error("Cannot change 'amount' of an invoice. Delete & recreate via the Order if needed.");
  }

  // Whitelisted fields
  if (typeof dueDate !== "undefined") {
    invoice.dueDate = dueDate ? new Date(dueDate) : undefined;
  }
  if (typeof adminNote !== "undefined") {
    invoice.adminNote = adminNote;
  }

  const updated = await invoice.save();
  await updated.populate([
    "payments",
    { path: "order", select: "orderNumber totalPrice status" },
  ]);

  res.json(updated);
});

/* =========================
   DELETE /api/invoices/:id
   Private/Admin (guarded in routes)
   Cascade: delete payments, unlink order.invoice
   ========================= */
export const deleteInvoice = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) {
    res.status(404);
    throw new Error("Invoice not found.");
  }

  // Unlink from order
  if (invoice.order) {
    await Order.findByIdAndUpdate(invoice.order, { $set: { invoice: null } });
  }

  // Delete child payments
  await Payment.deleteMany({ invoice: invoice._id });

  // Delete invoice
  await invoice.deleteOne();

  res.status(204).end();
});

/* =========================
   GET /api/invoices/my
   Private (owner)
   ========================= */
export const getMyInvoices = asyncHandler(async (req, res) => {
  const invoices = await Invoice.find({ user: req.user._id })
    .populate("order", "orderNumber totalPrice status")
    .populate("payments")
    .sort({ createdAt: -1 });

  res.json(invoices);
});
