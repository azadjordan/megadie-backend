// controllers/paymentController.js
import asyncHandler from "../middleware/asyncHandler.js";
import Payment from "../models/paymentModel.js";
import Invoice from "../models/invoiceModel.js";
import { roundToTwo } from "../utils/rounding.js";

/* =========================
   GET /api/payments?invoice=invoiceId
   Private/Admin (guarded in routes)
   Get all payments for a specific invoice
   ========================= */
export const getPaymentsByInvoice = asyncHandler(async (req, res) => {
  const { invoice } = req.query;
  if (!invoice) {
    res.status(400);
    throw new Error("Invoice ID is required.");
  }

  const payments = await Payment.find({ invoice }).sort({ paymentDate: 1 });
  res.json(payments);
});

/* =========================
   POST /api/payments/from-invoice/:invoiceId
   Private/Admin (guarded in routes)
   Add payment to invoice and validate against remaining balance
   ========================= */
export const addPaymentToInvoice = asyncHandler(async (req, res) => {
  const { amount, paymentMethod, note, paymentDate, paidTo } = req.body || {};
  const { invoiceId } = req.params;

  const invoice = await Invoice.findById(invoiceId).select("user amount");
  if (!invoice) {
    res.status(404);
    throw new Error("Invoice not found.");
  }

  // Sum of already "Received" payments for this invoice
  const received = await Payment.aggregate([
    { $match: { invoice: invoice._id, status: "Received" } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  const totalPaid = roundToTwo(received[0]?.total || 0);
  const remaining = roundToTwo(invoice.amount - totalPaid);

  const roundedAmount = roundToTwo(Number(amount));
  if (!Number.isFinite(roundedAmount) || roundedAmount <= 0) {
    res.status(400);
    throw new Error("Payment amount must be a positive number.");
  }
  if (roundedAmount > remaining) {
    res.status(400);
    throw new Error(
      `Payment amount exceeds remaining balance. Remaining due: ${remaining.toFixed(2)}`
    );
  }
  if (!paidTo || !String(paidTo).trim()) {
    res.status(400);
    throw new Error("The 'paidTo' field is required.");
  }

  const payment = await Payment.create({
    invoice: invoice._id,
    user: invoice.user,
    amount: roundedAmount,
    paymentMethod,
    note,
    paymentDate: paymentDate || Date.now(),
    paidTo: String(paidTo).trim(),
    status: "Received", // <- counted by Invoice virtuals
  });

  // Recompute remaining after this payment
  const newRemaining = roundToTwo(remaining - roundedAmount);

  res.status(201).json({
    message: "✅ Payment recorded.",
    payment,
    invoice: { _id: invoice._id, amount: invoice.amount },
    remainingDue: newRemaining,
    totalPaid: roundToTwo(totalPaid + roundedAmount),
  });
});

/* =========================
   GET /api/payments
   Private/Admin (guarded in routes)
   Get all payments (Admin)
   ========================= */
export const getAllPayments = asyncHandler(async (_req, res) => {
  const payments = await Payment.find({})
    .populate("user", "name email")
    // Note: invoice.status is a virtual that requires payment population; here we only fetch identifiers
    .populate("invoice", "invoiceNumber amount")
    .sort({ createdAt: -1 });

  res.json(payments);
});

/* =========================
   GET /api/payments/:id
   Private/Admin (guarded in routes)
   Get a payment by ID (Admin)
   ========================= */
export const getPaymentById = asyncHandler(async (req, res) => {
  const payment = await Payment.findById(req.params.id)
    .populate("user", "name email")
    .populate("invoice", "invoiceNumber amount");

  if (!payment) {
    res.status(404);
    throw new Error("Payment not found");
  }

  res.json(payment);
});

/* =========================
   GET /api/payments/my
   Private (guarded in routes)
   Get logged-in user's payments
   ========================= */
export const getMyPayments = asyncHandler(async (req, res) => {
  const payments = await Payment.find({ user: req.user._id })
    .populate("invoice", "invoiceNumber amount")
    .sort({ createdAt: -1 });

  res.json(payments);
});

/* =========================
   DELETE /api/payments/:id
   Private/Admin (guarded in routes)
   Delete a payment by ID (Admin)
   ========================= */
export const deletePayment = asyncHandler(async (req, res) => {
  const payment = await Payment.findById(req.params.id);
  if (!payment) {
    res.status(404);
    throw new Error("Payment not found");
  }

  await payment.deleteOne();
  res.status(204).end();
});
