import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";

import Invoice from "../models/invoiceModel.js";
import Order from "../models/orderModel.js";
import User from "../models/userModel.js";

/* -----------------------
   Helpers
------------------------ */
function toInt(v, fallback) {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function escapeRegex(text = "") {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SORT_MAP = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  amountHigh: { amountMinor: -1, createdAt: -1 },
  amountLow: { amountMinor: 1, createdAt: -1 },
};

// Convert "major" (e.g. 10.50) to integer minor (e.g. 1050), using factor (e.g. 100)
function toMinorUnits(majorAmount, factor = 100) {
  const n = Number(majorAmount);
  const f = Number(factor);
  if (!Number.isFinite(n)) return 0;
  if (!Number.isFinite(f) || f <= 0) return Math.round(n * 100);
  return Math.round(n * f);
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

/**
 * @desc    Admin: list invoices (filters + pagination)
 * @route   GET /api/invoices
 * @access  Private/Admin
 *
 * Query params (all optional):
 * - page, limit
 * - status=Issued|Cancelled
 * - paymentStatus=Unpaid|PartiallyPaid|Paid
 * - unpaid=true  (Issued + paymentStatus != Paid)
 * - overdue=true (dueDate < now + balanceDueMinor > 0 + status != Cancelled)
 * - user=<userId>  (filter by client)
 * - from=YYYY-MM-DD, to=YYYY-MM-DD (createdAt range)
 * - search=<string> (invoiceNumber/orderNumber/user name/email, case-insensitive)
 * - sort=newest|oldest|amountHigh|amountLow (newest/oldest use createdAt)
 * - q=<string> (legacy alias for search)
 */
export const getInvoices = asyncHandler(async (req, res) => {
  const page = Math.max(1, toInt(req.query.page, 1));
  const limitRaw = toInt(req.query.limit, 5);
  const limit = Math.min(Math.max(1, limitRaw), 5);
  const sortKey = req.query.sort ? String(req.query.sort) : "newest";
  const sort = SORT_MAP[sortKey] || SORT_MAP.newest;

  const status = req.query.status ? String(req.query.status) : null;
  const paymentStatus = req.query.paymentStatus ? String(req.query.paymentStatus) : null;
  const unpaid = String(req.query.unpaid || "").toLowerCase() === "true";
  const overdue = String(req.query.overdue || "").toLowerCase() === "true";

  const user = req.query.user ? String(req.query.user) : null;
  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);

  const search = req.query.search ? String(req.query.search).trim() : "";
  const qText = search || (req.query.q ? String(req.query.q).trim() : "");

  const filter = {};

  if (status) filter.status = status;
  if (paymentStatus) filter.paymentStatus = paymentStatus;

  if (unpaid) {
    filter.status = "Issued";
    filter.paymentStatus = { $ne: "Paid" };
  }

  if (user) {
    if (!mongoose.Types.ObjectId.isValid(user)) {
      res.status(400);
      throw new Error("Invalid user filter.");
    }
    filter.user = user;
  }

  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }

  if (overdue) {
    filter.status = "Issued";
    filter.balanceDueMinor = { $gt: 0 };
    if (!filter.paymentStatus) {
      filter.paymentStatus = { $ne: "Paid" };
    }
    filter.dueDate = { $lt: new Date(), $type: "date" };
  }

  // Search:
  // - invoiceNumber matches q (case-insensitive)
  // - OR invoices whose linked order.orderNumber matches q
  let orderIdsForSearch = [];
  let userIdsForSearch = [];
  if (qText) {
    // invoiceNumber regex
    const invoiceNumberRegex = new RegExp(escapeRegex(qText), "i");

    const [orders, users] = await Promise.all([
      Order.find({ orderNumber: invoiceNumberRegex })
        .select("_id")
        .limit(200)
        .lean(),
      User.find({ $or: [{ name: invoiceNumberRegex }, { email: invoiceNumberRegex }] })
        .select("_id")
        .limit(200)
        .lean(),
    ]);

    orderIdsForSearch = orders.map((o) => o._id);
    userIdsForSearch = users.map((u) => u._id);

    filter.$or = [
      { invoiceNumber: invoiceNumberRegex },
      ...(orderIdsForSearch.length ? [{ order: { $in: orderIdsForSearch } }] : []),
      ...(userIdsForSearch.length ? [{ user: { $in: userIdsForSearch } }] : []),
    ];
  }

  const skip = (page - 1) * limit;

  const [total, items] = await Promise.all([
    Invoice.countDocuments(filter),
    Invoice.find(filter)
      .select(
        [
          "invoiceNumber",
          "status",
          "amountMinor",
          "currency",
          "minorUnitFactor",
          "paidTotalMinor",
          "balanceDueMinor",
          "paymentStatus",
          "dueDate",
          "adminNote",
          "cancelReason",
          "cancelledAt",
          "createdAt",
          "user",
          "order",
        ].join(" ")
      )
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate({ path: "user", select: "name email" }) // adjust to your User schema
      .populate({ path: "order", select: "orderNumber status totalPrice createdAt" })
      .lean(),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  res.json({
    success: true,
    message: "Invoices retrieved successfully.",
    page,
    pages: totalPages,
    total,
    limit,
    items,
    data: items,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasPrev: page > 1,
      hasNext: page < totalPages,
    },
  });
});

/**
 * @desc    Admin: update invoice (non-sensitive fields only)
 * @route   PUT /api/invoices/:id
 * @access  Private/Admin
 *
 * Allowed fields:
 * - dueDate
 * - adminNote
 * - status (Issued/Cancelled)
 * - cancelReason (optional, mainly when cancelling)
 *
 * Disallowed / ignored:
 * - amountMinor, paidTotalMinor, balanceDueMinor, paymentStatus
 * - user, order, invoiceNumber
 * - currency, minorUnitFactor
 */
export const updateInvoice = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error("Invalid invoice id.");
  }

  const invoice = await Invoice.findById(id);
  if (!invoice) {
    res.status(404);
    throw new Error("Invoice not found.");
  }

  const allowed = pick(req.body || {}, ["dueDate", "adminNote", "status", "cancelReason"]);

  // dueDate: allow null to clear
  if (Object.prototype.hasOwnProperty.call(allowed, "dueDate")) {
    invoice.dueDate = allowed.dueDate ? new Date(allowed.dueDate) : null;
  }

  if (Object.prototype.hasOwnProperty.call(allowed, "adminNote")) {
    invoice.adminNote = allowed.adminNote ?? "";
  }

  if (Object.prototype.hasOwnProperty.call(allowed, "cancelReason")) {
    invoice.cancelReason = allowed.cancelReason ?? "";
  }

  if (Object.prototype.hasOwnProperty.call(allowed, "status")) {
    const nextStatus = String(allowed.status);

    if (!["Issued", "Cancelled"].includes(nextStatus)) {
      res.status(400);
      throw new Error("Invalid status. Allowed: Issued, Cancelled.");
    }

    // If cancelling now, stamp cancelledAt if missing
    if (nextStatus === "Cancelled" && invoice.status !== "Cancelled") {
      invoice.status = "Cancelled";
      invoice.cancelledAt = new Date();
      // cancelReason can be set above
    }

    // If re-issuing, clear cancellation stamps
    if (nextStatus === "Issued" && invoice.status !== "Issued") {
      invoice.status = "Issued";
      invoice.cancelledAt = null;
      invoice.cancelReason = "";
    }
  }

  const updated = await invoice.save();
  res.json(updated);
});

