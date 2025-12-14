// controllers/invoiceController.js
import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import Invoice from "../models/invoiceModel.js";
import Payment from "../models/paymentModel.js";
import Order from "../models/orderModel.js";
import InvoicePDF from "../utils/InvoicePDF.js";
import { renderToStream } from "@react-pdf/renderer";
import { createElement } from "react";
import { roundToTwo } from "../utils/rounding.js";

/* =========================
   Helpers (filters + pagination)
   ========================= */
const parsePagination = (req, { defaultLimit = 20, maxLimit = 100 } = {}) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || defaultLimit, 1), maxLimit);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

const buildInvoiceMatch = (req) => {
  const {
    invoiceNumber, // partial ok
    user,          // userId
    createdFrom,
    createdTo,
    dueFrom,
    dueTo,
    status,        // Paid | Unpaid | Partially Paid | Overdue
    outstanding,   // 'true' -> balanceDue > 0 (applied after compute)
  } = req.query || {};

  const match = {};
  if (invoiceNumber) match.invoiceNumber = { $regex: invoiceNumber, $options: "i" };
  if (user) match.user = new mongoose.Types.ObjectId(user);

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

  return { match, status, outstanding: outstanding === "true" };
};

/* =========================
   GET /api/invoices/:id/pdf
   Private/Admin
   Generate PDF for invoice with correct totals/status
   ========================= */
