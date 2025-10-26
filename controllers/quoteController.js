import React from "react";
import asyncHandler from "../middleware/asyncHandler.js";
import Quote from "../models/quoteModel.js";
import { renderToStream } from "@react-pdf/renderer";
import QuotePDF from "../utils/QuotePDF.js";
import sendEmail from "../utils/sendEmail.js";
import buildQuoteEmail from "../utils/quoteRequestEmail.js";
import sendTelegramAlert from "../utils/sendTelegramAlert.js";

/* =========================
   Create new quote (Client)
   POST /api/quotes
   ========================= */
export const createQuote = asyncHandler(async (req, res) => {
  const { requestedItems, clientToAdminNote } = req.body;

  if (!Array.isArray(requestedItems) || requestedItems.length === 0) {
    res.status(400);
    throw new Error("Quote must contain at least one item.");
  }

  // Trust nothing about prices from client; schema will validate the rest
  const safeItems = requestedItems.map((it) => ({
    product: it.product,
    qty: Number(it.qty),
    unitPrice: 0,
  }));

  const quote = await Quote.create({
    user: req.user._id,
    requestedItems: safeItems,
    clientToAdminNote,
  });

  const populated = await quote.populate({
    path: "requestedItems.product",
    select: "name code size",
  });

  // Email (best-effort)
  try {
    await sendEmail({
      to: ["azadkkurdi@gmail.com", "almomani95hu@gmail.com"],
      subject: "🆕 New Quote Request Received",
      html: buildQuoteEmail({ user: req.user, quote: populated }),
    });
  } catch (err) {
    console.error("❌ Email notification failed:", err.message);
  }

  // Telegram (best-effort)
  try {
    const itemList = populated.requestedItems
      .map((item) => {
        const prod = item.product || {};
        const name = prod.name || "Unnamed";
        const code = prod.code || "—";
        const qty = item.qty ?? "N/A";
        return `• ${name} — Qty: ${qty}\n   Code: ${code}`;
      })
      .join("\n");

    const message =
      `📥 *New Quote Request*\n` +
      `👤 *Client:* ${req.user.name} (${req.user.email})\n` +
      `📝 *Note:* ${clientToAdminNote || "—"}\n` +
      `📦 *Items:* ${safeItems.length}\n\n` +
      itemList;

    await sendTelegramAlert(message);
  } catch (err) {
    console.error("❌ Telegram alert failed:", err.message);
  }

  res.status(201).json(populated);
});

/* =========================
   Get logged-in user's quotes
   GET /api/quotes/my
   ========================= */
export const getMyQuotes = asyncHandler(async (req, res) => {
  const quotes = await Quote.find({ user: req.user._id })
    .populate("requestedItems.product", "name code size")
    .sort({ createdAt: -1 });

  // Hide pricing for "Requested"
  const sanitized = quotes.map((q) => {
    const obj = q.toObject();
    if (q.status === "Requested") {
      obj.requestedItems = obj.requestedItems.map((it) => ({
        product: it.product,
        qty: it.qty,
      }));
      delete obj.deliveryCharge;
      delete obj.extraFee;
      delete obj.totalPrice;
    }
    return obj;
  });

  res.json(sanitized);
});

/* =========================
   Get all quotes (Admin)
   GET /api/quotes/admin
   ========================= */
export const getQuotes = asyncHandler(async (req, res) => {
  const quotes = await Quote.find({})
    .populate("user", "name email")
    .populate("requestedItems.product", "name code size")
    .sort({ createdAt: -1 });

  res.json(quotes);
});

/* =========================
   Get quote by ID
   GET /api/quotes/:id
   ========================= */
export const getQuoteById = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.id)
    .populate("user", "name email")
    .populate("requestedItems.product", "name code size");

  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  const isAdmin = !!req.user?.isAdmin;
  const isOwner = String(quote.user?._id || quote.user) === String(req.user._id);
  if (!isAdmin && !isOwner) {
    res.status(403);
    throw new Error("Not authorized to view this quote.");
  }

  // Hide pricing from owners when still Requested
  if (!isAdmin && quote.status === "Requested") {
    const obj = quote.toObject();
    obj.requestedItems = obj.requestedItems.map((it) => ({
      product: it.product,
      qty: it.qty,
    }));
    delete obj.deliveryCharge;
    delete obj.extraFee;
    delete obj.totalPrice;
    return res.json(obj);
  }

  res.json(quote);
});

/* =========================
   Generate PDF for quote (Admin only)
   GET /api/quotes/:id/pdf
   ========================= */
export const getQuotePDF = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.id)
    .populate("user", "name email")
    .populate("requestedItems.product", "name code size");

  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  const pdfStream = await renderToStream(React.createElement(QuotePDF, { quote }));
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename=quote-${quote._id}.pdf`);
  pdfStream.pipe(res);
});

/* =========================
   Update quote (Admin)
   PUT /api/quotes/:id
   ========================= */
export const updateQuote = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.id);
  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  // Admin may update requested items (prices/qty) if provided
  if (Array.isArray(req.body.requestedItems)) {
    quote.requestedItems = req.body.requestedItems.map((it) => ({
      product: it.product,
      qty: Number(it.qty),
      unitPrice: Number(it.unitPrice),
    }));
  }

  const allowed = new Set([
    "status",
    "deliveryCharge",
    "extraFee",
    "adminToAdminNote",
    "adminToClientNote",
  ]);

  Object.keys(req.body || {}).forEach((k) => {
    if (!allowed.has(k)) return;
    if (k === "deliveryCharge" || k === "extraFee") {
      const v = Number(req.body[k]);
      if (!Number.isFinite(v) || v < 0) {
        throw new Error(`${k} must be a non-negative number`);
      }
      quote[k] = v;
    } else {
      quote[k] = req.body[k];
    }
  });

  // Totals are auto-recomputed by the model hook
  const updated = await quote.save();
  res.json(updated);
});

/* =========================
   Delete quote (Admin)
   DELETE /api/quotes/:id
   ========================= */
export const deleteQuote = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.id);
  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  await quote.deleteOne();
  res.status(204).end();
});
