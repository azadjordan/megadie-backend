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

const escapeRegex = (text = "") =>
  String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
   GET /api/quotes/admin?page=1&limit=5&status=Processing&search=abc
   Private/Admin
   Get all quotes (paginated, newest first)
   ========================= */
export const getQuotes = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(5, Math.max(1, Number(req.query.limit) || 5));
  const skip = (page - 1) * limit;

  const filter = {};
  const status = req.query.status ? String(req.query.status).trim() : "";
  if (status) {
    if (!allowedStatusesSet.has(status)) {
      res.status(400);
      throw new Error(`Invalid status. Allowed: ${ALLOWED_STATUSES.join(", ")}`);
    }
    filter.status = status;
  }

  const search = req.query.search ? String(req.query.search).trim() : "";
  if (search) {
    const searchRegex = new RegExp(escapeRegex(search), "i");
    const users = await User.find({
      $or: [{ name: searchRegex }, { email: searchRegex }],
    })
      .select("_id")
      .limit(200)
      .lean();

    const userIds = users.map((u) => u._id);
    filter.$or = [{ quoteNumber: searchRegex }];
    if (userIds.length) {
      filter.$or.push({ user: { $in: userIds } });
    }
  }

  const [total, quotes] = await Promise.all([
    Quote.countDocuments(filter),
    Quote.find(filter)
      .populate("user", "name email")
      .populate("requestedItems.product", "sku")
      // optional: show order number in admin list
      .populate("order", "orderNumber status")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  res.status(200).json({
    success: true,
    message: "Quotes retrieved successfully.",
    page,
    pages: totalPages,
    total,
    limit,
    data: quotes,
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

/* =========================
   PUT /api/quotes/:id
   Private/Admin
   Update quote (product IDs immutable, user re-assign allowed)
   HARD LOCK: if order exists, admin must delete order first
   ========================= */
export const updateQuote = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.id);
  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  // Admin-only
  if (!req.user?.isAdmin) {
    res.status(403);
    throw new Error("Only admins can update quotes.");
  }

  // ✅ HARD LOCK: if an order exists, no editing allowed
  if (quote.order) {
    res.status(409);
    throw new Error(
      "Order already created for this quote. Delete the order first before editing the quote."
    );
  }

  const changes = {};

  /* ---------------------------------------
   * requestedItems (qty / unitPrice only)
   * - no add/remove
   * - no product changes
   * - supports duplicates safely (by matching counts per product)
   * ------------------------------------- */
  if (Array.isArray(req.body.requestedItems)) {
    const current = quote.requestedItems || [];
    const incoming = req.body.requestedItems;

    // Validate shape
    for (const it of incoming) {
      if (!it || !it.product) {
        res.status(400);
        throw new Error("Each requested item must include a product id.");
      }
    }

    const currentIds = current.map((it) => String(it.product));
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

    const sameMultiset =
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((k) => a[k] === b[k]);

    if (!sameMultiset) {
      res.status(400);
      throw new Error("You cannot change product IDs in quote items.");
    }

    /**
     * IMPORTANT:
     * Your schema uses {_id:false} for requestedItems, so items have no stable id.
     * To support duplicates safely, we:
     * - bucket incoming items per product id
     * - for each existing item, consume one incoming entry for that product
     */
    const incomingBuckets = incoming.reduce((m, it) => {
      const key = String(it.product);
      if (!m[key]) m[key] = [];
      m[key].push(it);
      return m;
    }, {});

    let changedItems = 0;

    quote.requestedItems = current.map((existing) => {
      const key = String(existing.product);
      const bucket = incomingBuckets[key] || [];
      const inc = bucket.shift(); // consume one for this existing item

      // should always exist because multiset matches
      if (!inc) {
        res.status(400);
        throw new Error("Invalid requestedItems payload.");
      }

      const nextQty = inc.qty !== undefined ? Number(inc.qty) : existing.qty;
      const nextUnit =
        inc.unitPrice !== undefined ? Number(inc.unitPrice) : existing.unitPrice;

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

    // Reassign user (admin-only)
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
        changes.user = { from: String(quote.user), to: String(newUserId) };
        quote.user = newUserId;
      }
      continue;
    }

    // Numeric fields
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

    if (k === "status") {
      if (!allowedStatusesSet.has(v)) {
        res.status(400);
        throw new Error(`Invalid status. Allowed: ${ALLOWED_STATUSES.join(", ")}`);
      }

      const from = quote.status;
      const to = v;

      if (!ALLOWED_TRANSITIONS[from] || !ALLOWED_TRANSITIONS[from].has(to)) {
        res.status(409);
        throw new Error(`Invalid status transition from '${from}' to '${to}'.`);
      }

      // ✅ extra business rule: cannot confirm unless at least one priced item exists
      // (keeps consistency with confirmQuoteByUser logic)
      if (to === "Confirmed") {
        const items = quote.requestedItems || [];
        const hasAnyPrice = items.some((it) => Number(it.unitPrice) > 0);
        if (!hasAnyPrice) {
          res.status(400);
          throw new Error("Quote cannot be confirmed until pricing is assigned.");
        }
      }
    }

    if (quote[k] !== v) {
      changes[k] = { from: quote[k] ?? null, to: v ?? null };
      quote[k] = v;
    }
  }

  await quote.save(); // pre('save') recomputes totals

  // ✅ Return populated data for immediate UI usage
  // Admin should see sku; also keep order populated (though order is null here due to lock)
  const populated = await Quote.findById(quote._id)
    .populate("user", "name email")
    .populate("requestedItems.product", "sku")
    .populate("order", "orderNumber status");

  const changedKeys = Object.keys(changes);
  const message = changedKeys.length
    ? `Quote updated successfully (${changedKeys.join(", ")}).`
    : "Quote saved (no changes detected).";

  res.status(200).json({
    success: true,
    message,
    changed: changes,
    data: populated,
  });
});

/* =========================
   GET /api/quotes/:id
   Private (owner) or Admin
   Get quote by ID (sanitized for owner by status)
   ========================= */
export const getQuoteById = asyncHandler(async (req, res) => {
  // ✅ Populate both name + sku so:
  // - Admin UI can show sku
  // - Owner UI (sanitized) can still show name if needed
  // ✅ Also populate order so admin can see if order exists + orderNumber/status
  const quote = await Quote.findById(req.params.id)
    .populate("user", "name email")
    .populate("requestedItems.product", "name sku")
    .populate("order", "orderNumber status");

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

  // ✅ Admin sees full quote (includes sku + order info)
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
   PUT /api/quotes/admin/:id
   Private/Admin
   Steps UI:
   1) Update user
   2) Update qty + unitPrice ONLY (no adding/removing items, no changing products)
   3) Update notes
   4) Update status
   5) Totals auto-recomputed by model pre("save")
   Rules:
   - HARD LOCK if quote.order exists (already converted to order)
   - requestedItems length must match (no add/remove)
   - product ids must match current (no changing products)
   - qty/unitPrice/extraFee/deliveryCharge MUST allow 0
   - qty/unitPrice/extraFee/deliveryCharge MUST reject "" / null (no silent coercion to 0)
   ========================= */
