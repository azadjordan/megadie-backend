// megadie-backend/controllers/invoiceController.js
import mongoose from "mongoose";
import { chromium } from "playwright";
import Invoice from "../models/invoiceModel.js";
import Payment from "../models/paymentModel.js";
import User from "../models/userModel.js";
import asyncHandler from "../middleware/asyncHandler.js";
import {
  renderInvoiceHtml,
  invoiceFooterTemplate,
} from "../utils/invoiceTemplate.js";
import {
  renderStatementOfAccountHtml,
  statementOfAccountFooterTemplate,
} from "../utils/statementOfAccountTemplate.js";

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

function buildDateRange(from, to) {
  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  return range;
}

function addInvoiceDateRangeFilter(filter, from, to) {
  if (!from && !to) return;

  filter.$and = filter.$and || [];
  filter.$and.push({
    $or: [
      { invoiceDate: buildDateRange(from, to) },
      {
        invoiceDate: { $exists: false },
        createdAt: buildDateRange(from, to),
      },
      {
        invoiceDate: null,
        createdAt: buildDateRange(from, to),
      },
    ],
  });
}

function resolveInvoiceDate(invoice) {
  const value = invoice?.invoiceDate || invoice?.createdAt;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sumMinor(rows, key) {
  return rows.reduce((sum, row) => sum + (Number(row?.[key]) || 0), 0);
}

function sortTime(value) {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

function compareStatementInvoicesOldestFirst(a, b) {
  const dateDiff =
    sortTime(a?.statementDate || a?.invoiceDate || a?.createdAt) -
    sortTime(b?.statementDate || b?.invoiceDate || b?.createdAt);
  if (dateDiff !== 0) return dateDiff;

  const createdDiff = sortTime(a?.createdAt) - sortTime(b?.createdAt);
  if (createdDiff !== 0) return createdDiff;

  return String(a?._id || "").localeCompare(String(b?._id || ""));
}

function buildStatementInvoiceRows(invoices, payments) {
  const paidByInvoice = new Map();
  for (const payment of payments || []) {
    const invoiceId = String(payment?.invoice || "");
    if (!invoiceId) continue;
    paidByInvoice.set(
      invoiceId,
      (paidByInvoice.get(invoiceId) || 0) + (Number(payment?.amountMinor) || 0)
    );
  }

  return (invoices || []).map((invoice) => {
    const amountMinor = Math.max(0, Number(invoice?.amountMinor) || 0);
    const rawRecordedPaidMinor = Math.max(
      0,
      paidByInvoice.get(String(invoice?._id)) || 0
    );
    const recordedPaidMinor = Math.min(amountMinor, rawRecordedPaidMinor);
    const balanceMinor = Math.max(0, amountMinor - recordedPaidMinor);
    const statementStatus =
      balanceMinor <= 0
        ? "Paid"
        : recordedPaidMinor > 0
        ? "Partially paid"
        : "Unpaid";

    return {
      ...invoice,
      amountMinor,
      rawRecordedPaidMinor,
      recordedPaidMinor,
      paidTotalMinor: recordedPaidMinor,
      balanceMinor,
      balanceDueMinor: balanceMinor,
      statementStatus,
      statementDate: resolveInvoiceDate(invoice),
    };
  });
}

function isAdminUser(req) {
  // adjust if your user object uses role instead of isAdmin
  return Boolean(req.user?.isAdmin);
}

async function applyPdfMedia(page) {
  if (typeof page.emulateMediaType === "function") {
    await page.emulateMediaType("screen");
  } else if (typeof page.emulateMedia === "function") {
    await page.emulateMedia({ media: "screen" });
  }
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

  addInvoiceDateRangeFilter(q, from, to);

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
          "source",
          "invoiceItems",
          "invoiceNumber",
          "status",
          "amountMinor",
          "currency",
          "minorUnitFactor",
          "paidTotalMinor",
          "balanceDueMinor",
          "paymentStatus",
          "invoiceDate",
          "dueDate",
          "createdAt",
          "order",
        ].join(" ")
      )
      .sort({ invoiceDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({
        path: "order",
        // keep the card UI light + user-safe
        select: [
          "orderNumber",
          "status",
          "createdAt",
          "deliveredAt",
          "orderItems",
        ].join(" "),
        populate: {
          path: "orderItems.product",
          select: "name",
        },
      })
      .lean(),
  ]);

  const pages = Math.max(1, Math.ceil(total / limit));

  const safeItems = (items || []).map((inv) => {
    if (!inv?.order?.orderItems) return inv;
    const orderItems = inv.order.orderItems.map((it) => ({
      product: it?.product || it?.product?._id || null,
      productName: it?.productName || it?.product?.name,
      sku: it?.sku,
      qty: it?.qty,
    }));
    return {
      ...inv,
      order: {
        ...inv.order,
        orderItems,
      },
    };
  });

  res.json({
    page,
    pages,
    total,
    limit,
    items: safeItems,
  });
});

