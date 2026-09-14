// megadie-backend/controllers/paymentController.js
import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import Payment, {
  PAYMENT_METHOD_OPTIONS,
  RECEIVED_BY_OPTIONS,
} from "../models/paymentModel.js";
import CustomerPaymentReceipt from "../models/customerPaymentReceiptModel.js";
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
  newest: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
  createdNewest: { createdAt: -1, _id: -1 },
  createdOldest: { createdAt: 1, _id: 1 },
  paymentNewest: { paymentDate: -1, createdAt: -1, _id: -1 },
  paymentOldest: { paymentDate: 1, createdAt: 1, _id: 1 },
  amountHigh: { amountMinor: -1, createdAt: -1, _id: -1 },
  amountLow: { amountMinor: 1, createdAt: -1, _id: -1 },
};

const PAYMENT_METHODS_ALLOWED = new Set(
  Payment.schema.path("paymentMethod")?.enumValues || PAYMENT_METHOD_OPTIONS
);

function getTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getApprovalStatus(user) {
  return user?.approvalStatus || "Approved";
}

function validatePaymentMethod(res, paymentMethod) {
  if (!paymentMethod) {
    res.status(400);
    throw new Error("Payment method is required.");
  }
  if (!PAYMENT_METHODS_ALLOWED.has(paymentMethod)) {
    res.status(400);
    throw new Error(
      `Invalid payment method. Allowed: ${Array.from(PAYMENT_METHODS_ALLOWED).join(
        ", "
      )}.`
    );
  }
}

function validateReceivedBy(res, receivedBy) {
  const receivedByTrimmed = getTrimmedString(receivedBy);
  if (!receivedByTrimmed) {
    res.status(400);
    throw new Error("Received by is required.");
  }
  if (!RECEIVED_BY_OPTIONS.includes(receivedByTrimmed)) {
    res.status(400);
    throw new Error(
      `Invalid receivedBy. Allowed: ${RECEIVED_BY_OPTIONS.join(", ")}.`
    );
  }
  return receivedByTrimmed;
}

function parsePaymentDate(res, paymentDate) {
  if (!paymentDate) return undefined;
  const d = new Date(paymentDate);
  if (Number.isNaN(d.getTime())) {
    res.status(400);
    throw new Error("Invalid payment date.");
  }
  return d;
}

function validateCustomerForPayment(res, user) {
  if (!user) {
    res.status(404);
    throw new Error("Customer not found.");
  }
  if (user.isAdmin) {
    res.status(400);
    throw new Error("Payments can only be recorded for customer accounts.");
  }
  if (getApprovalStatus(user) !== "Approved") {
    res.status(400);
    throw new Error("Payments can only be recorded for approved customers.");
  }
}

function hasAmountValue(amount) {
  return amount !== undefined && amount !== null && String(amount).trim() !== "";
}

function getInvoiceBalanceMinor(invoice) {
  if (typeof invoice?.balanceDueMinor === "number") {
    return Math.max(0, invoice.balanceDueMinor);
  }
  return Math.max(
    0,
    (Number(invoice?.amountMinor) || 0) - (Number(invoice?.paidTotalMinor) || 0)
  );
}

function getInvoiceCurrencyMeta(res, invoices) {
  if (!invoices.length) {
    return { currency: "AED", minorUnitFactor: 100 };
  }

  const firstCurrency = invoices[0]?.currency || "AED";
  const firstFactor = invoices[0]?.minorUnitFactor || 100;
  const hasMixedCurrency = invoices.some(
    (invoice) =>
      (invoice?.currency || "AED") !== firstCurrency ||
      (invoice?.minorUnitFactor || 100) !== firstFactor
  );

  if (hasMixedCurrency) {
    res.status(400);
    throw new Error("Cannot allocate one payment across multiple currencies.");
  }

  return { currency: firstCurrency, minorUnitFactor: firstFactor };
}

function buildCustomerPaymentPreview(invoices, amountMinor = 0) {
  let remaining = Math.max(0, Number(amountMinor) || 0);
  let appliedTotalMinor = 0;
  let unpaidTotalMinor = 0;

  const allocations = invoices.map((invoice) => {
    const balanceDueMinor = getInvoiceBalanceMinor(invoice);
    unpaidTotalMinor += balanceDueMinor;
    const appliedMinor = remaining > 0 ? Math.min(balanceDueMinor, remaining) : 0;
    remaining -= appliedMinor;
    appliedTotalMinor += appliedMinor;

    return {
      invoice: invoice._id,
      invoiceNumber: invoice.invoiceNumber || "",
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      amountMinor: invoice.amountMinor || 0,
      paidTotalMinor: invoice.paidTotalMinor || 0,
      balanceDueMinor,
      paymentStatus: invoice.paymentStatus || "Unpaid",
      appliedMinor,
      balanceAfterMinor: Math.max(0, balanceDueMinor - appliedMinor),
    };
  });

  return {
    allocations,
    appliedTotalMinor,
    unpaidTotalMinor,
    remainingUnallocatedMinor: remaining,
    balanceAfterPaymentMinor: Math.max(0, unpaidTotalMinor - appliedTotalMinor),
  };
}

