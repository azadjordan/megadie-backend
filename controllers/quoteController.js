import React from "react";
import asyncHandler from "../middleware/asyncHandler.js";
import Quote from "../models/quoteModel.js";
import { renderToStream } from "@react-pdf/renderer";
import QuotePDF from "../utils/QuotePDF.js";
// import sendEmail from "../utils/sendEmail.js";
// import buildQuoteEmail from "../utils/quoteRequestEmail.js";
// import sendTelegramAlert from "../utils/sendTelegramAlert.js";

/* =========================
   POST /api/quotes
   Private (guarded in routes)
   Create new quote (Client)
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

  /* -------------------------------------------
     Notifications (disabled for now — prod toggle)
     -------------------------------------------
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
  ------------------------------------------- */

  res.status(201).json(populated);
});

/* =========================
   GET /api/quotes/my
   Private (guarded in routes)
   Get logged-in user's quotes
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
   GET /api/quotes/admin
   Private/Admin (guarded in routes)
   Get all quotes (Admin)
   ========================= */
export const getQuotes = asyncHandler(async (_req, res) => {
  const quotes = await Quote.find({})
    .populate("user", "name email")
    .populate("requestedItems.product", "name code size")
    .sort({ createdAt: -1 });

  res.json(quotes);
});

/* =========================
   GET /api/quotes/:id
   Private (guarded in routes); owner or admin (checked here)
   Get quote by ID
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
   GET /api/quotes/:id/pdf
   Private/Admin (guarded in routes)
   Generate PDF for quote
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
   PUT /api/quotes/:id
   Private/Admin (guarded in routes)
   Update quote (without changing product IDs)
   ========================= */
export const updateQuote = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.id);
  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  // If requestedItems provided, ensure product IDs are immutable
  if (Array.isArray(req.body.requestedItems)) {
    const current = quote.requestedItems || [];

    // Build sets/maps for comparison & fast lookup
    const currentIds = current.map((it) => String(it.product));
    const incoming = req.body.requestedItems;

    // Basic shape validation
    for (const it of incoming) {
      if (!it || !it.product) {
        res.status(400);
        throw new Error("Each requested item must include a product id.");
      }
    }

    const incomingIds = incoming.map((it) => String(it.product));

    // 1) same length
    if (incomingIds.length !== currentIds.length) {
      res.status(400);
      throw new Error("You cannot add or remove items from the quote.");
    }

    // 2) same multiset (no reordering-based attacks)
    const count = (arr) => arr.reduce((m, id) => (m[id] = (m[id] || 0) + 1, m), {});
    const a = count(currentIds);
    const b = count(incomingIds);
    const sameSet = Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => a[k] === b[k]);

    if (!sameSet) {
      res.status(400);
      throw new Error("You cannot change product IDs in quote items.");
    }

    // 3) merge only qty/unitPrice onto existing items by product id
    const incomingByProduct = new Map(
      incoming.map((it) => [String(it.product), it])
    );

    quote.requestedItems = current.map((existing) => {
      const key = String(existing.product);
      const inc = incomingByProduct.get(key);

      // Parse & validate numbers if provided; fall back to existing
      const nextQty = inc?.qty !== undefined ? Number(inc.qty) : existing.qty;
      const nextUnit = inc?.unitPrice !== undefined ? Number(inc.unitPrice) : existing.unitPrice;

      if (!Number.isFinite(nextQty) || nextQty <= 0) {
        res.status(400);
        throw new Error(`Invalid qty for product ${key}`);
      }
      if (!Number.isFinite(nextUnit) || nextUnit < 0) {
        res.status(400);
        throw new Error(`Invalid unitPrice for product ${key}`);
      }

      // Keep product id immutable; only update qty/unitPrice
      return {
        product: existing.product,
        qty: nextQty,
        unitPrice: nextUnit,
      };
    });
  }

  // Whitelist simple fields
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
        res.status(400);
        throw new Error(`${k} must be a non-negative number`);
      }
      quote[k] = v;
    } else {
      quote[k] = req.body[k];
    }
  });

  // Totals auto-recompute in model hooks
  const updated = await quote.save();
  res.json(updated);
});

/* =========================
   DELETE /api/quotes/:id
   Private/Admin (guarded in routes)
   Delete quote
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