/**
 * @desc    Get my invoice balance summary (unpaid + overdue totals)
 * @route   GET /api/invoices/my/summary
 * @access  Private (owner)
 */
export const getMyInvoiceSummary = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const now = new Date();

  const baseMatch = {
    user: userId,
    status: "Issued",
    paymentStatus: { $ne: "Paid" },
    balanceDueMinor: { $gt: 0 },
  };

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
          { $match: { dueDate: { $lt: now } } },
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
      path: "user",
      select: "name email phoneNumber",
    })
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
 * @desc    Get invoice PDF (owner OR admin)
 * @route   GET /api/invoices/:id/pdf
 * @access  Private (owner or admin)
 */
export const getInvoicePDF = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error("Invalid invoice id.");
  }

  // Auth probe first
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

  const invoice = await Invoice.findById(id)
    .select(
      [
        "source",
        "invoiceItems",
        "invoiceNumber",
        "status",
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
        "order",
      ].join(" ")
    )
    .populate({
      path: "user",
      select: "name email",
    })
    .populate({
      path: "order",
      select: [
        "orderNumber",
        "orderItems",
        "deliveryCharge",
        "extraFee",
        "createdAt",
      ].join(" "),
      populate: {
        path: "orderItems.product",
        select: "name",
      },
    })
    .populate({
      path: "payments",
      options: { sort: { paymentDate: -1, createdAt: -1 } },
      select: [
        "amountMinor",
        "paymentMethod",
        "paymentDate",
        "reference",
        "receivedBy",
        "createdAt",
      ].join(" "),
    })
    .lean();

  if (!invoice) {
    res.status(404);
    throw new Error("Invoice not found.");
  }

  const html = renderInvoiceHtml({ invoice, order: invoice.order });
  const fileName = invoice.invoiceNumber
    ? `invoice-${invoice.invoiceNumber}.pdf`
    : `invoice-${invoice._id}.pdf`;

  let browser;
  try {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await applyPdfMedia(page);
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: invoiceFooterTemplate,
      margin: { top: "18mm", bottom: "22mm", left: "16mm", right: "16mm" },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=${fileName}`);
    res.end(pdfBuffer);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

/**
 * @desc    Get SOA PDF for a user (admin only)
 * @route   GET /api/invoices/soa/:userId?from=YYYY-MM-DD&to=YYYY-MM-DD
 * @access  Private/Admin
 */
export const getStatementOfAccountPDF = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const from = parseBoundedDate(req.query.from, "start");
  const to = parseBoundedDate(req.query.to, "end");

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    res.status(400);
    throw new Error("Invalid user id.");
  }

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

  const client = await User.findById(userId)
    .select("name email phoneNumber address")
    .lean();
  if (!client) {
    res.status(404);
    throw new Error("User not found.");
  }

  const invoiceFilter = {
    user: userId,
    status: "Issued",
  };

  addInvoiceDateRangeFilter(invoiceFilter, null, to);

  const invoices = await Invoice.find(invoiceFilter)
    .select(
      [
        "invoiceNumber",
        "amountMinor",
        "paidTotalMinor",
        "balanceDueMinor",
        "paymentStatus",
        "invoiceDate",
        "dueDate",
        "createdAt",
        "currency",
        "minorUnitFactor",
      ].join(" ")
    )
    .sort({ invoiceDate: 1, createdAt: 1 })
    .lean();

  const invoiceIds = invoices.map((invoice) => invoice._id).filter(Boolean);
  const payments = invoiceIds.length
    ? await Payment.find({ invoice: { $in: invoiceIds } })
        .select("invoice amountMinor")
        .lean()
    : [];

  const statementInvoices = buildStatementInvoiceRows(invoices, payments);
  const previousInvoices = from
    ? statementInvoices.filter((invoice) => {
        const invoiceDate = invoice.statementDate;
        return invoiceDate && invoiceDate.getTime() < from.getTime();
      })
    : [];
  const previousOutstandingInvoices = previousInvoices.filter(
    (invoice) => (Number(invoice.balanceMinor) || 0) > 0
  );
  const periodInvoices = from
    ? statementInvoices.filter((invoice) => {
        const invoiceDate = invoice.statementDate;
        return !invoiceDate || invoiceDate.getTime() >= from.getTime();
      })
    : statementInvoices;
  const outstandingInvoices = statementInvoices.filter(
    (invoice) => (Number(invoice.balanceMinor) || 0) > 0
  );
  const tableInvoices = from
    ? [...previousOutstandingInvoices, ...periodInvoices]
    : [...periodInvoices];
  tableInvoices.sort(compareStatementInvoicesOldestFirst);

  const currency = statementInvoices[0]?.currency || "AED";
  const minorUnitFactor = statementInvoices[0]?.minorUnitFactor || 100;
  const overdueReference = to || new Date();
  const openingBalanceMinor = from ? sumMinor(previousInvoices, "balanceMinor") : 0;
  const periodInvoicedMinor = sumMinor(periodInvoices, "amountMinor");
  const recordedPaymentsMinor = sumMinor(periodInvoices, "recordedPaidMinor");
  const closingBalanceMinor = sumMinor(statementInvoices, "balanceMinor");
  const overdueTotalMinor = outstandingInvoices.reduce((sum, inv) => {
    const due = inv?.dueDate ? Date.parse(inv.dueDate) : NaN;
    if (!Number.isFinite(due) || due >= overdueReference.getTime()) return sum;
    return sum + (Number(inv.balanceMinor) || 0);
  }, 0);
  const overdueCount = outstandingInvoices.reduce((sum, inv) => {
    const due = inv?.dueDate ? Date.parse(inv.dueDate) : NaN;
    if (!Number.isFinite(due) || due >= overdueReference.getTime()) return sum;
    return sum + 1;
  }, 0);

  const html = renderStatementOfAccountHtml({
    client,
    invoices: periodInvoices,
    periodInvoices,
    outstandingInvoices,
    tableInvoices,
    summary: {
      openingBalanceMinor,
      periodInvoicedMinor,
      recordedPaymentsMinor,
      closingBalanceMinor,
      totalInvoicedMinor: periodInvoicedMinor,
      totalPaidMinor: recordedPaymentsMinor,
      totalDueMinor: closingBalanceMinor,
      overdueTotalMinor,
      invoiceCount: periodInvoices.length,
      periodInvoiceCount: periodInvoices.length,
      previousInvoiceCount: previousOutstandingInvoices.length,
      outstandingCount: outstandingInvoices.length,
      openCount: outstandingInvoices.length,
      overdueCount,
      overdueReferenceDate: overdueReference.toISOString(),
      currency,
      minorUnitFactor,
    },
    generatedAt: new Date(),
    fromDateLabel: req.query.from ? String(req.query.from).slice(0, 10) : "",
    cutoffDateLabel: req.query.to ? String(req.query.to).slice(0, 10) : "",
  });

  const safeName = String(client.name || "client")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const fromTag = req.query.from ? String(req.query.from).slice(0, 10) : "";
  const dateTag = req.query.to
    ? String(req.query.to).slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const fileName = fromTag
    ? `soa-${safeName || client._id}-${fromTag}-to-${dateTag}.pdf`
    : `soa-${safeName || client._id}-${dateTag}.pdf`;

  let browser;
  try {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await applyPdfMedia(page);
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: statementOfAccountFooterTemplate,
      margin: { top: "18mm", bottom: "22mm", left: "16mm", right: "16mm" },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=${fileName}`);
    res.end(pdfBuffer);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});
