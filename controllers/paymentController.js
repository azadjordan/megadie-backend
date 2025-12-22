// megadie-backend/controllers/paymentController.js
import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import Payment from "../models/paymentModel.js";
import Invoice from "../models/invoiceModel.js";
import User from "../models/userModel.js";

/* -----------------------
   Helpers
------------------------ */
function toInt(v, fallback) {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function escapeRegex(text = "") {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toMinorUnits(majorAmount, factor = 100) {
  const n = Number(majorAmount);
  const f = Number(factor);
  if (!Number.isFinite(n)) return NaN;
  if (!Number.isFinite(f) || f <= 0) return Math.round(n * 100);
  return Math.round(n * f);
}

const SORT_MAP = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  amountHigh: { amountMinor: -1, createdAt: -1 },
  amountLow: { amountMinor: 1, createdAt: -1 },
};

/**
 * @desc    Admin: add payment to an invoice
 * @route   POST /api/payments/from-invoice/:invoiceId
 * @access  Private/Admin
 */
export const addPaymentToInvoice = asyncHandler(async (req, res) => {
  const { invoiceId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(invoiceId)) {
    res.status(400);
    throw new Error("Invalid invoice id.");
  }

  const { amount, paymentMethod, receivedBy, paymentDate, note, reference } =
    req.body || {};

  if (!paymentMethod) {
    res.status(400);
    throw new Error("Payment method is required.");
  }

  if (!receivedBy || !String(receivedBy).trim()) {
    res.status(400);
    throw new Error("Received by is required.");
  }

  const majorAmount = Number(amount);
  if (!Number.isFinite(majorAmount) || majorAmount <= 0) {
    res.status(400);
    throw new Error("Payment amount must be a positive number.");
  }

  const invoice = await Invoice.findById(invoiceId)
    .select("user status minorUnitFactor paymentStatus balanceDueMinor")
    .lean();

  if (!invoice) {
    res.status(404);
    throw new Error("Invoice not found.");
  }

  if (invoice.status !== "Issued") {
    res.status(400);
    throw new Error("Payments can only be added to Issued invoices.");
  }

  if (
    invoice.paymentStatus === "Paid" ||
    (typeof invoice.balanceDueMinor === "number" && invoice.balanceDueMinor <= 0)
  ) {
    res.status(400);
    throw new Error("Invoice is already paid.");
  }

  let parsedPaymentDate;
  if (paymentDate) {
    const d = new Date(paymentDate);
    if (Number.isNaN(d.getTime())) {
      res.status(400);
      throw new Error("Invalid payment date.");
    }
    parsedPaymentDate = d;
  }

  const amountMinor = toMinorUnits(majorAmount, invoice.minorUnitFactor || 100);
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    res.status(400);
    throw new Error("Payment amount is invalid.");
  }

  const payment = await Payment.create({
    invoice: invoiceId,
    user: invoice.user,
    amountMinor,
    paymentMethod,
    receivedBy: String(receivedBy).trim(),
    paymentDate: parsedPaymentDate,
    note: typeof note === "string" ? note.trim() : note,
    reference: typeof reference === "string" ? reference.trim() : reference,
  });

  res.status(201).json({
    success: true,
    message: "Payment recorded successfully.",
    data: payment,
  });
});

/**
 * @desc    Admin: list payments (filters + pagination)
 * @route   GET /api/payments
 * @access  Private/Admin
 *
 * Query params (optional):
 * - page, limit
 * - search=<string> (invoiceNumber/user name/email/reference/receivedBy, case-insensitive)
 * - method=Cash|Bank Transfer|Credit Card|Cheque|Other
 * - sort=newest|oldest|amountHigh|amountLow (newest/oldest use createdAt)
 */
export const getPaymentsAdmin = asyncHandler(async (req, res) => {
  const page = Math.max(1, toInt(req.query.page, 1));
  const limitRaw = toInt(req.query.limit, 5);
  const limit = Math.min(Math.max(1, limitRaw), 5);
  const skip = (page - 1) * limit;

  const method = req.query.method ? String(req.query.method) : null;
  const sortKey = req.query.sort ? String(req.query.sort) : "newest";
  const sort = SORT_MAP[sortKey] || SORT_MAP.newest;

  const search = req.query.search ? String(req.query.search).trim() : "";

  const filter = {};
  if (method && method !== "all") filter.paymentMethod = method;

  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");

    const [invoices, users] = await Promise.all([
      Invoice.find({ invoiceNumber: regex }).select("_id").limit(200).lean(),
      User.find({ $or: [{ name: regex }, { email: regex }] })
        .select("_id")
        .limit(200)
        .lean(),
    ]);

    const invoiceIds = invoices.map((inv) => inv._id);
    const userIds = users.map((u) => u._id);

    filter.$or = [
      { reference: regex },
      { receivedBy: regex },
      { note: regex },
      ...(invoiceIds.length ? [{ invoice: { $in: invoiceIds } }] : []),
      ...(userIds.length ? [{ user: { $in: userIds } }] : []),
    ];
  }

  const [total, items] = await Promise.all([
    Payment.countDocuments(filter),
    Payment.find(filter)
      .select(
        [
          "invoice",
          "user",
          "amountMinor",
          "paymentMethod",
          "paymentDate",
          "note",
          "reference",
          "receivedBy",
          "createdAt",
        ].join(" ")
      )
      .populate({
        path: "invoice",
        select: "invoiceNumber currency minorUnitFactor",
      })
      .populate({
        path: "user",
        select: "name email",
      })
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  res.json({
    success: true,
    message: "Payments retrieved successfully.",
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