/**
 * @desc    Admin: delete invoice (only if Cancelled)
 * @route   DELETE /api/invoices/:id
 * @access  Private/Admin
 *
 * Notes:
 * - Model enforces "only Cancelled can be deleted" and cascades payments
 * - Controller also unlinks the order.invoice reference before delete to avoid dangling link
 */
export const deleteInvoice = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error("Invalid invoice id.");
  }

  const invoice = await Invoice.findById(id).select("_id status order");
  if (!invoice) {
    res.status(404);
    throw new Error("Invoice not found.");
  }

  if (invoice.status !== "Cancelled") {
    res.status(400);
    throw new Error("Only Cancelled invoices can be deleted.");
  }

  // Unlink order.invoice (best-effort)
  if (invoice.order) {
    await Order.findByIdAndUpdate(invoice.order, { $set: { invoice: null } });
  }

  // This will trigger model middleware (findOneAndDelete) and delete linked payments
  await Invoice.findByIdAndDelete(invoice._id);

  res.json({ message: "Invoice deleted." });
});

/**
 * @desc    Admin: create invoice for an order (canonical)
 * @route   POST /api/invoices/from-order/:orderId
 * @access  Private/Admin
 *
 * Behavior:
 * - Creates Invoice (snapshot)
 * - Links Order.invoice to the new invoice id
 * - Enforces 1:1 order->invoice
 *
 * Notes:
 * - Order.totalPrice is in major units (Number). We convert to minor units here.
 * - You can later move Order totals to minor units too, but not required immediately.
 */
export const createInvoiceForOrder = asyncHandler(async (req, res) => {
  const { orderId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    res.status(400);
    throw new Error("Invalid order id.");
  }

  const order = await Order.findById(orderId)
    .select("_id user status totalPrice invoice orderNumber")
    .lean();

  if (!order) {
    res.status(404);
    throw new Error("Order not found.");
  }

  if (order.invoice) {
    res.status(400);
    throw new Error("This order already has an invoice.");
  }

  // You told us: admins usually create invoice from an order.
  // Keep this aligned with your business flow; adjust allowed statuses as you like.
  const allowedOrderStatuses = ["Processing", "Delivered", "Cancelled"];
  if (!allowedOrderStatuses.includes(order.status)) {
    res.status(400);
    throw new Error(
      `Invoice can only be created for orders in status: ${allowedOrderStatuses.join(", ")}.`
    );
  }

  // Optional: Don’t allow creating invoices for cancelled orders unless you want it
  // If you want to block it, uncomment:
  // if (order.status === "Cancelled") {
  //   res.status(400);
  //   throw new Error("Cannot create invoice for a Cancelled order.");
  // }

  // Currency defaults: you can later pass these from request body or store settings
  const currency = (req.body?.currency ? String(req.body.currency) : "AED").toUpperCase();
  const minorUnitFactor = Number.isInteger(req.body?.minorUnitFactor)
    ? req.body.minorUnitFactor
    : 100;

  const amountMinor = toMinorUnits(order.totalPrice, minorUnitFactor);

  // Create invoice
  const invoice = await Invoice.create({
    user: order.user,
    order: order._id,
    amountMinor,
    currency,
    minorUnitFactor,
    // optional admin fields
    dueDate: req.body?.dueDate ? new Date(req.body.dueDate) : undefined,
    adminNote: req.body?.adminNote ? String(req.body.adminNote) : undefined,
    status: "Issued",
  });

  // Link order -> invoice (1:1)
  await Order.findByIdAndUpdate(order._id, { $set: { invoice: invoice._id } });

  // Return populated invoice for admin UI convenience
  const populated = await Invoice.findById(invoice._id)
    .populate({ path: "user", select: "name email" })
    .populate({ path: "order", select: "orderNumber status totalPrice createdAt" });

  res.status(201).json(populated);
});
