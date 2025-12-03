// controllers/paymentController.js
import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import Payment from "../models/paymentModel.js";
import Invoice from "../models/invoiceModel.js";
import { roundToTwo } from "../utils/rounding.js";

/* =========================
   Helpers (pagination + filters)
   ========================= */
const parsePagination = (req, { defaultLimit = 20, maxLimit = 100 } = {}) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || defaultLimit, 1), maxLimit);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

const parseFilters = (req) => {
  const { status, method, user, invoiceNumber, reference, dateFrom, dateTo, min, max } = req.query || {};

  const q = {};
  if (status) q.status = status;
  if (method) q.paymentMethod = method;
  if (user) q.user = new mongoose.Types.ObjectId(user);
  if (reference) q.reference = { $regex: reference, $options: "i" };

  // invoiceNumber handled separately later
  if (invoiceNumber) q.invoice = q.invoice || { $in: [] };

  if (dateFrom || dateTo) {
    q.paymentDate = {};
    if (dateFrom) q.paymentDate.$gte = new Date(dateFrom);
    if (dateTo) q.paymentDate.$lte = new Date(dateTo);
  }

  if (min || max) {
    q.amount = {};
    if (min) q.amount.$gte = Number(min);
    if (max) q.amount.$lte = Number(max);
  }

  return q;
};

/* =========================
   POST /api/payments/from-invoice/:invoiceId
   Private/Admin
   Create a payment (no totals returned — invoice computes them later)
   ========================= */
export const addPaymentToInvoice = asyncHandler(async (req, res) => {
  const { amount, paymentMethod, note, paymentDate, paidTo, reference } = req.body || {};
  const { invoiceId } = req.params;

  const amt = roundToTwo(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) throw new Error("Payment amount must be a positive number.");
  if (!paymentMethod) throw new Error("Payment method is required.");
  if (!paidTo || !String(paidTo).trim()) throw new Error("'paidTo' field is required.");

  const session = await mongoose.startSession();

  try {
    let createdPayment;

    await session.withTransaction(async () => {
      const inv = await Invoice.findById(invoiceId).select("user amount").session(session);
      if (!inv) throw new Error("Invoice not found.");

      // Ensure we don't exceed the invoice amount
      const paidAgg = await Payment.aggregate([
        { $match: { invoice: inv._id, status: "Received" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]).session(session);

      const alreadyPaid = roundToTwo(paidAgg?.[0]?.total || 0);
      const remaining = roundToTwo(inv.amount - alreadyPaid);

      if (amt > remaining) {
        throw new Error(`Payment exceeds remaining balance. Remaining due: ${remaining.toFixed(2)}`);
      }

      const [payment] = await Payment.create(
        [{
          invoice: inv._id,
          user: inv.user,
          amount: amt,
          paymentMethod,
          note,
          paymentDate: paymentDate || Date.now(),
          paidTo: String(paidTo).trim(),
          reference: reference?.toString().trim(),
          status: "Received",
        }],
        { session }
      );

      createdPayment = payment;
    });

    res.status(201).json({
      success: true,
      message: "Payment recorded successfully.",
      data: createdPayment,
    });

  } finally {
    session.endSession();
  }
});

/* =========================
   PATCH /api/payments/:id
   Private/Admin
   Edit non-financial fields only
   ========================= */
export const updatePaymentMeta = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { paymentDate, note, reference, paidTo, paymentMethod } = req.body || {};

  const payment = await Payment.findById(id);
  if (!payment) throw new Error("Payment not found.");

  const changes = {};

  if (typeof paymentDate !== "undefined") {
    const newDate = new Date(paymentDate);
    if (!payment.paymentDate || +payment.paymentDate !== +newDate) {
      changes.paymentDate = { from: payment.paymentDate ?? null, to: newDate ?? null };
      payment.paymentDate = newDate;
    }
  }
  if (typeof note !== "undefined" && note !== payment.note) {
    changes.note = { from: payment.note ?? null, to: String(note) };
    payment.note = String(note);
  }
  if (typeof reference !== "undefined" && reference !== payment.reference) {
    changes.reference = { from: payment.reference ?? null, to: String(reference) };
    payment.reference = String(reference);
  }
  if (typeof paidTo !== "undefined" && paidTo !== payment.paidTo) {
    changes.paidTo = { from: payment.paidTo ?? null, to: String(paidTo) };
    payment.paidTo = String(paidTo);
  }
  if (typeof paymentMethod !== "undefined" && paymentMethod !== payment.paymentMethod) {
    changes.paymentMethod = { from: payment.paymentMethod ?? null, to: String(paymentMethod) };
    payment.paymentMethod = String(paymentMethod);
  }

  const updated = await payment.save();

  res.status(200).json({
    success: true,
    message: Object.keys(changes).length
      ? `Payment updated successfully (${Object.keys(changes).join(", ")}).`
      : "Payment saved (no changes detected).",
    changed: changes,
    data: updated,
  });
});

