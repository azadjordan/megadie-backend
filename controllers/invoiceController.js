// megadie-backend/controllers/invoiceController.js
import mongoose from "mongoose";
import { chromium } from "playwright";
import Invoice from "../models/invoiceModel.js";
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
 * @route   GET /api/invoices/soa/:userId
 * @access  Private/Admin
 */
export const getStatementOfAccountPDF = asyncHandler(async (req, res) => {
  const { userId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    res.status(400);
    throw new Error("Invalid user id.");
  }

  const client = await User.findById(userId)
    .select("name email phoneNumber address")
    .lean();
  if (!client) {
    res.status(404);
    throw new Error("User not found.");
  }

  const invoices = await Invoice.find({
    user: userId,
    status: "Issued",
    paymentStatus: { $ne: "Paid" },
    balanceDueMinor: { $gt: 0 },
  })
    .select(
      [
        "invoiceNumber",
        "amountMinor",
        "paidTotalMinor",
        "balanceDueMinor",
        "paymentStatus",
        "dueDate",
        "createdAt",
        "currency",
        "minorUnitFactor",
      ].join(" ")
    )
    .sort({ createdAt: 1 })
    .lean();

  const currency = invoices[0]?.currency || "AED";
  const minorUnitFactor = invoices[0]?.minorUnitFactor || 100;
  const now = Date.now();
  const totalDueMinor = invoices.reduce(
    (sum, inv) => sum + (Number(inv.balanceDueMinor) || 0),
    0
  );
  const overdueTotalMinor = invoices.reduce((sum, inv) => {
    const due = inv?.dueDate ? Date.parse(inv.dueDate) : NaN;
    if (!Number.isFinite(due) || due >= now) return sum;
    return sum + (Number(inv.balanceDueMinor) || 0);
  }, 0);

  const html = renderStatementOfAccountHtml({
    client,
    invoices,
    summary: { totalDueMinor, overdueTotalMinor, currency, minorUnitFactor },
    generatedAt: new Date(),
  });

  const safeName = String(client.name || "client")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const dateTag = new Date().toISOString().slice(0, 10);
  const fileName = `soa-${safeName || client._id}-${dateTag}.pdf`;

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