async function findPaymentCustomer(res, userId, session = null) {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    res.status(400);
    throw new Error("Invalid customer id.");
  }

  const query = User.findById(userId).select("name email isAdmin approvalStatus");
  if (session) query.session(session);
  const user = await query.lean();
  validateCustomerForPayment(res, user);
  return user;
}

async function findCustomerUnpaidInvoices(userId, session = null) {
  const query = Invoice.find({
    user: new mongoose.Types.ObjectId(userId),
    status: "Issued",
    paymentStatus: { $ne: "Paid" },
    balanceDueMinor: { $gt: 0 },
  })
    .select(
      [
        "invoiceNumber",
        "amountMinor",
        "currency",
        "minorUnitFactor",
        "paidTotalMinor",
        "balanceDueMinor",
        "paymentStatus",
        "invoiceDate",
        "dueDate",
        "createdAt",
        "user",
      ].join(" ")
    )
    .sort({ dueDate: 1, invoiceDate: 1, createdAt: 1, _id: 1 });

  if (session) query.session(session);
  return query.lean();
}

/**
 * @desc    Admin: preview customer payment allocation
 * @route   POST /api/payments/customer/:userId/preview
 * @access  Private/Admin
 */
export const previewCustomerPaymentAllocation = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const customer = await findPaymentCustomer(res, userId);
  const invoices = await findCustomerUnpaidInvoices(userId);
  const { currency, minorUnitFactor } = getInvoiceCurrencyMeta(res, invoices);

  let amountMinor = 0;
  let amountError = "";
  if (hasAmountValue(req.body?.amount)) {
    const majorAmount = Number(req.body.amount);
    if (!Number.isFinite(majorAmount) || majorAmount <= 0) {
      amountError = "Enter a positive payment amount.";
    } else {
      amountMinor = toMinorUnits(majorAmount, minorUnitFactor);
      if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
        amountError = "Payment amount is invalid.";
        amountMinor = 0;
      }
    }
  }

  const basePreview = buildCustomerPaymentPreview(invoices, 0);
  if (amountMinor > basePreview.unpaidTotalMinor) {
    amountError = "Payment amount cannot exceed the customer's unpaid balance.";
  }

  const preview = buildCustomerPaymentPreview(
    invoices,
    amountError ? 0 : amountMinor
  );

  res.json({
    success: true,
    data: {
      customer,
      currency,
      minorUnitFactor,
      amountMinor,
      amountError,
      canAllocate:
        amountMinor > 0 &&
        !amountError &&
        preview.appliedTotalMinor === amountMinor,
      unpaidTotalMinor: basePreview.unpaidTotalMinor,
      unpaidInvoiceCount: invoices.length,
      appliedTotalMinor: preview.appliedTotalMinor,
      remainingUnallocatedMinor: preview.remainingUnallocatedMinor,
      balanceAfterPaymentMinor: amountError
        ? basePreview.unpaidTotalMinor
        : preview.balanceAfterPaymentMinor,
      allocations: preview.allocations,
    },
  });
});

/**
 * @desc    Admin: receive one customer payment and allocate it oldest-first
 * @route   POST /api/payments/customer/:userId/allocate
 * @access  Private/Admin
 */