export const updateQuoteByAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const quote = await Quote.findById(id);
  if (!quote) {
    res.status(404);
    throw new Error("Quote not found");
  }

  // ✅ HARD LOCK (matches admin UI + business logic)
  if (quote.order) {
    res.status(409);
    throw new Error("Quote is locked because an order already exists for it.");
  }

  const {
    user,
    requestedItems,
    deliveryCharge,
    extraFee,
    adminToAdminNote,
    adminToClientNote,
    status,
  } = req.body || {};

  /* -------------------------
     Step 1: user (optional update)
     ------------------------- */
  if (user !== undefined) {
    const uid = String(user || "");
    if (!uid) {
      res.status(400);
      throw new Error("User is required");
    }
    if (!mongoose.Types.ObjectId.isValid(uid)) {
      res.status(400);
      throw new Error("Invalid user id");
    }
    quote.user = uid;
  }

  /* -------------------------
     Step 2: items (qty + unitPrice only)
     - No add/remove
     - No product swap
     - Allow 0 values
     - Reject "", null, undefined (avoid Number("") === 0)
     ------------------------- */
  if (requestedItems !== undefined) {
    if (!Array.isArray(requestedItems) || requestedItems.length === 0) {
      res.status(400);
      throw new Error("Quote must contain at least one item.");
    }

    const current = quote.requestedItems || [];

    // ✅ Prevent add/remove from this endpoint (UI is qty/unitPrice only)
    if (requestedItems.length !== current.length) {
      res.status(400);
      throw new Error(
        "You can only edit qty/unitPrice. Adding/removing items is not allowed."
      );
    }

    const nextRequestedItems = requestedItems.map((it, idx) => {
      const currentProductId = String(current[idx]?.product || "");
      const incomingProductId = String(it?.product || "");

      if (
        !incomingProductId ||
        !mongoose.Types.ObjectId.isValid(incomingProductId)
      ) {
        res.status(400);
        throw new Error(`Invalid product id for item #${idx + 1}`);
      }

      // ✅ Must match existing product (no changing the item identity)
      if (incomingProductId !== currentProductId) {
        res.status(400);
        throw new Error(
          `Item #${idx + 1} product cannot be changed. Only qty/unitPrice are editable.`
        );
      }

      // ✅ qty: allow 0, reject "", null, undefined
      const rawQty = it?.qty;
      if (rawQty === "" || rawQty === null || rawQty === undefined) {
        res.status(400);
        throw new Error(`Invalid qty for item #${idx + 1}. Must be >= 0.`);
      }
      const qty = Number(rawQty);
      if (!Number.isFinite(qty) || qty < 0) {
        res.status(400);
        throw new Error(`Invalid qty for item #${idx + 1}. Must be >= 0.`);
      }

      // ✅ unitPrice: allow 0, reject "", null, undefined
      const rawUnitPrice = it?.unitPrice;
      if (
        rawUnitPrice === "" ||
        rawUnitPrice === null ||
        rawUnitPrice === undefined
      ) {
        res.status(400);
        throw new Error(
          `Invalid unitPrice for item #${idx + 1}. Must be >= 0.`
        );
      }
      const unitPrice = Number(rawUnitPrice);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        res.status(400);
        throw new Error(
          `Invalid unitPrice for item #${idx + 1}. Must be >= 0.`
        );
      }

      return {
        product: incomingProductId,
        qty,
        unitPrice,
      };
    });

    quote.requestedItems = nextRequestedItems;
  }

  /* -------------------------
     Charges (optional update)
     - Allow 0 values
     - Reject "", null (avoid Number("") === 0)
     ------------------------- */
  if (deliveryCharge !== undefined) {
    const raw = deliveryCharge;

    if (raw === "" || raw === null) {
      res.status(400);
      throw new Error("Invalid deliveryCharge. Must be >= 0.");
    }

    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      res.status(400);
      throw new Error("Invalid deliveryCharge. Must be >= 0.");
    }

    quote.deliveryCharge = n;
  }

  if (extraFee !== undefined) {
    const raw = extraFee;

    if (raw === "" || raw === null) {
      res.status(400);
      throw new Error("Invalid extraFee. Must be >= 0.");
    }

    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      res.status(400);
      throw new Error("Invalid extraFee. Must be >= 0.");
    }

    quote.extraFee = n;
  }

  /* -------------------------
     Step 3: notes (optional)
     ------------------------- */
  if (adminToAdminNote !== undefined)
    quote.adminToAdminNote = String(adminToAdminNote || "");
  if (adminToClientNote !== undefined)
    quote.adminToClientNote = String(adminToClientNote || "");

  /* -------------------------
     Step 4: status (optional update)
     ------------------------- */
  if (status !== undefined) {
    const allowed = ["Processing", "Quoted", "Confirmed", "Cancelled"];
    if (!allowed.includes(status)) {
      res.status(400);
      throw new Error(`Invalid status. Allowed: ${allowed.join(", ")}`);
    }
    quote.status = status;
  }

  // ✅ totals recomputed by Quote pre("save")
  await quote.save();

  // ✅ return populated doc for the steps UI
  const populated = await Quote.findById(quote._id)
    .populate("user", "name email phoneNumber")
    .populate("requestedItems.product", "sku name")
    .populate("order", "orderNumber");

  res.status(200).json({
    success: true,
    message: "Quote updated successfully.",
    data: populated,
  });
});