export const getInvoicePDF = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id)
    .populate("user", "name email")
    .populate({
      path: "order",
      // include charges + items so PDF can break down totals
      select:
        "orderNumber totalPrice status orderItems deliveredAt deliveryCharge extraFee",
      populate: { path: "orderItems.product", select: "name" },
    })
    .populate("payments"); // full payments; we'll filter in code

  if (!invoice) {
    res.status(404);
    throw new Error("Invoice not found.");
  }

  // --- Compute totalPaid, balanceDue, and derived status ---
  const paymentsArray = Array.isArray(invoice.payments)
    ? invoice.payments
    : [];

  // Match getInvoices: only status === "Received" counts as paid
  const totalPaid = paymentsArray
    .filter((p) => p && p.status === "Received")
    .reduce((sum, p) => sum + (p.amount || 0), 0);

  const amount = typeof invoice.amount === "number" ? invoice.amount : 0;
  const balanceDue = Math.max(amount - totalPaid, 0);

  const now = new Date();
  let computedStatus = "Unpaid";

  if (totalPaid >= amount && amount > 0) {
    computedStatus = "Paid";
  } else if (
    invoice.dueDate &&
    now > invoice.dueDate &&
    totalPaid < amount
  ) {
    computedStatus = totalPaid > 0 ? "Overdue" : "Overdue";
  } else if (totalPaid > 0 && totalPaid < amount) {
    computedStatus = "Partially Paid";
  } else {
    computedStatus = "Unpaid";
  }

  // Attach computed values to the document so InvoicePDF can use them
  // (they don't need to exist in the schema, we just pass them through)
  invoice.totalPaid = totalPaid;
  invoice.balanceDue = balanceDue;
  invoice.status = computedStatus;

  // --- PDF response headers ---
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename=invoice-${invoice.invoiceNumber || invoice._id}.pdf`
  );

  // You can optionally pass a company object if you want branding tweaks
  const company = {
    name: "Megadie",
    short: "Megadie",
    display: "Megadie.com",
    sub: "",
    footer: "Read T&C at www.megadie.com",
  };

  const pdfStream = await renderToStream(
    createElement(InvoicePDF, { invoice, order: invoice.order, company })
  );

  pdfStream.pipe(res);
});

/* =========================
   GET /api/invoices
   Private/Admin
   Admin list with filters + pagination + computed totals (no heavy populate)
   ========================= */
export const getInvoices = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req);
  const { match, status, outstanding } = buildInvoiceMatch(req);
  const now = new Date();

  const facet = await Invoice.aggregate([
    { $match: match },

    // join user minimal info
    {
      $lookup: {
        from: "users",
        localField: "user",
        foreignField: "_id",
        as: "userDoc",
        pipeline: [{ $project: { name: 1, email: 1 } }],
      },
    },
    { $unwind: "$userDoc" },

    // sum only Received payments
    {
      $lookup: {
        from: "payments",
        localField: "_id",
        foreignField: "invoice",
        as: "payments",
        pipeline: [{ $match: { status: "Received" } }, { $project: { amount: 1 } }],
      },
    },
    {
      $addFields: {
        totalPaid: { $ifNull: [{ $sum: "$payments.amount" }, 0] },
        balanceDue: {
          $max: [
            {
              $subtract: ["$amount", { $ifNull: [{ $sum: "$payments.amount" }, 0] }],
            },
            0,
          ],
        },
      },
    },

    // compute status
    {
      $addFields: {
        _computedStatus: {
          $switch: {
            branches: [
              { case: { $gte: ["$totalPaid", "$amount"] }, then: "Paid" },
              {
                case: {
                  $and: [
                    { $ne: ["$dueDate", null] },
                    { $gt: [now, "$dueDate"] },
                    { $lt: ["$totalPaid", "$amount"] },
                  ],
                },
                then: "Overdue",
              },
              { case: { $gt: ["$totalPaid", 0] }, then: "Partially Paid" },
            ],
            default: "Unpaid",
          },
        },
      },
    },

    // apply post-compute filters (status/outstanding)
    ...(status ? [{ $match: { _computedStatus: status } }] : []),
    ...(outstanding ? [{ $match: { balanceDue: { $gt: 0 } } }] : []),

    { $sort: { createdAt: -1 } },

    {
      $facet: {
        items: [
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              invoiceNumber: 1,
              amount: 1,
              dueDate: 1,
              createdAt: 1,
              user: 1,
              userName: "$userDoc.name",
              userEmail: "$userDoc.email",
              totalPaid: 1,
              balanceDue: 1,
              status: "$_computedStatus",
              order: 1,
            },
          },
        ],
        meta: [{ $count: "total" }],
      },
    },
  ]);

  const items = (facet[0]?.items || []).map((x) => ({
    ...x,
    totalPaid: roundToTwo(x.totalPaid || 0),
    balanceDue: roundToTwo(x.balanceDue || 0),
  }));
  const total = facet[0]?.meta?.[0]?.total || 0;

  res.json({ page, total, items });
});

/* =========================
   GET /api/invoices/:id
   Private/Admin or Owner
   (Detail view)
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

  const isOwner = req.user && invoice.user && req.user._id.equals(invoice.user._id);
  if (!(req.user?.isAdmin || isOwner)) {
    res.status(403);
    throw new Error("Not authorized to view this invoice.");
  }

  res.json(invoice);
});

/* =========================
   POST /api/invoices/from-order/:orderId
   Private/Admin
   Body: { dueDate?, adminNote? }
   amount derived from order.totalPrice

   Business rule:
   - Invoice can be created when order.status is "Processing" or "Delivered"
   - One invoice per order
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

  const derivedAmount = roundToTwo(Math.max(0, orderDoc.totalPrice || 0));

  const invoice = await Invoice.create({
    order: orderDoc._id,
    user: orderDoc.user,
    amount: derivedAmount,
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

  // Optional but nice for REST: Location header
  res.setHeader("Location", `/api/invoices/${invoice._id}`);

  res.status(201).json({
    success: true,
    message: `Invoice created from order ${orderDoc.orderNumber} successfully.`,
    data: invoice,
  });
});

/* =========================
   PUT /api/invoices/:id
   Private/Admin
   Allowed fields: dueDate, adminNote
   ========================= */
export const updateInvoice = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) { res.status(404); throw new Error("Invoice not found."); }

  const { dueDate, adminNote, user, order, amount, ...rest } = req.body || {};

  if (typeof user !== "undefined" || typeof order !== "undefined") {
    res.status(400); throw new Error("Cannot change 'user' or 'order' of an invoice.");
  }
  if (typeof amount !== "undefined") {
    res.status(400); throw new Error("Cannot change 'amount' of an invoice. Delete & recreate via the Order if needed.");
  }

  const changes = {};

  if (typeof dueDate !== "undefined") {
    const newDue = dueDate ? new Date(dueDate) : undefined;
    if ((invoice.dueDate || null)?.toISOString?.() !== (newDue || null)?.toISOString?.()) {
      changes.dueDate = { from: invoice.dueDate || null, to: newDue || null };
      invoice.dueDate = newDue;
    }
  }

  if (typeof adminNote !== "undefined" && adminNote !== invoice.adminNote) {
    changes.adminNote = { from: invoice.adminNote || null, to: adminNote || null };
    invoice.adminNote = adminNote;
  }

  const updated = await invoice.save();
  await updated.populate(["payments", { path: "order", select: "orderNumber totalPrice status" }]);

  const changedKeys = Object.keys(changes);
  const message = changedKeys.length
    ? `Invoice updated successfully (${changedKeys.join(", ")}).`
    : "Invoice saved (no changes detected).";

  res.json({
    success: true,
    message,
    changed: changes,   // explicit diff for clients/logs
    data: updated,
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

  // Unlink invoice from its order (if any)
  let orderUnlinked = false;
  if (invoice.order) {
    const upd = await Order.updateOne(
      { _id: invoice.order, invoice: invoice._id },
      { $set: { invoice: null } }
    );
    orderUnlinked = upd.modifiedCount > 0;
  }

  // Delete related payments
  const payDel = await Payment.deleteMany({ invoice: invoice._id });
  const paymentsDeleted = payDel.deletedCount || 0;

  // Delete the invoice itself
  await invoice.deleteOne();

  // Prepare message
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
   GET /api/invoices/my
   Private (owner)
   ========================= */
export const getMyInvoices = asyncHandler(async (req, res) => {
  const invoices = await Invoice.find({ user: req.user._id })
    .populate("order", "orderNumber") // 👈 only load orderNumber
    .populate("payments")
    .sort({ createdAt: -1 });

  // Strip everything except orderNumber from the populated order
  const sanitized = invoices.map((inv) => {
    const obj = inv.toObject();
    if (obj.order && typeof obj.order === "object") {
      obj.order = { orderNumber: obj.order.orderNumber };
    }
    return obj;
  });

  res.json(sanitized);
});

