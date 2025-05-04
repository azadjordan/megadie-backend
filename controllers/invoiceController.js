// ✅ invoiceController.js
import asyncHandler from "../middleware/asyncHandler.js";
import Invoice from "../models/invoiceModel.js";
import Order from "../models/orderModel.js";
import fs from "fs/promises";
import puppeteer from "puppeteer";
import Payment from "../models/paymentModel.js"; // ✅ Make sure this is imported
import { roundToTwo } from "../utils/rounding.js"; // ✅ Add this utility function

// @desc Generate PDF invoice using Puppeteer and Tailwind template
// @route GET /api/invoices/:id/pdf
// @access Private/Admin
export const getInvoicePDF = asyncHandler(async (req, res) => {
  // 1. Fetch invoice
  const invoice = await Invoice.findById(req.params.id)
    .populate("user", "name email")
    .populate("order");

  if (!invoice) {
    res.status(404);
    throw new Error("Invoice not found");
  }

  // 2. Fetch order
  const order = await Order.findById(invoice.order._id)
    .populate("orderItems.product", "name");

  if (!order) {
    res.status(404);
    throw new Error("Order not found");
  }

  // 3. Read HTML template
  const template = await fs.readFile("megadie-backend/templates/invoice.html", "utf8");

  // 4. Prepare the items HTML
  const itemsHtml = order.orderItems
    .map(
      (item) => `
        <tr>
          <td class="border p-3">${item.product?.name || "Unnamed Item"}</td>
          <td class="border p-3 text-right">${item.qty}</td>
        </tr>`
    )
    .join("");

  // 5. Prepare values
  const totalAmount = invoice.amountDue || 0;      // Original full invoice amount
  const amountPaid = invoice.amountPaid || 0;       // What client has paid so far
  const amountDue = totalAmount - amountPaid;       // Remaining balance

  // 6. Fill the template
  const filledHtml = template
    .replace("{{invoiceNumber}}", invoice.invoiceNumber || "N/A")
    .replace("{{invoiceDate}}", new Date(invoice.createdAt).toLocaleDateString())
    .replace("{{status}}", invoice.status || "Pending")
    .replace("{{userName}}", invoice.user?.name || "Client")
    .replace("{{userEmail}}", invoice.user?.email || "—")
    .replace("{{totalAmount}}", totalAmount.toFixed(2))
    .replace("{{amountPaid}}", amountPaid.toFixed(2))
    .replace("{{amountDue}}", amountDue.toFixed(2))  // <-- Correct placeholder
    .replace("{{items}}", itemsHtml);

  // 7. Launch Puppeteer
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (["image", "stylesheet", "font"].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  await page.setContent(filledHtml, { waitUntil: "networkidle0" });

  // 8. Generate the PDF
  const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });
  await browser.close();

  // 9. Send the PDF
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename=invoice-${invoice.invoiceNumber}.pdf`);
  res.end(pdfBuffer);
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

