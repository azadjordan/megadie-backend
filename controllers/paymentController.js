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
  const {
    status,
    method,
    user,
    invoiceNumber,
    reference,
    dateFrom,
    dateTo,
    min,
    max,
  } = req.query || {};

  const q = {};
  if (status) q.status = status;                 // e.g. "Received"
  if (method) q.paymentMethod = method;          // e.g. "Cash" | "Bank Transfer"
  if (user) q.user = new mongoose.Types.ObjectId(user);
  if (reference) q.reference = { $regex: reference, $options: "i" };

  if (invoiceNumber) q.invoice = q.invoice || { $in: [] }; // resolved later

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
   Record a payment (strict: no overpay)
   ========================= */
export const addPaymentToInvoice = asyncHandler(async (req, res) => {
  const { amount, paymentMethod, note, paymentDate, paidTo, reference } = req.body || {};
  const { invoiceId } = req.params;

  const amt = roundToTwo(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) {
    res.status(400);
    throw new Error("Payment amount must be a positive number.");
  }
  if (!paymentMethod) {
    res.status(400);
    throw new Error("Payment method is required.");
  }
  if (!paidTo || !String(paidTo).trim()) {
    res.status(400);
    throw new Error("The 'paidTo' field is required.");
  }

  const session = await mongoose.startSession();
  try {
    let created;
    let invDoc;
    let newTotalPaid = 0;
    let newRemaining = 0;

    await session.withTransaction(async () => {
      const inv = await Invoice.findById(invoiceId).select("user amount").session(session);
      if (!inv) {
        res.status(404);
        throw new Error("Invoice not found.");
      }

      const paidAgg = await Payment.aggregate([
        { $match: { invoice: inv._id, status: "Received" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]).session(session);

      const totalPaid = roundToTwo(paidAgg?.[0]?.total || 0);
      const remaining = roundToTwo(inv.amount - totalPaid);

      if (amt > remaining) {
        res.status(400);
        throw new Error(`Payment exceeds remaining balance. Remaining due: ${remaining.toFixed(2)}`);
      }

      const [payment] = await Payment.create(
        [
          {
            invoice: inv._id,
            user: inv.user,
            amount: amt,
            paymentMethod,
            note,
            paymentDate: paymentDate || Date.now(),
            paidTo: String(paidTo).trim(),
            reference: reference?.toString().trim(),
            status: "Received",
          },
        ],
        { session }
      );

      invDoc = inv;
      created = payment;
      newTotalPaid = roundToTwo(totalPaid + amt);
      newRemaining = roundToTwo(inv.amount - newTotalPaid);
    });

    // Location header for the new resource
    res.setHeader("Location", `/api/payments/${created._id}`);

    res.status(201).json({
      success: true,
      message: "Payment recorded successfully.",
      data: created,
      invoice: { _id: invDoc._id, amount: invDoc.amount },
      totals: { totalPaid: newTotalPaid, remainingDue: newRemaining },
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
  if (!payment) {
    res.status(404);
    throw new Error("Payment not found.");
  }

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

  const changedKeys = Object.keys(changes);
  const message = changedKeys.length
    ? `Payment updated successfully (${changedKeys.join(", ")}).`
    : "Payment saved (no changes detected).";

  res.status(200).json({
    success: true,
    message,
    changed: changes,
    data: updated,
  });
});

/* =========================
   DELETE /api/payments/:id
   Private/Admin
   Hard delete + return invoice context & new totals
   ========================= */
export const deletePayment = asyncHandler(async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let snapshot, invId, invNumber = null, newTotalPaid = 0, newRemaining = 0;

    await session.withTransaction(async () => {
      // 1) Find the payment with minimal fields + invoice reference
      const payment = await Payment.findById(req.params.id)
        .select("_id amount paymentMethod reference invoice user status")
        .session(session);

      if (!payment) {
        res.status(404);
        throw new Error("Payment not found.");
      }

      // 2) Keep a snapshot for response
      snapshot = {
        paymentId: payment._id,
        amount: payment.amount,
        paymentMethod: payment.paymentMethod,
        reference: payment.reference ?? null,
        user: payment.user ?? null,
      };

      // 3) Resolve invoice context (optional but useful for UI)
      invId = payment.invoice || null;

      // Try to fetch invoice basic data for response & totals math
      let invDoc = null;
      if (invId) {
        invDoc = await Invoice.findById(invId)
          .select("_id amount invoiceNumber")
          .session(session);

        if (invDoc) {
          invNumber = invDoc.invoiceNumber ?? null;
        }
      }

      // 4) Delete the payment
      await payment.deleteOne({ session });

      // 5) If there is an invoice, recalc totals after deletion
      if (invId && invDoc) {
        // Sum only "Received" payments (same rule used on creation)
        const paidAgg = await Payment.aggregate([
          { $match: { invoice: invDoc._id, status: "Received" } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]).session(session);

        newTotalPaid = roundToTwo(paidAgg?.[0]?.total || 0);
        newRemaining = roundToTwo(invDoc.amount - newTotalPaid);
      }
    });

    const message = invId
      ? "Payment deleted and invoice totals recalculated."
      : "Payment deleted.";

    res.status(200).json({
      success: true,
      message,
      ...snapshot,
      invoice: invId
        ? { _id: invId, invoiceNumber: invNumber }
        : null,
      totals: invId
        ? { totalPaid: newTotalPaid, remainingDue: newRemaining }
        : null,
    });
  } finally {
    session.endSession();
  }
});

/* =========================
   GET /api/payments/by-invoice?invoice=:invoiceId
   Private/Admin
   ========================= */
export const getPaymentsByInvoice = asyncHandler(async (req, res) => {
  const { invoice } = req.query;
  if (!invoice) {
    res.status(400);
    throw new Error("Invoice ID is required.");
  }
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
   Query: status, method, user, invoiceNumber, reference, dateFrom, dateTo, min, max
   ========================= */
export const getAllPayments = asyncHandler(async (req, res) => {
  const { limit, skip, page } = parsePagination(req);
  const filters = parseFilters(req);

  // Resolve invoiceNumber to ObjectIds if provided
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
  if (!payment) {
    res.status(404);
    throw new Error("Payment not found.");
  }
  res.status(200).json({
    success: true,
    message: "Payment retrieved successfully.",
    data: payment,
  });
});
