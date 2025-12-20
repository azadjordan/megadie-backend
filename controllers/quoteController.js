// controllers/quoteController.js
import React from "react";
import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import Quote from "../models/quoteModel.js";
import { renderToStream } from "@react-pdf/renderer";
import QuotePDF from "../utils/QuotePDF.js";
import User from "../models/userModel.js";

/* =========================
   Constants / Rules
   ========================= */

// ✅ Keep in sync with quoteModel enum
const ALLOWED_STATUSES = ["Processing", "Quoted", "Confirmed", "Cancelled"];
const allowedStatusesSet = new Set(ALLOWED_STATUSES);

// ✅ Basic status transitions (adjust if your business rules change)
const ALLOWED_TRANSITIONS = {
  Processing: new Set(["Processing", "Quoted", "Cancelled"]),
  Quoted: new Set(["Quoted", "Confirmed", "Cancelled"]),
  Confirmed: new Set(["Confirmed"]), // locked by default
  Cancelled: new Set(["Cancelled"]), // locked by default
};

/* =========================
   Helper: sanitize quote for OWNER views based on status
   ========================= */
const sanitizeQuoteForOwner = (quoteDoc) => {
  const obj = quoteDoc.toObject ? quoteDoc.toObject() : { ...quoteDoc };
  const status = obj.status;

  const stripAllPricing = () => {
    // remove unit prices from items
    obj.requestedItems = (obj.requestedItems || []).map((it) => ({
      product: it.product,
      qty: it.qty,
    }));
    delete obj.deliveryCharge;
    delete obj.extraFee;
    delete obj.totalPrice;
  };

  const keepOnlyTotal = () => {
    // keep items but remove unit pricing and fees; keep totalPrice only
    obj.requestedItems = (obj.requestedItems || []).map((it) => ({
      product: it.product,
      qty: it.qty,
    }));
    delete obj.deliveryCharge;
    delete obj.extraFee;
    // totalPrice stays
  };

  if (status === "Processing") {
    stripAllPricing();
    return obj;
  }

  if (status === "Quoted") {
    // show full pricing
    return obj;
  }

  if (status === "Confirmed") {
    keepOnlyTotal();
    return obj;
  }

  if (status === "Cancelled") {
    stripAllPricing();
    return obj;
  }

  // default fallback: be conservative
  stripAllPricing();
  return obj;
};

/* =========================
   PUT /api/quotes/:id/cancel
   Private (Owner)
   Cancel a quote (allowed in Processing or Quoted)
   ========================= */
export const cancelQuoteByUser = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.id);

  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  // Owner check
  const isOwner = String(quote.user) === String(req.user._id);
  if (!isOwner) {
    res.status(403);
    throw new Error("Not authorized to cancel this quote.");
  }

  // Allowed states
  if (!["Processing", "Quoted"].includes(quote.status)) {
    res.status(409);
    throw new Error("Only Processing or Quoted quotes can be cancelled.");
  }

  if (quote.status !== "Cancelled") {
    quote.status = "Cancelled";
  }

  const updated = await quote.save();

  res.status(200).json({
    success: true,
    message: "Quote cancelled successfully.",
    data: updated,
  });
});

/* =========================
   PUT /api/quotes/:id/confirm
   Private (Owner)
   Confirm a quote (allowed only in Quoted)
   ========================= */
export const confirmQuoteByUser = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.id);

  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  // Owner check
  const isOwner = String(quote.user) === String(req.user._id);
  if (!isOwner) {
    res.status(403);
    throw new Error("Not authorized to confirm this quote.");
  }

  // Allowed state
  if (quote.status !== "Quoted") {
    res.status(409);
    throw new Error("Only Quoted quotes can be confirmed.");
  }

  // ✅ ensure pricing exists before confirming
  const items = quote.requestedItems || [];
  const hasAnyPrice = items.some((it) => Number(it.unitPrice) > 0);
  if (!hasAnyPrice) {
    res.status(400);
    throw new Error("Quote cannot be confirmed until pricing is assigned.");
  }

  quote.status = "Confirmed";
  const updated = await quote.save();

  res.status(200).json({
    success: true,
    message: "Quote confirmed successfully.",
    data: updated,
  });
});

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
    select: "sku",
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
   Paginated: newest -> oldest
   Limit capped at 5
   Sanitized by status
   ========================= */
export const getMyQuotes = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

  // ✅ cap at 5 always
  const limitRaw = parseInt(req.query.limit, 10);
  const limit = Math.min(Math.max(limitRaw || 5, 1), 5);

  const skip = (page - 1) * limit;

  const filter = { user: req.user._id };
  const sort = { createdAt: -1, _id: -1 }; // newest -> oldest, stable

  const [total, quotesRaw] = await Promise.all([
    Quote.countDocuments(filter),
    Quote.find(filter)
      .populate("requestedItems.product", "name")
      .sort(sort)
      .skip(skip)
      .limit(limit),
  ]);

  const sanitized = (quotesRaw || []).map((q) => sanitizeQuoteForOwner(q));

  res.status(200).json({
    success: true,
    message: "Your quotes retrieved successfully.",
    data: sanitized,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
      hasPrev: page > 1,
      hasNext: page * limit < total,
    },
  });
});

/* =========================
   GET /api/quotes/:id
   Private (owner) or Admin
   Get quote by ID (sanitized for owner by status)
   ========================= */
