// megadie-backend/controllers/invoiceUserController.js
import mongoose from "mongoose";
import Invoice from "../models/invoiceModel.js";
import asyncHandler from "../middleware/asyncHandler.js";

/* -----------------------
   Small helpers
------------------------ */
function toInt(v, fallback) {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parses a date-ish input.
 * - Returns null if invalid
 * - If `bound === "start"` => 00:00:00.000
 * - If `bound === "end"`   => 23:59:59.999
 */
function parseBoundedDate(v, bound) {
  if (!v) return null;

  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;

  // Normalize to day boundary to avoid "to date excludes same day" surprises
  if (bound === "start") d.setHours(0, 0, 0, 0);
  if (bound === "end") d.setHours(23, 59, 59, 999);

  return d;
}

function isAdminUser(req) {
  // adjust if your user object uses role instead of isAdmin
  return Boolean(req.user?.isAdmin);
}

const ALLOWED_STATUSES = new Set(["Issued", "Cancelled"]);

/**
 * @desc    Get my invoices (filtered + paginated)
 * @route   GET /api/invoices/my?page=1&limit=10&unpaid=true&status=Issued&from=YYYY-MM-DD&to=YYYY-MM-DD
 * @access  Private (owner)
 *
 * Frontend:
 * - Render as cards using invoice summary + (optional) orderNumber/status
 */
export const getMyInvoices = asyncHandler(async (req, res) => {
  const userId = req.user?._id;

  // Pagination
  const page = Math.max(1, toInt(req.query.page, 1));
  const limitRaw = toInt(req.query.limit, 10);
  const limit = Math.min(Math.max(1, limitRaw), 25);

  // Filters
  const unpaid = String(req.query.unpaid || "").toLowerCase() === "true";

  const statusRaw = req.query.status ? String(req.query.status).trim() : null;
  const status = statusRaw ? statusRaw : null;

  if (status && !ALLOWED_STATUSES.has(status)) {
    res.status(400);
    throw new Error(`Invalid status. Allowed: ${Array.from(ALLOWED_STATUSES).join(", ")}`);
  }

  const from = parseBoundedDate(req.query.from, "start");
  const to = parseBoundedDate(req.query.to, "end");

  if (req.query.from && !from) {
    res.status(400);
    throw new Error("Invalid 'from' date.");
  }
  if (req.query.to && !to) {
    res.status(400);
    throw new Error("Invalid 'to' date.");
  }
  if (from && to && from.getTime() > to.getTime()) {
    res.status(400);
    throw new Error("'from' date must be before or equal to 'to' date.");
  }

  const q = { user: userId };

  if (status) q.status = status;

  if (from || to) {
    q.createdAt = {};
    if (from) q.createdAt.$gte = from;
    if (to) q.createdAt.$lte = to;
  }

  // Unpaid filter (Issued + not fully paid)
  if (unpaid) {
    q.status = "Issued";
    q.paymentStatus = { $ne: "Paid" }; // Unpaid or PartiallyPaid
  }

  const skip = (page - 1) * limit;

  const [total, items] = await Promise.all([
    Invoice.countDocuments(q),
    Invoice.find(q)
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
          "createdAt",
          "order",
        ].join(" ")
      )
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({
        path: "order",
        // keep the card UI light + user-safe
        select: "orderNumber status createdAt deliveredAt",
      })
      .lean(),
  ]);

  const pages = Math.max(1, Math.ceil(total / limit));

  res.json({
    page,
    pages,
    total,
    limit,
    items,
  });
});

/**
 * @desc    Get invoice details (owner OR admin)
 * @route   GET /api/invoices/:id
 * @access  Private (owner or admin)
 *
 * Frontend:
 * - Show full invoice + linked payments + linked order details
 */
export const getInvoiceById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error("Invalid invoice id.");
  }

  // 1) Cheap lookup for auth first (avoid populating sensitive stuff unnecessarily)
  const authProbe = await Invoice.findById(id).select("user").lean();
  if (!authProbe) {
    res.status(404);
    throw new Error("Invoice not found.");
  }

  const ownerId = String(authProbe.user);
  const requesterId = String(req.user?._id);

  if (!isAdminUser(req) && ownerId !== requesterId) {
    res.status(403);
    throw new Error("Not authorized to view this invoice.");
  }

  // 2) Now fetch full invoice with safe populates
  const invoice = await Invoice.findById(id)
    .populate({
      path: "order",
      // user-safe fields only (avoid admin-only internals)
      select: [
        "orderNumber",
        "status",
        "createdAt",
        "deliveredAt",
        "deliveredBy",
        "orderItems",
        "totalPrice",
        "deliveryCharge",
        "extraFee",
        "clientToAdminNote",
        "adminToClientNote",
      ].join(" "),
      populate: {
        path: "orderItems.product",
        select: "name image price sku", // adjust to your Product schema fields
      },
    })
    .populate({
      path: "payments",
      options: { sort: { paymentDate: -1, createdAt: -1 } },
      select: [
        "amountMinor",
        "paymentMethod",
        "paymentDate",
        "note",
        "reference",
        "receivedBy",
        "createdAt",
      ].join(" "),
    })
    .lean();

  // Extremely defensive: invoice could disappear between probe and fetch
  if (!invoice) {
    res.status(404);
    throw new Error("Invoice not found.");
  }

  res.json(invoice);
});

/**
 * @desc    Get invoice PDF (NOT IMPLEMENTED YET)
 * @route   GET /api/invoices/:id/pdf
 * @access  Private (owner or admin) — route uses protect
 */
export const getInvoicePDF = asyncHandler(async (_req, res) => {
  res.status(501).json({
    message: "Invoice PDF is handled elsewhere (not implemented here yet).",
  });
});
