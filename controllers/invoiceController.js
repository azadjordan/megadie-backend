import asyncHandler from "../middleware/asyncHandler.js";
import Invoice from "../models/invoiceModel.js";
import Order from "../models/orderModel.js";
import InvoicePDF from "../utils/InvoicePDF.js";
import { renderToStream } from "@react-pdf/renderer";
import { createElement } from "react";
import { roundToTwo } from "../utils/rounding.js";

// @desc    Generate PDF invoice using React PDF
// @route   GET /api/invoices/:id/pdf
// @access  Private/Admin
export const getInvoicePDF = asyncHandler(async (req, res) => {
  // Get invoice by ID and populate user and order reference
  const invoice = await Invoice.findById(req.params.id)
    .populate("user", "name email")
    .populate("order");

  if (!invoice) {
    res.status(404);
    throw new Error("Invoice not found");
  }

  // Get the related order and populate product names
  const order = await Order.findById(invoice.order._id).populate(
    "orderItems.product",
    "name"
  );

  if (!order) {
    res.status(404);
    throw new Error("Order not found");
  }

  // Set headers for streaming PDF
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename=invoice-${invoice.invoiceNumber || invoice._id}.pdf`
  );

  // Render the InvoicePDF component as a stream
  const pdfStream = await renderToStream(createElement(InvoicePDF, { invoice, order }));

  // Pipe the stream to response
  pdfStream.pipe(res);
});

// @desc    Get all invoices (Admin only)
// @route   GET /api/invoices
// @access  Private/Admin
export const getInvoices = asyncHandler(async (req, res) => {
  const invoices = await Invoice.find({})
    .populate("user", "name email")
    .populate("order", "orderNumber totalPrice")
    .populate("payments")
    .sort({ createdAt: -1 });

  res.json(invoices);
});

// @desc    Get invoice by ID (Admin or Owner)
// @route   GET /api/invoices/:id
// @access  Private/Admin or Owner
export const getInvoiceById = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id)
    .populate("user", "name email")
    .populate("order", "orderNumber totalPrice")
    .populate("payments");

  if (invoice) {
    if (req.user.isAdmin || req.user._id.equals(invoice.user._id)) {
      res.json(invoice);
    } else {
      res.status(403);
      throw new Error("Not authorized to view this invoice.");
    }
  } else {
    res.status(404);
    throw new Error("Invoice not found.");
  }
});

// @desc    Create invoice manually (Admin only)
// @route   POST /api/invoices
// @access  Private/Admin
export const createInvoice = asyncHandler(async (req, res) => {
  const { order, user, amountDue, dueDate, adminNote } = req.body;

  if (!order || !user) {
    res.status(400);
    throw new Error("Order and user are required.");
  }

  const existingInvoice = await Invoice.findOne({ order });
  if (existingInvoice) {
    res.status(400);
    throw new Error("Invoice already exists for this order.");
  }

  const Order = (await import("../models/orderModel.js")).default;
  const orderDoc = await Order.findById(order);

  if (!orderDoc) {
    res.status(404);
    throw new Error("Order not found.");
  }

  if (orderDoc.totalPrice === 0) {
    res.status(400);
    throw new Error("Cannot generate an invoice for a free order.");
  }

  const invoice = await Invoice.create({
    order,
    user,
    amountDue: roundToTwo(amountDue), // ✅ Round to 2 decimals
    dueDate: dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    adminNote,
  });

  await Order.findByIdAndUpdate(order, {
    invoiceGenerated: true,
    invoice: invoice._id,
  });

  res.status(201).json(invoice);
});

// @desc    Update invoice (Admin only)
// @route   PUT /api/invoices/:id
// @access  Private/Admin
export const updateInvoice = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id);

  if (!invoice) {
    res.status(404);
    throw new Error("Invoice not found.");
  }

  Object.assign(invoice, req.body);

  // ✅ Enforce rounding if amountDue or amountPaid is updated
  if (invoice.amountDue !== undefined)
    invoice.amountDue = roundToTwo(invoice.amountDue);
  if (invoice.amountPaid !== undefined)
    invoice.amountPaid = roundToTwo(invoice.amountPaid);

  const updatedInvoice = await invoice.save();

  res.json(updatedInvoice);
});

// @desc    Delete invoice (Admin only)
// @route   DELETE /api/invoices/:id
// @access  Private/Admin
export const deleteInvoice = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id);

  if (!invoice) {
    res.status(404);
    throw new Error("Invoice not found.");
  }

  // ✅ Delete all payments linked to this invoice
  await Payment.deleteMany({ invoice: invoice._id });

  // ✅ Delete the invoice itself
  await invoice.deleteOne();

  res.status(204).end();
});

// @desc    Get logged-in user's invoices
// @route   GET /api/invoices/my
// @access  Private
export const getMyInvoices = asyncHandler(async (req, res) => {
  const invoices = await Invoice.find({ user: req.user._id })
    .populate("order", "orderNumber totalPrice")
    .populate("payments")
    .sort({ createdAt: -1 });

  res.json(invoices);
});

