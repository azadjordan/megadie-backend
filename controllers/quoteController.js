import React from "react";
import asyncHandler from "../middleware/asyncHandler.js";
import Quote from "../models/quoteModel.js";
import { renderToStream } from "@react-pdf/renderer";
import QuotePDF from "../utils/QuotePDF.js";

/* =========================
   POST /api/quotes
   Private
   Create new quote (Client)
   ========================= */
export const createQuote = asyncHandler(async (req, res) => {
  const { requestedItems, clientToAdminNote } = req.body;

  if (!Array.isArray(requestedItems) || requestedItems.length === 0) {
    res.status(400);
    throw new Error("Quote must contain at least one item.");
  }

  // Trust nothing about prices from client; schema validates qty >= 1, etc.
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

  res.setHeader("Location", `/api/quotes/${quote._id}`);

  res.status(201).json({
    success: true,
    message: "Quote created successfully.",
    data: populated,
  });
});

/* =========================
   GET /api/quotes/my
   Private
   Get logged-in user's quotes (hide prices for Requested)
   ========================= */
export const getMyQuotes = asyncHandler(async (req, res) => {
  const quotes = await Quote.find({ user: req.user._id })
    .populate("requestedItems.product", "name code size")
    .sort({ createdAt: -1 });

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

  res.status(200).json({
    success: true,
    message: "Your quotes retrieved successfully.",
    data: sanitized,
  });
});

/* =========================
   GET /api/quotes/admin
   Private/Admin
   Get all quotes
   ========================= */
export const getQuotes = asyncHandler(async (_req, res) => {
  const quotes = await Quote.find({})
    .populate("user", "name email")
    .populate("requestedItems.product", "name code size")
    .sort({ createdAt: -1 });

  res.status(200).json({
    success: true,
    message: "Quotes retrieved successfully.",
    data: quotes,
  });
});

/* =========================
   GET /api/quotes/:id
   Private (owner) or Admin
   Get quote by ID (hide prices for owners if Requested)
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

  if (!isAdmin && quote.status === "Requested") {
    const obj = quote.toObject();
    obj.requestedItems = obj.requestedItems.map((it) => ({
      product: it.product,
      qty: it.qty,
    }));
    delete obj.deliveryCharge;
    delete obj.extraFee;
    delete obj.totalPrice;

    return res.status(200).json({
      success: true,
      message: "Quote retrieved successfully.",
      data: obj,
    });
  }

  res.status(200).json({
    success: true,
    message: "Quote retrieved successfully.",
    data: quote,
  });
});

/* =========================
   GET /api/quotes/:id/pdf
   Private/Admin
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
   Private/Admin
   Update quote (product IDs immutable)
   ========================= */
export const updateQuote = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.id);
  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  const changes = {};

  // If requestedItems provided, ensure product IDs are immutable
  if (Array.isArray(req.body.requestedItems)) {
    const current = quote.requestedItems || [];
    const currentIds = current.map((it) => String(it.product));
    const incoming = req.body.requestedItems;

    for (const it of incoming) {
      if (!it || !it.product) {
        res.status(400);
        throw new Error("Each requested item must include a product id.");
      }
    }

    const incomingIds = incoming.map((it) => String(it.product));

    if (incomingIds.length !== currentIds.length) {
      res.status(400);
      throw new Error("You cannot add or remove items from the quote.");
    }

    const count = (arr) => arr.reduce((m, id) => ((m[id] = (m[id] || 0) + 1), m), {});
    const a = count(currentIds);
    const b = count(incomingIds);
    const sameSet =
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => a[k] === b[k]);

    if (!sameSet) {
      res.status(400);
      throw new Error("You cannot change product IDs in quote items.");
    }

    const incomingByProduct = new Map(incoming.map((it) => [String(it.product), it]));

    let changedItems = 0;
    quote.requestedItems = current.map((existing) => {
      const key = String(existing.product);
      const inc = incomingByProduct.get(key);

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

      if (nextQty !== existing.qty || nextUnit !== existing.unitPrice) changedItems += 1;

      return { product: existing.product, qty: nextQty, unitPrice: nextUnit };
    });

    if (changedItems > 0) {
      changes.requestedItems = { changedItems };
    }
  }

  // Whitelist simple fields
  const allowed = new Set([
    "status",
    "deliveryCharge",
    "extraFee",
    "adminToAdminNote",
    "adminToClientNote",
  ]);

  for (const k of Object.keys(req.body || {})) {
    if (!allowed.has(k)) continue;

    if (k === "deliveryCharge" || k === "extraFee") {
      const v = Number(req.body[k]);
      if (!Number.isFinite(v) || v < 0) {
        res.status(400);
        throw new Error(`${k} must be a non-negative number`);
      }
      if (quote[k] !== v) {
        changes[k] = { from: quote[k] ?? null, to: v };
        quote[k] = v;
      }
    } else {
      const v = req.body[k];
      if (quote[k] !== v) {
        changes[k] = { from: quote[k] ?? null, to: v ?? null };
        quote[k] = v;
      }
    }
  }

  const updated = await quote.save();

  const changedKeys = Object.keys(changes);
  const message = changedKeys.length
    ? `Quote updated successfully (${changedKeys.join(", ")}).`
    : "Quote saved (no changes detected).";

  res.status(200).json({
    success: true,
    message,
    changed: changes,
    data: updated,
  });
});

/* =========================
   DELETE /api/quotes/:id
   Private/Admin
   Delete quote (only if Cancelled)
   ========================= */
export const deleteQuote = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.id);
  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  if (quote.status !== "Cancelled") {
    res.status(400);
    throw new Error("Only quotes with status 'Cancelled' can be deleted.");
  }

  const snapshot = { quoteId: quote._id, status: quote.status };
  await quote.deleteOne();

  res.status(200).json({
    success: true,
    message: "Quote deleted successfully.",
    ...snapshot,
  });
});

