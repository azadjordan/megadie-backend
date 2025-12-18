import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import Invoice from "../models/invoiceModel.js";
import Payment from "../models/paymentModel.js";
import Order from "../models/orderModel.js";
import InvoicePDF from "../utils/InvoicePDF.js";
import { renderToStream } from "@react-pdf/renderer";
import { createElement } from "react";

import { computeInvoiceFinancials } from "../utils/invoiceFinancials.js";

/* =========================
   Helpers (filters + pagination)
   ========================= */
const parsePagination = (req, { defaultLimit = 20, maxLimit = 100 } = {}) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(
    Math.max(parseInt(req.query.limit, 10) || defaultLimit, 1),
    maxLimit
  );
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

const buildInvoiceMatch = (req) => {
  const {
    invoiceNumber, // partial ok
    user, // userId
    createdFrom,
    createdTo,
    dueFrom,
    dueTo,
    // status/outstanding are applied AFTER compute in code
    status, // Paid | Unpaid | Partially Paid | Overdue
    outstanding, // 'true' => balanceDue > 0
  } = req.query || {};

  const match = {};
  if (invoiceNumber) {
    match.invoiceNumber = { $regex: invoiceNumber, $options: "i" };
  }

  if (user) {
    if (!mongoose.isValidObjectId(String(user))) {
      const err = new Error("Invalid user id.");
      err.statusCode = 400;
      throw err;
    }
    match.user = new mongoose.Types.ObjectId(user);
  }

  if (createdFrom || createdTo) {
    match.createdAt = {};
    if (createdFrom) match.createdAt.$gte = new Date(createdFrom);
    if (createdTo) match.createdAt.$lte = new Date(createdTo);
  }

  if (dueFrom || dueTo) {
    match.dueDate = match.dueDate || {};
    if (dueFrom) match.dueDate.$gte = new Date(dueFrom);
    if (dueTo) match.dueDate.$lte = new Date(dueTo);
  }

  return {
    match,
    status: status || undefined,
    outstanding: String(outstanding || "").toLowerCase() === "true",
  };
};

/* =========================
   GET /api/invoices/:id/pdf
   Private/Admin OR Owner
   Generate PDF for invoice with correct totals/status
   ========================= */