export const getQuoteById = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.id)
    .populate("user", "name email")
    .populate("requestedItems.product", "name");

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

  // ✅ Admin sees full quote
  if (isAdmin) {
    return res.status(200).json({
      success: true,
      message: "Quote retrieved successfully.",
      data: quote,
    });
  }

  // ✅ Owner sees sanitized view based on status
  const sanitized = sanitizeQuoteForOwner(quote);

  return res.status(200).json({
    success: true,
    message: "Quote retrieved successfully.",
    data: sanitized,
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

  const pdfStream = await renderToStream(
    React.createElement(QuotePDF, { quote })
  );
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename=quote-${quote._id}.pdf`
  );
  pdfStream.pipe(res);
});

/* =========================
   PUT /api/quotes/:id
   Private/Admin
   Update quote (product IDs immutable, user re-assign allowed)
   ========================= */
export const updateQuote = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.id);
  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  // Extra safety: ensure only admins can update quotes
  if (!req.user?.isAdmin) {
    res.status(403);
    throw new Error("Only admins can update quotes.");
  }

  const changes = {};

  /* ---------------------------------------
   * requestedItems (qty / unitPrice only)
   * ------------------------------------- */
  if (Array.isArray(req.body.requestedItems)) {
    const current = quote.requestedItems || [];
    const currentIds = current.map((it) => String(it.product));
    const incoming = req.body.requestedItems;

    // Validate shape
    for (const it of incoming) {
      if (!it || !it.product) {
        res.status(400);
        throw new Error("Each requested item must include a product id.");
      }
    }

    const incomingIds = incoming.map((it) => String(it.product));

    // Same number of items?
    if (incomingIds.length !== currentIds.length) {
      res.status(400);
      throw new Error("You cannot add or remove items from the quote.");
    }

    // Same multiset of product IDs? (no product changes)
    const count = (arr) =>
      arr.reduce((m, id) => {
        m[id] = (m[id] || 0) + 1;
        return m;
      }, {});

    const a = count(currentIds);
    const b = count(incomingIds);

    const sameSet =
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => a[k] === b[k]);

    if (!sameSet) {
      res.status(400);
      throw new Error("You cannot change product IDs in quote items.");
    }

    const incomingByProduct = new Map(
      incoming.map((it) => [String(it.product), it])
    );

    let changedItems = 0;

    quote.requestedItems = current.map((existing) => {
      const key = String(existing.product);
      const inc = incomingByProduct.get(key);

      const nextQty = inc?.qty !== undefined ? Number(inc.qty) : existing.qty;
      const nextUnit =
        inc?.unitPrice !== undefined ? Number(inc.unitPrice) : existing.unitPrice;

      if (!Number.isFinite(nextQty) || nextQty <= 0) {
        res.status(400);
        throw new Error(`Invalid qty for product ${key}`);
      }
      if (!Number.isFinite(nextUnit) || nextUnit < 0) {
        res.status(400);
        throw new Error(`Invalid unitPrice for product ${key}`);
      }

      if (nextQty !== existing.qty || nextUnit !== existing.unitPrice) {
        changedItems += 1;
      }

      return {
        product: existing.product,
        qty: nextQty,
        unitPrice: nextUnit,
      };
    });

    if (changedItems > 0) {
      changes.requestedItems = { changedItems };
    }
  }

  /* ---------------------------------------
   * Simple fields (including user)
   * ------------------------------------- */
  const allowed = new Set([
    "user",
    "status",
    "deliveryCharge",
    "extraFee",
    "adminToAdminNote",
    "adminToClientNote",
  ]);

  for (const k of Object.keys(req.body || {})) {
    if (!allowed.has(k)) continue;

    // Special handling: reassign user (admin-only)
    if (k === "user") {
      const newUserId = req.body.user;

      if (!mongoose.isValidObjectId(newUserId)) {
        res.status(400);
        throw new Error("Invalid user id.");
      }

      const newUser = await User.findById(newUserId).select("_id");
      if (!newUser) {
        res.status(400);
        throw new Error("User not found.");
      }

      if (String(quote.user) !== String(newUserId)) {
        changes.user = {
          from: String(quote.user),
          to: String(newUserId),
        };
        quote.user = newUserId;
      }

      continue; // skip generic handling for this key
    }

    // Numeric fields with validation
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
      continue;
    }

    // status, adminToAdminNote, adminToClientNote
    const v = req.body[k];

    // ✅ Status guard: forbid removed statuses like "Rejected"
    if (k === "status") {
      if (!allowedStatusesSet.has(v)) {
        res.status(400);
        throw new Error(
          `Invalid status. Allowed: ${ALLOWED_STATUSES.join(", ")}`
        );
      }

      const from = quote.status;
      const to = v;

      if (!ALLOWED_TRANSITIONS[from] || !ALLOWED_TRANSITIONS[from].has(to)) {
        res.status(409);
        throw new Error(`Invalid status transition from '${from}' to '${to}'.`);
      }
    }

    if (quote[k] !== v) {
      changes[k] = { from: quote[k] ?? null, to: v ?? null };
      quote[k] = v;
    }
  }

  const updated = await quote.save(); // pre('save') will recompute totals

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

  // Extra safety: admin-only
  if (!req.user?.isAdmin) {
    res.status(403);
    throw new Error("Only admins can delete quotes.");
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

/* =========================
   GET /api/quotes/admin?page=1&limit=20
   Private/Admin
   Get all quotes (paginated, newest first)
   ========================= */
export const getQuotes = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20)); // hard cap optional
  const skip = (page - 1) * limit;

  const filter = {}; // add status/user filters later if needed

  const [total, quotes] = await Promise.all([
    Quote.countDocuments(filter),
    Quote.find(filter)
      .populate("user", "name email")
      .populate("requestedItems.product", "sku")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
  ]);

  const pages = Math.max(1, Math.ceil(total / limit));

  res.status(200).json({
    success: true,
    message: "Quotes retrieved successfully.",
    page,
    pages,
    total,
    limit,
    data: quotes,
  });
});