/* =========================
   DELETE /api/payments/:id
   Private/Admin
   Delete payment (no invoice recalculation needed)
   ========================= */
export const deletePayment = asyncHandler(async (req, res) => {
  const payment = await Payment.findById(req.params.id)
    .select("_id amount paymentMethod reference invoice user");

  if (!payment) throw new Error("Payment not found.");

  const snapshot = {
    paymentId: payment._id,
    amount: payment.amount,
    paymentMethod: payment.paymentMethod,
    reference: payment.reference ?? null,
    invoice: payment.invoice,
    user: payment.user,
  };

  await payment.deleteOne();

  res.status(200).json({
    success: true,
    message: "Payment deleted successfully.",
    ...snapshot,
  });
});

/* =========================
   GET /api/payments/by-invoice?invoice=:invoiceId
   Private/Admin
   ========================= */
export const getPaymentsByInvoice = asyncHandler(async (req, res) => {
  const { invoice } = req.query;

  if (!invoice) throw new Error("Invoice ID is required.");

  const payments = await Payment.find({ invoice })
    .populate("user", "name email")
    .sort({ paymentDate: 1 });

  res.status(200).json({
    success: true,
    message: "Payments retrieved successfully.",
    data: payments,
    invoiceId: invoice,
  });
});

/* =========================
   GET /api/payments/my
   Private (owner)
   ========================= */
export const getMyPayments = asyncHandler(async (req, res) => {
  const { limit, skip, page } = parsePagination(req);

  const [items, total] = await Promise.all([
    Payment.find({ user: req.user._id })
      .populate("invoice", "invoiceNumber amount")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Payment.countDocuments({ user: req.user._id }),
  ]);

  res.status(200).json({
    success: true,
    message: "Your payments retrieved successfully.",
    page,
    total,
    data: items,
  });
});

/* =========================
   GET /api/payments
   Private/Admin
   All payments with filters + pagination
   ========================= */
export const getAllPayments = asyncHandler(async (req, res) => {
  const { limit, skip, page } = parsePagination(req);
  const filters = parseFilters(req);

  // Resolve invoiceNumber → invoice _id[]
  if (filters.invoice && "$in" in filters.invoice) {
    const invs = await Invoice.find(
      { invoiceNumber: { $regex: req.query.invoiceNumber, $options: "i" } },
      { _id: 1 }
    );
    filters.invoice.$in = invs.map((i) => i._id);
    if (filters.invoice.$in.length === 0) {
      return res.status(200).json({
        success: true,
        message: "Payments retrieved successfully.",
        page,
        total: 0,
        data: [],
      });
    }
  }

  const [items, total] = await Promise.all([
    Payment.find(filters)
      .populate("user", "name email")
      .populate("invoice", "invoiceNumber amount")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Payment.countDocuments(filters),
  ]);

  res.status(200).json({
    success: true,
    message: "Payments retrieved successfully.",
    page,
    total,
    data: items,
  });
});

/* =========================
   GET /api/payments/:id
   Private/Admin
   ========================= */
export const getPaymentById = asyncHandler(async (req, res) => {
  const payment = await Payment.findById(req.params.id)
    .populate("user", "name email")
    .populate("invoice", "invoiceNumber amount");

  if (!payment) throw new Error("Payment not found.");

  res.status(200).json({
    success: true,
    message: "Payment retrieved successfully.",
    data: payment,
  });
});