export const getInvoicePDF = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id)
    .populate("user", "name email")
    .populate({
      path: "order",
      select:
        "orderNumber totalPrice status orderItems deliveredAt deliveryCharge extraFee",
      populate: { path: "orderItems.product", select: "name" },
    })
    .populate("payments");

  if (!invoice) {
    res.status(404);
    throw new Error("Invoice not found.");
  }

  const isAdmin = !!req.user?.isAdmin;
  const isOwner =
    String(invoice.user?._id || invoice.user) === String(req.user?._id);

  if (!isAdmin && !isOwner) {
    res.status(403);
    throw new Error("Not authorized to view this invoice PDF.");
  }

  const payments = Array.isArray(invoice.payments) ? invoice.payments : [];

  const fin = computeInvoiceFinancials({
    amount: invoice.amount,
    dueDate: invoice.dueDate,
    payments,
  });

  // Attach computed fields for the PDF template only
  const invoiceForPdf = {
    ...(typeof invoice.toObject === "function" ? invoice.toObject() : invoice),
    totalPaid: fin.totalPaid,
    balanceDue: fin.balanceDue,
    status: fin.status,
  };

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename=invoice-${invoice.invoiceNumber || invoice._id}.pdf`
  );

  const company = {
    name: "Megadie",
    short: "Megadie",
    display: "Megadie.com",
    sub: "",
    footer: "Read T&C at www.megadie.com",
  };

  const pdfStream = await renderToStream(
    createElement(InvoicePDF, {
      invoice: invoiceForPdf,
      order: invoice.order,
      company,
    })
  );

  pdfStream.pipe(res);
});

/* =========================
   GET /api/invoices/:id
   Private/Admin or Owner
   (Detail view) Returns invoice + payments + computed fields
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

  const isAdmin = !!req.user?.isAdmin;
  const isOwner =
    String(invoice.user?._id || invoice.user) === String(req.user?._id);

  if (!isAdmin && !isOwner) {
    res.status(403);
    throw new Error("Not authorized to view this invoice.");
  }

  const payments = Array.isArray(invoice.payments) ? invoice.payments : [];

  const fin = computeInvoiceFinancials({
    amount: invoice.amount,
    dueDate: invoice.dueDate,
    payments,
  });

  const payload = {
    ...(typeof invoice.toObject === "function" ? invoice.toObject() : invoice),
    totalPaid: fin.totalPaid,
    balanceDue: fin.balanceDue,
    status: fin.status,
  };

  res.status(200).json({
    success: true,
    message: "Invoice retrieved successfully.",
    data: payload,
  });
});

/* =========================
   POST /api/invoices/from-order/:orderId
   Private/Admin
   ========================= */
export const createInvoiceForOrder = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const { dueDate, adminNote } = req.body || {};

  const orderDoc = await Order.findById(orderId).select(
    "status totalPrice user invoice orderNumber"
  );

  if (!orderDoc) {
    res.status(404);
    throw new Error("Order not found.");
  }

  if (orderDoc.invoice) {
    res.status(400);
    throw new Error("Invoice already exists for this order.");
  }

  // ✅ Allowed statuses for invoice creation
  const allowedStatuses = ["Processing", "Delivered"];
  if (!allowedStatuses.includes(orderDoc.status)) {
    res.status(400);
    throw new Error(
      `Invoice can only be created for orders in status: ${allowedStatuses.join(
        " or "
      )}.`
    );
  }

  // amount is immutable and comes from order.totalPrice (rounded by util)
  const invoice = await Invoice.create({
    order: orderDoc._id,
    user: orderDoc.user,
    amount: orderDoc.totalPrice,
    dueDate: dueDate || undefined,
    adminNote,
  });

  await Order.findByIdAndUpdate(
    orderDoc._id,
    { $set: { invoice: invoice._id } },
    { runValidators: false }
  );

  await invoice.populate([
    "payments",
    { path: "order", select: "orderNumber totalPrice status" },
  ]);

  const fin = computeInvoiceFinancials({
    amount: invoice.amount,
    dueDate: invoice.dueDate,
    payments: Array.isArray(invoice.payments) ? invoice.payments : [],
  });

  res.setHeader("Location", `/api/invoices/${invoice._id}`);

  res.status(201).json({
    success: true,
    message: `Invoice created from order ${orderDoc.orderNumber} successfully.`,
    data: {
      ...(typeof invoice.toObject === "function" ? invoice.toObject() : invoice),
      totalPaid: fin.totalPaid,
      balanceDue: fin.balanceDue,
      status: fin.status,
    },
  });
});

/* =========================
   PUT /api/invoices/:id
   Private/Admin
   Allowed fields: dueDate, adminNote
   ========================= */
export const updateInvoice = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) {
    res.status(404);
    throw new Error("Invoice not found.");
  }

  const { dueDate, adminNote, user, order, amount, ...rest } = req.body || {};

  if (typeof user !== "undefined" || typeof order !== "undefined") {
    res.status(400);
    throw new Error("Cannot change 'user' or 'order' of an invoice.");
  }
  if (typeof amount !== "undefined") {
    res.status(400);
    throw new Error(
      "Cannot change 'amount' of an invoice. Delete & recreate via the Order if needed."
    );
  }

  const changes = {};

  if (typeof dueDate !== "undefined") {
    const newDue = dueDate ? new Date(dueDate) : undefined;
    const cur = invoice.dueDate ? invoice.dueDate.toISOString() : null;
    const nxt = newDue ? newDue.toISOString() : null;
    if (cur !== nxt) {
      changes.dueDate = { from: invoice.dueDate || null, to: newDue || null };
      invoice.dueDate = newDue;
    }
  }

  if (typeof adminNote !== "undefined" && adminNote !== invoice.adminNote) {
    changes.adminNote = {
      from: invoice.adminNote || null,
      to: adminNote || null,
    };
    invoice.adminNote = adminNote;
  }

  const updated = await invoice.save();
  await updated.populate([
    "payments",
    { path: "order", select: "orderNumber totalPrice status" },
  ]);

  const fin = computeInvoiceFinancials({
    amount: updated.amount,
    dueDate: updated.dueDate,
    payments: Array.isArray(updated.payments) ? updated.payments : [],
  });

  const changedKeys = Object.keys(changes);
  const message = changedKeys.length
    ? `Invoice updated successfully (${changedKeys.join(", ")}).`
    : "Invoice saved (no changes detected).";

  res.json({
    success: true,
    message,
    changed: changes,
    data: {
      ...(typeof updated.toObject === "function" ? updated.toObject() : updated),
      totalPaid: fin.totalPaid,
      balanceDue: fin.balanceDue,
      status: fin.status,
    },
  });
});

/* =========================
   DELETE /api/invoices/:id
   Private/Admin
   Cascade delete dependent payments, then unlink from parent order.
   ========================= */
export const deleteInvoice = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id).select("_id order");
  if (!invoice) {
    res.status(404);
    throw new Error("Invoice not found.");
  }

  let orderUnlinked = false;
  if (invoice.order) {
    const upd = await Order.updateOne(
      { _id: invoice.order, invoice: invoice._id },
      { $set: { invoice: null } }
    );
    orderUnlinked = upd.modifiedCount > 0;
  }

  const payDel = await Payment.deleteMany({ invoice: invoice._id });
  const paymentsDeleted = payDel.deletedCount || 0;

  await invoice.deleteOne();

  const message = orderUnlinked
    ? `Invoice deleted and unlinked from its order successfully. (${paymentsDeleted} related payments removed.)`
    : `Invoice deleted successfully. (${paymentsDeleted} related payments removed.)`;

  res.status(200).json({
    success: true,
    message,
    invoiceId: invoice._id,
    orderUnlinked,
    paymentsDeleted,
  });
});

/* =========================
   GET /api/invoices
   Private/Admin
   Admin list with filters + pagination (computed totals/status)
   Filters:
     - invoiceNumber (partial)
     - user (userId)
     - createdFrom/createdTo
     - dueFrom/dueTo
     - status (Paid|Unpaid|Partially Paid|Overdue)  [computed]
     - outstanding=true (balanceDue > 0)            [computed]
   ========================= */
export const getInvoices = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req);
  const { match, status, outstanding } = buildInvoiceMatch(req);

  // 1) Pull ALL invoice rows that match base filters (lightweight)
  const rowsRaw = await Invoice.find(match)
    .populate("user", "name email")
    .sort({ createdAt: -1, _id: -1 }) // newest first, stable
    .select("invoiceNumber amount dueDate createdAt user order")
    .lean();

  const invoiceIds = rowsRaw.map((r) => r._id);

  // 2) Fetch Received payments in ONE query (minimal payload)
  const pays = await Payment.find({
    invoice: { $in: invoiceIds },
    status: "Received",
  })
    .select("invoice amount status")
    .lean();

  const paidByInvoice = new Map();
  for (const p of pays) {
    const key = String(p.invoice);
    const arr = paidByInvoice.get(key) || [];
    arr.push(p);
    paidByInvoice.set(key, arr);
  }

  // 3) Compute financials (single source of truth)
  let computed = rowsRaw.map((inv) => {
    const fin = computeInvoiceFinancials({
      amount: inv.amount,
      dueDate: inv.dueDate,
      payments: paidByInvoice.get(String(inv._id)) || [],
    });

    return {
      ...inv,
      userName: inv.user?.name,
      userEmail: inv.user?.email,
      totalPaid: fin.totalPaid,
      balanceDue: fin.balanceDue,
      status: fin.status,
    };
  });

  // 4) Apply computed filters BEFORE pagination
  if (status) computed = computed.filter((x) => x.status === status);
  if (outstanding) computed = computed.filter((x) => (x.balanceDue || 0) > 0);

  // 5) Paginate the filtered results
  const total = computed.length;
  const totalPages = Math.max(Math.ceil(total / limit), 1);
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * limit;

  const items = computed.slice(start, start + limit);

  res.status(200).json({
    success: true,
    message: "Invoices retrieved successfully.",
    data: items,
    pagination: {
      page: safePage,
      limit,
      total,
      totalPages,
      hasPrev: safePage > 1,
      hasNext: safePage * limit < total,
    },
  });
});

/* =========================
   GET /api/invoices/my
   Private (owner)

   Business rules:
   - Single source of truth for totals/status via computeInvoiceFinancials
   - Limit is server-enforced to 10 per page
   - Sort: newest → oldest (createdAt desc, _id desc)
   - Toggle: ?unpaid=true
       → shows invoices that are NOT fully paid
       → defined strictly as: totalPaid < amount (after rounding)
   - Filtering is applied BEFORE pagination so pagination reflects what user sees
   ========================= */
export const getMyInvoices = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = 10; // ✅ enforced, not client-controlled

  const unpaidOnly = String(req.query.unpaid || "").toLowerCase() === "true";

  // --- Validate user ---
  const userIdStr = String(req.user?._id || "");
  if (!mongoose.isValidObjectId(userIdStr)) {
    res.status(401);
    throw new Error("Not authorized (invalid user id).");
  }
  const userId = new mongoose.Types.ObjectId(userIdStr);

  // --- 1) Fetch ALL invoices for this user (lightweight fields only)
  // We intentionally fetch all first so filters are applied BEFORE pagination
  const rowsRaw = await Invoice.find({ user: userId })
    .sort({ createdAt: -1, _id: -1 }) // newest first, stable
    .select("invoiceNumber amount dueDate createdAt order")
    .lean();

  const invoiceIds = rowsRaw.map((r) => r._id);

  // --- 2) Fetch ONLY received payments for these invoices (single query)
  const pays = invoiceIds.length
    ? await Payment.find({
        invoice: { $in: invoiceIds },
        status: "Received",
      })
        .select("invoice amount status")
        .lean()
    : [];

  // Group payments by invoice id
  const paidByInvoice = new Map();
  for (const p of pays) {
    const key = String(p.invoice);
    const arr = paidByInvoice.get(key) || [];
    arr.push(p);
    paidByInvoice.set(key, arr);
  }

  // --- 3) Compute financials (single source of truth)
  let computed = rowsRaw.map((inv) => {
    const fin = computeInvoiceFinancials({
      amount: inv.amount,
      dueDate: inv.dueDate,
      payments: paidByInvoice.get(String(inv._id)) || [],
    });

    return {
      ...inv,
      amount: fin.amount,           // rounded
      totalPaid: fin.totalPaid,     // rounded
      balanceDue: fin.balanceDue,   // rounded
      status: fin.status,           // derived
    };
  });

  // --- 4) Apply "unpaid only" filter BEFORE pagination
  // Definition: NOT fully paid → totalPaid < amount
  if (unpaidOnly) {
    computed = computed.filter(
      (x) => (x.totalPaid || 0) < (x.amount || 0)
    );
  }

  // --- 5) Paginate the filtered result
  const total = computed.length;
  const totalPages = Math.max(Math.ceil(total / limit), 1);
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * limit;

  const items = computed.slice(start, start + limit);

  res.status(200).json({
    success: true,
    message: "Your invoices retrieved successfully.",
    filters: { unpaid: unpaidOnly },
    pagination: {
      page: safePage,
      limit,
      total,
      totalPages,
      hasPrev: safePage > 1,
      hasNext: safePage * limit < total,
    },
    items,
  });
});
