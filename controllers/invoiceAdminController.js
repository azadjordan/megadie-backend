import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";

import Invoice from "../models/invoiceModel.js";
import Order from "../models/orderModel.js";
import Payment from "../models/paymentModel.js";
import User from "../models/userModel.js";
import Quote from "../models/quoteModel.js";

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

function toMinorUnits(majorAmount, factor = 100) {
  const n = Number(majorAmount);
  const f = Number(factor);
  if (!Number.isFinite(n)) return NaN;
  if (!Number.isFinite(f) || f <= 0) return Math.round(n * 100);
  return Math.round(n * f);
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

const INVOICE_STATUS_ALLOWED = new Set(Invoice.schema.path("status")?.enumValues || []);
const INVOICE_PAYMENT_STATUS_ALLOWED = new Set(
  Invoice.schema.path("paymentStatus")?.enumValues || []
);


function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

/**
 * @desc    Admin: invoice balance summary (unpaid + overdue totals)
 * @route   GET /api/invoices/summary
 * @access  Private/Admin
 */
export const getInvoicesSummary = asyncHandler(async (req, res) => {
  const now = new Date();

  const baseMatch = {
    status: "Issued",
    paymentStatus: { $ne: "Paid" },
    balanceDueMinor: { $gt: 0 },
  };

  const search = req.query.search ? String(req.query.search).trim() : "";
  const user = req.query.user ? String(req.query.user) : null;

  if (user) {
    if (!mongoose.Types.ObjectId.isValid(user)) {
      res.status(400);
      throw new Error("Invalid user filter.");
    }
    baseMatch.user = new mongoose.Types.ObjectId(user);
  }

  if (search) {
    const invoiceNumberRegex = new RegExp(escapeRegex(search), "i");
    const orders = await Order.find({ orderNumber: invoiceNumberRegex })
      .select("_id")
      .limit(200)
      .lean();

    const orderIds = orders.map((o) => o._id);

    baseMatch.$or = [
      { invoiceNumber: invoiceNumberRegex },
      ...(orderIds.length ? [{ order: { $in: orderIds } }] : []),
    ];
  }

  const [summary] = await Invoice.aggregate([
    { $match: baseMatch },
    {
      $facet: {
        unpaid: [
          {
            $group: {
              _id: null,
              total: { $sum: "$balanceDueMinor" },
              count: { $sum: 1 },
            },
          },
        ],
        overdue: [
          { $match: { dueDate: { $lt: now, $type: "date" } } },
          {
            $group: {
              _id: null,
              total: { $sum: "$balanceDueMinor" },
              count: { $sum: 1 },
            },
          },
        ],
      },
    },
  ]);

  const unpaid = summary?.unpaid?.[0] || {};
  const overdue = summary?.overdue?.[0] || {};

  res.json({
    unpaidTotalMinor: unpaid.total || 0,
    unpaidCount: unpaid.count || 0,
    overdueTotalMinor: overdue.total || 0,
    overdueCount: overdue.count || 0,
    currency: "AED",
    minorUnitFactor: 100,
  });
});

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
 * - search=<string> (invoiceNumber/orderNumber, case-insensitive)
 * - sort=newest|oldest|amountHigh|amountLow (newest/oldest use createdAt)
 * - q=<string> (legacy alias for search)
 */
export const getInvoices = asyncHandler(async (req, res) => {
  const page = Math.max(1, toInt(req.query.page, 1));
  const limitRaw = toInt(req.query.limit, 20);
  const limit = Math.min(Math.max(1, limitRaw), 20);
  const sortKey = req.query.sort ? String(req.query.sort) : "newest";
  const sort = SORT_MAP[sortKey] || SORT_MAP.newest;

  const status = req.query.status ? String(req.query.status) : null;
  const paymentStatus = req.query.paymentStatus ? String(req.query.paymentStatus) : null;
  const unpaid = String(req.query.unpaid || "").toLowerCase() === "true";
  const overdue = String(req.query.overdue || "").toLowerCase() === "true";

  if (status && !INVOICE_STATUS_ALLOWED.has(status)) {
    res.status(400);
    throw new Error(
      `Invalid status. Allowed: ${Array.from(INVOICE_STATUS_ALLOWED).join(", ")}.`
    );
  }

  if (paymentStatus && !INVOICE_PAYMENT_STATUS_ALLOWED.has(paymentStatus)) {
    res.status(400);
    throw new Error(
      `Invalid paymentStatus. Allowed: ${Array.from(INVOICE_PAYMENT_STATUS_ALLOWED).join(
        ", "
      )}.`
    );
  }

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
    filter.user = new mongoose.Types.ObjectId(user);
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
  if (qText) {
    // invoiceNumber regex
    const invoiceNumberRegex = new RegExp(escapeRegex(qText), "i");
    const orders = await Order.find({ orderNumber: invoiceNumberRegex })
      .select("_id")
      .limit(200)
      .lean();

    orderIdsForSearch = orders.map((o) => o._id);

    filter.$or = [
      { invoiceNumber: invoiceNumberRegex },
      ...(orderIdsForSearch.length ? [{ order: { $in: orderIdsForSearch } }] : []),
    ];
  }

  const skip = (page - 1) * limit;

  const [total, items] = await Promise.all([
    Invoice.countDocuments(filter),
    Invoice.find(filter)
      .select(
        [
          "source",
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

  // dueDate: required
  if (Object.prototype.hasOwnProperty.call(allowed, "dueDate")) {
    const parsed = parseDate(allowed.dueDate);
    if (!parsed) {
      res.status(400);
      throw new Error("Invalid due date.");
    }
    invoice.dueDate = parsed;
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

  const paymentsDeleted = await Payment.countDocuments({ invoice: invoice._id });

  // Unlink order.invoice (best-effort)
  let orderUnlinked = false;
  if (invoice.order) {
    const result = await Order.updateOne(
      { _id: invoice.order },
      { $set: { invoice: null } }
    );
    orderUnlinked = (result?.matchedCount || 0) > 0;
  }

  // Unlink manual invoice from quote (best-effort)
  let quoteUnlinked = false;
  if (invoice.source === "Manual") {
    const quoteResult = await mongoose
      .model("Quote")
      .updateOne(
        { manualInvoiceId: invoice._id },
        { $set: { manualInvoiceId: null, manualInvoiceCreatedAt: null } }
      );
    quoteUnlinked = (quoteResult?.matchedCount || 0) > 0;
  }

  // This will trigger model middleware (findOneAndDelete) and delete linked payments
  await Invoice.findByIdAndDelete(invoice._id);

  const message = invoice.order
    ? "Invoice and linked payments deleted AND Order unlinked."
    : "Invoice and linked payments deleted.";

  res.json({
    message,
    paymentsDeleted,
    orderUnlinked,
    quoteUnlinked,
  });
});

/**
 * @desc    Admin: create manual invoice (no order)
 * @route   POST /api/invoices/manual
 * @access  Private/Admin
 *
 * Body:
 * - userId (or user)
 * - dueDate (required)
 * - currency (optional)
 * - minorUnitFactor (optional)
 * - adminNote (optional)
 * - invoiceItems: [{ description, qty, unitPriceMinor }]
 */
export const createManualInvoice = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const quoteId = body.quoteId ? String(body.quoteId) : "";
  let userId = body.userId || body.user;
  let quote = null;

  if (quoteId) {
    if (!mongoose.Types.ObjectId.isValid(quoteId)) {
      res.status(400);
      throw new Error("Invalid quote id.");
    }

    quote = await Quote.findById(quoteId)
      .select("status order manualInvoiceId user quoteNumber")
      .lean();

    if (!quote) {
      res.status(404);
      throw new Error("Quote not found.");
    }

    if (quote.order) {
      res.status(409);
      throw new Error("Quote already has an order.");
    }

    if (quote.manualInvoiceId) {
      res.status(409);
      throw new Error("Manual invoice already exists for this quote.");
    }

    if (quote.status === "Cancelled") {
      res.status(409);
      throw new Error("Cancelled quotes cannot be invoiced.");
    }

    if (quote.status === "Confirmed") {
      res.status(409);
      throw new Error("Confirmed quotes should be invoiced from orders.");
    }

    if (!["Processing", "Quoted"].includes(quote.status)) {
      res.status(409);
      throw new Error("Only Processing or Quoted quotes can be invoiced manually.");
    }

    userId = quote.user;
  }

  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
    res.status(400);
    throw new Error("Valid userId is required.");
  }

  const userExists = await User.exists({ _id: userId });
  if (!userExists) {
    res.status(404);
    throw new Error("User not found.");
  }

  const rawDueDate = body.dueDate;
  if (!rawDueDate) {
    res.status(400);
    throw new Error("Due date is required.");
  }
  const dueDate = parseDate(rawDueDate);
  if (!dueDate) {
    res.status(400);
    throw new Error("Invalid due date.");
  }

  const minorUnitFactor = Object.prototype.hasOwnProperty.call(
    body,
    "minorUnitFactor"
  )
    ? Number(body.minorUnitFactor)
    : 100;

  if (!Number.isInteger(minorUnitFactor) || minorUnitFactor <= 0) {
    res.status(400);
    throw new Error("minorUnitFactor must be a positive integer.");
  }

  const currencyRaw = typeof body.currency === "string" ? body.currency.trim() : "";
  const currency = currencyRaw ? currencyRaw.toUpperCase() : undefined;
  const adminNote =
    typeof body.adminNote === "string" ? body.adminNote.trim() : undefined;

  if (!Array.isArray(body.invoiceItems) || body.invoiceItems.length === 0) {
    res.status(400);
    throw new Error("At least one invoice item is required.");
  }

  const cleanedItems = [];
  for (let idx = 0; idx < body.invoiceItems.length; idx += 1) {
    const row = body.invoiceItems[idx];
    const description = String(row?.description || "").trim();
    const qty = Number(row?.qty);
    const unitPriceMinor = Number(row?.unitPriceMinor);

    if (!description) {
      res.status(400);
      throw new Error(`Item ${idx + 1}: description is required.`);
    }
    if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty <= 0) {
      res.status(400);
      throw new Error(`Item ${idx + 1}: qty must be a positive integer.`);
    }
    if (
      !Number.isFinite(unitPriceMinor) ||
      !Number.isInteger(unitPriceMinor) ||
      unitPriceMinor < 0
    ) {
      res.status(400);
      throw new Error(
        `Item ${idx + 1}: unitPriceMinor must be a non-negative integer.`
      );
    }

    const lineTotalMinor = qty * unitPriceMinor;

    cleanedItems.push({
      description,
      qty,
      unitPriceMinor,
      lineTotalMinor,
    });
  }

  const amountMinor = cleanedItems.reduce(
    (sum, item) => sum + (Number(item.lineTotalMinor) || 0),
    0
  );

  const manualInvoiceId = quoteId ? new mongoose.Types.ObjectId() : undefined;

  if (quoteId) {
    const linkResult = await Quote.updateOne(
      {
        _id: quoteId,
        manualInvoiceId: null,
        order: null,
        status: { $in: ["Processing", "Quoted"] },
      },
      {
        $set: {
          manualInvoiceId,
          manualInvoiceCreatedAt: new Date(),
        },
      }
    );

    if (!linkResult?.matchedCount) {
      res.status(409);
      throw new Error("Quote is no longer eligible for manual invoicing.");
    }
  }

  let invoice = null;
  try {
    invoice = await Invoice.create({
      ...(manualInvoiceId ? { _id: manualInvoiceId } : {}),
      user: userId,
      source: "Manual",
      order: null,
      invoiceItems: cleanedItems,
      amountMinor,
      minorUnitFactor,
      ...(currency ? { currency } : {}),
      ...(dueDate ? { dueDate } : {}),
      ...(adminNote ? { adminNote } : {}),
    });
  } catch (err) {
    if (quoteId && manualInvoiceId) {
      await Quote.updateOne(
        { _id: quoteId, manualInvoiceId },
        { $set: { manualInvoiceId: null, manualInvoiceCreatedAt: null } }
      );
    }
    throw err;
  }

  res.status(201).json({
    success: true,
    message: "Manual invoice created.",
    data: invoice,
  });
});

/**
 * @desc    Admin: create invoice from an order
 * @route   POST /api/invoices/from-order/:orderId
 * @access  Private/Admin
 *
 * Body (optional):
 * - dueDate
 * - adminNote
 * - currency
 * - minorUnitFactor
 */
export const createInvoiceFromOrder = asyncHandler(async (req, res) => {
  const { orderId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    res.status(400);
    throw new Error("Invalid order id.");
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const order = await Order.findById(orderId)
      .select("user status totalPrice invoice orderItems deliveryCharge extraFee")
      .session(session);

    if (!order) {
      res.status(404);
      throw new Error("Order not found.");
    }

    if (!["Shipping", "Delivered"].includes(order.status)) {
      res.status(400);
      throw new Error(
        "Invoices can only be created for Shipping or Delivered orders."
      );
    }

    if (order.invoice) {
      res.status(400);
      throw new Error("This order already has an invoice.");
    }

    const existing = await Invoice.exists({ order: order._id }).session(session);
    if (existing) {
      res.status(400);
      throw new Error("An invoice already exists for this order.");
    }

    const minorUnitFactor = Object.prototype.hasOwnProperty.call(
      req.body || {},
      "minorUnitFactor"
    )
      ? Number(req.body.minorUnitFactor)
      : 100;

    if (!Number.isInteger(minorUnitFactor) || minorUnitFactor <= 0) {
      res.status(400);
      throw new Error("minorUnitFactor must be a positive integer.");
    }

    const orderItems = Array.isArray(order.orderItems) ? order.orderItems : [];
    const itemsTotal = orderItems.reduce((sum, item) => {
      const qty = Number(item?.qty) || 0;
      const unitPrice = Number(item?.unitPrice) || 0;
      return sum + qty * unitPrice;
    }, 0);
    const deliveryCharge = Number(order.deliveryCharge) || 0;
    const extraFee = Number(order.extraFee) || 0;
    const computedTotal = itemsTotal + deliveryCharge + extraFee;
    const amountMinor = toMinorUnits(computedTotal, minorUnitFactor);
    if (!Number.isFinite(amountMinor) || amountMinor < 0) {
      res.status(400);
      throw new Error("Order total is invalid for invoice creation.");
    }

    const rawDueDate = req.body?.dueDate;
    if (!rawDueDate) {
      res.status(400);
      throw new Error("Due date is required.");
    }
    const dueDate = parseDate(rawDueDate);
    if (!dueDate) {
      res.status(400);
      throw new Error("Invalid due date.");
    }

    const currencyRaw =
      typeof req.body?.currency === "string" ? req.body.currency.trim() : "";
    const currency = currencyRaw ? currencyRaw.toUpperCase() : undefined;
    const adminNote =
      typeof req.body?.adminNote === "string" ? req.body.adminNote.trim() : undefined;

    const [invoice] = await Invoice.create(
      [
        {
          user: order.user,
          order: order._id,
          source: "Order",
          amountMinor,
          minorUnitFactor,
          ...(currency ? { currency } : {}),
          ...(dueDate ? { dueDate } : {}),
          ...(adminNote ? { adminNote } : {}),
        },
      ],
      { session }
    );

    const linkResult = await Order.updateOne(
      { _id: order._id, invoice: null },
      { $set: { invoice: invoice._id } },
      { session }
    );

    if (!linkResult?.matchedCount) {
      res.status(409);
      throw new Error("Order already has an invoice.");
    }

    await session.commitTransaction();

    res.status(201).json({
      success: true,
      message: "Invoice created.",
      data: invoice,
    });
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
});