export const allocateCustomerPayment = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    res.status(400);
    throw new Error("Invalid customer id.");
  }

  const { amount, paymentMethod, receivedBy, paymentDate, note, reference } =
    req.body || {};

  validatePaymentMethod(res, paymentMethod);
  const receivedByTrimmed = validateReceivedBy(res, receivedBy);

  const majorAmount = Number(amount);
  if (!Number.isFinite(majorAmount) || majorAmount <= 0) {
    res.status(400);
    throw new Error("Payment amount must be a positive number.");
  }

  const parsedPaymentDate = parsePaymentDate(res, paymentDate);
  const session = await mongoose.startSession();
  let payload = null;

  try {
    await session.withTransaction(async () => {
      const customer = await findPaymentCustomer(res, userId, session);
      const invoices = await findCustomerUnpaidInvoices(userId, session);
      if (!invoices.length) {
        res.status(400);
        throw new Error("Customer has no unpaid issued invoices.");
      }

      const { currency, minorUnitFactor } = getInvoiceCurrencyMeta(res, invoices);
      const amountMinor = toMinorUnits(majorAmount, minorUnitFactor);
      if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
        res.status(400);
        throw new Error("Payment amount is invalid.");
      }

      const basePreview = buildCustomerPaymentPreview(invoices, 0);
      if (amountMinor > basePreview.unpaidTotalMinor) {
        res.status(400);
        throw new Error(
          "Payment amount cannot exceed the customer's unpaid balance."
        );
      }

      const preview = buildCustomerPaymentPreview(invoices, amountMinor);
      const allocations = preview.allocations.filter(
        (allocation) => allocation.appliedMinor > 0
      );
      if (!allocations.length || preview.appliedTotalMinor !== amountMinor) {
        res.status(400);
        throw new Error("Payment could not be fully allocated.");
      }

      const [receipt] = await CustomerPaymentReceipt.create(
        [
          {
            user: customer._id,
            amountMinor,
            allocatedTotalMinor: preview.appliedTotalMinor,
            currency,
            minorUnitFactor,
            paymentMethod,
            receivedBy: receivedByTrimmed,
            paymentDate: parsedPaymentDate,
            reference: getTrimmedString(reference) || undefined,
            note: getTrimmedString(note) || undefined,
            allocations: allocations.map((allocation) => ({
              invoice: allocation.invoice,
              invoiceNumber: allocation.invoiceNumber,
              amountMinor: allocation.appliedMinor,
              invoiceBalanceBeforeMinor: allocation.balanceDueMinor,
              invoiceBalanceAfterMinor: allocation.balanceAfterMinor,
            })),
          },
        ],
        { session, ordered: true }
      );

      const payments = await Payment.create(
        allocations.map((allocation) => ({
          invoice: allocation.invoice,
          user: customer._id,
          receipt: receipt._id,
          amountMinor: allocation.appliedMinor,
          paymentMethod,
          receivedBy: receivedByTrimmed,
          paymentDate: parsedPaymentDate,
          reference: getTrimmedString(reference) || undefined,
          note: getTrimmedString(note) || undefined,
        })),
        { session, ordered: true }
      );

      payload = {
        receipt,
        payments,
        customer,
        currency,
        minorUnitFactor,
        unpaidTotalBeforeMinor: basePreview.unpaidTotalMinor,
        paymentAmountMinor: amountMinor,
        balanceAfterPaymentMinor: preview.balanceAfterPaymentMinor,
        allocations,
      };
    });
  } finally {
    session.endSession();
  }

  res.status(201).json({
    success: true,
    message: "Customer payment recorded and allocated successfully.",
    data: payload,
  });
});

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

  validatePaymentMethod(res, paymentMethod);

  const receivedByTrimmed = validateReceivedBy(res, receivedBy);

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

  const parsedPaymentDate = parsePaymentDate(res, paymentDate);

  const amountMinor = toMinorUnits(majorAmount, invoice.minorUnitFactor || 100);
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    res.status(400);
    throw new Error("Payment amount is invalid.");
  }
  if (
    typeof invoice.balanceDueMinor === "number" &&
    amountMinor > invoice.balanceDueMinor
  ) {
    res.status(400);
    throw new Error("Payment amount cannot exceed the invoice balance.");
  }

  const payment = await Payment.create({
    invoice: invoiceId,
    user: invoice.user,
    amountMinor,
    paymentMethod,
    receivedBy: receivedByTrimmed,
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
 * - page, limit (max 100)
 * - search=<string> (invoiceNumber/user name/email/reference/receivedBy, case-insensitive)
 * - method=Cash|Bank Transfer|Credit Card|Cheque|Other
 * - user=<userId> (filter by client)
 * - sort=createdNewest|createdOldest|paymentNewest|paymentOldest|amountHigh|amountLow
 *   (newest/oldest remain as createdAt aliases)
 */
export const getPaymentsAdmin = asyncHandler(async (req, res) => {
  const page = Math.max(1, toInt(req.query.page, 1));
  const limitRaw = toInt(req.query.limit, 20);
  const limit = Math.min(Math.max(1, limitRaw), 100);
  const skip = (page - 1) * limit;

  const method = req.query.method ? String(req.query.method) : null;
  const sortKey = req.query.sort ? String(req.query.sort) : "createdNewest";
  const sort = SORT_MAP[sortKey] || SORT_MAP.newest;

  const search = req.query.search ? String(req.query.search).trim() : "";
  const user = req.query.user ? String(req.query.user) : null;

  const filter = {};
  if (method && method !== "all") {
    if (!PAYMENT_METHODS_ALLOWED.has(method)) {
      res.status(400);
      throw new Error(
        `Invalid payment method. Allowed: ${Array.from(PAYMENT_METHODS_ALLOWED).join(
          ", "
        )}.`
      );
    }
    filter.paymentMethod = method;
  }

  if (user) {
    if (!mongoose.Types.ObjectId.isValid(user)) {
      res.status(400);
      throw new Error("Invalid user filter.");
    }
    filter.user = new mongoose.Types.ObjectId(user);
  }

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
          "receipt",
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
        path: "receipt",
        select: "amountMinor currency minorUnitFactor paymentDate reference",
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

/**
 * @desc    Admin: delete a payment
 * @route   DELETE /api/payments/:id
 * @access  Private/Admin
 */
export const deletePayment = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error("Invalid payment id.");
  }

  const payment = await Payment.findById(id).select(
    "_id invoice amountMinor receipt"
  );
  if (!payment) {
    res.status(404);
    throw new Error("Payment not found.");
  }

  if (payment.receipt) {
    res.status(400);
    throw new Error(
      "Payments recorded through a customer receipt cannot be deleted individually."
    );
  }

  await payment.deleteOne();

  res.json({
    message: "Payment deleted and invoice balance updated.",
    paymentId: payment._id,
    invoiceId: payment.invoice,
  });
});
