// controllers/quoteController.js
import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import Quote from "../models/quoteModel.js";
import { chromium } from "playwright";
import { renderQuoteHtml, quoteFooterTemplate } from "../utils/quoteTemplate.js";
import sendTelegramAlert from "../utils/sendTelegramAlert.js";
import Product from "../models/productModel.js";
import UserPrice from "../models/userPriceModel.js";
import PriceRule from "../models/priceRuleModel.js";
import User from "../models/userModel.js";
import SlotItem from "../models/slotItemModel.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import { getAvailabilityTotalsByProduct, getAvailabilityStatus } from "../utils/quoteAvailability.js";

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

const escapeTelegramMarkdown = (text = "") =>
  String(text)
    .replace(/\\/g, "\\\\")
    .replace(/_/g, "\\_")
    .replace(/\*/g, "\\*")
    .replace(/\[/g, "\\[")
    .replace(/]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/`/g, "\\`");

const formatUnits = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : String(n);
};

const buildSkuSummary = (items = [], productMetaMap) =>
  (items || []).map((it) => {
    const qty = Math.max(0, Number(it?.qty) || 0);
    const productId = it?.product;
    const meta = productMetaMap.get(String(productId));
    const sku = meta?.sku ? String(meta.sku) : "Unknown SKU";
    return `- ${escapeTelegramMarkdown(sku)} x ${formatUnits(qty)}`;
  });

const buildProductTypeSummary = (items = [], productMetaMap) => {
  const stats = new Map();
  let totalItems = 0;
  let totalUnits = 0;

  for (const it of items) {
    totalItems += 1;
    const qty = Math.max(0, Number(it?.qty) || 0);
    totalUnits += qty;

    const productId = it?.product;
    const meta = productMetaMap.get(String(productId));
    const type = meta?.productType ? String(meta.productType) : "Unknown";

    const current = stats.get(type) || { lineItems: 0, units: 0 };
    current.lineItems += 1;
    current.units += qty;
    stats.set(type, current);
  }

  const lines = Array.from(stats.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([type, summary]) =>
        `${escapeTelegramMarkdown(type)}: ${summary.lineItems} items, ${formatUnits(
          summary.units
        )} units`
    );

  const fallbackLine = `Items: ${totalItems}, Units: ${formatUnits(totalUnits)}`;
  return { lines, fallbackLine };
};

const buildProductMetaMap = async (items = []) => {
  const productIds = Array.from(
    new Set(
      (items || [])
        .map((it) => it?.product?._id || it?.product)
        .filter(Boolean)
        .map((id) => String(id))
    )
  );

  if (!productIds.length) return new Map();

  const products = await Product.find(
    { _id: { $in: productIds } },
    { _id: 1, productType: 1 }
  ).lean();

  return new Map(
    products.map((p) => [
      String(p._id),
      { productType: p.productType },
    ])
  );
};

const normalizeAvailabilityStatus = (status) =>
  status === "PARTIAL" ? "SHORTAGE" : status;

const hasAvailabilityShortage = (items = []) =>
  items.some((it) => {
    const status = normalizeAvailabilityStatus(it?.availabilityStatus);
    if (status === "SHORTAGE" || status === "NOT_AVAILABLE") return true;

    const qty = Math.max(0, Number(it?.qty) || 0);
    const shortage = Number(it?.shortage);
    if (Number.isFinite(shortage) && shortage > 0) return true;

    const availableNow = Number(it?.availableNow);
    if (Number.isFinite(availableNow) && availableNow < qty) return true;

    return false;
  });

async function applyPdfMedia(page) {
  if (typeof page.emulateMediaType === "function") {
    await page.emulateMediaType("screen");
  } else if (typeof page.emulateMedia === "function") {
    await page.emulateMedia({ media: "screen" });
  }
}

const hasAnyAvailability = (items = []) =>
  items.some((it) => {
    const status = normalizeAvailabilityStatus(it?.availabilityStatus);
    if (status === "AVAILABLE" || status === "SHORTAGE") return true;

    const availableNow = Number(it?.availableNow);
    if (Number.isFinite(availableNow) && availableNow > 0) return true;

    return false;
  });

const buildAcceptedShortageItems = (items, totalsMap) => {
  let hasShortage = false;

  const updatedItems = items.map((it) => {
    const productId = it.product?._id || it.product;
    const availableNow = totalsMap.get(String(productId)) || 0;
    const currentQty = Math.max(0, Number(it.qty) || 0);
    const currentShortage = Math.max(0, currentQty - availableNow);

    if (currentShortage > 0) {
      hasShortage = true;
    }

    const nextQty = Math.min(currentQty, availableNow);
    const nextShortage = Math.max(0, nextQty - availableNow);
    const nextStatus = getAvailabilityStatus(nextQty, availableNow);

    return {
      product: productId,
      qty: nextQty,
      priceRule: null,
      unitPrice: Math.max(0, Number(it.unitPrice) || 0),
      availableNow,
      shortage: nextShortage,
      availabilityStatus: nextStatus,
    };
  });

  return { updatedItems, hasShortage };
};

/* =========================
   Helper: sanitize quote for OWNER views based on status
   ========================= */
const sanitizeQuoteForOwner = (quoteDoc) => {
  const obj = quoteDoc.toObject ? quoteDoc.toObject() : { ...quoteDoc };
  const status = obj.status;

  const getShortage = (it) => {
    const qty = Number(it?.qty) || 0;
    const availableNow = Number(it?.availableNow) || 0;
    const rawShortage = Number(it?.shortage);
    if (Number.isFinite(rawShortage)) return Math.max(0, rawShortage);
    return Math.max(0, qty - availableNow);
  };

  const mapOwnerItem = (it, includeUnitPrice) => {
    const shortage = getShortage(it);
    const availableNow = Number(it?.availableNow);
    const base = {
      product: it.product,
      productName: it.productName || it.product?.name || "",
      qty: it.qty,
      ...(includeUnitPrice ? { unitPrice: it.unitPrice } : {}),
      availableNow: Number.isFinite(availableNow) ? availableNow : 0,
      shortage,
      availabilityStatus: normalizeAvailabilityStatus(it.availabilityStatus),
    };
    return base;
  };

  const mapItemBasic = (it) => ({
    product: it.product,
    productName: it.productName || it.product?.name || "",
    qty: it.qty,
  });

  const stripAllPricing = () => {
    // remove unit prices from items
    obj.requestedItems = (obj.requestedItems || []).map((it) =>
      mapOwnerItem(it, false)
    );
    delete obj.deliveryCharge;
    delete obj.extraFee;
    delete obj.totalPrice;
  };

  const keepFullPricing = () => {
    obj.requestedItems = (obj.requestedItems || []).map((it) =>
      mapOwnerItem(it, true)
    );
  };

  const keepOnlyTotal = () => {
    // keep items but remove unit pricing and fees; keep totalPrice only
    obj.requestedItems = (obj.requestedItems || []).map((it) =>
      mapOwnerItem(it, false)
    );
    delete obj.deliveryCharge;
    delete obj.extraFee;
    // totalPrice stays
  };

  const stripAllPricingAndAvailability = () => {
    obj.requestedItems = (obj.requestedItems || []).map((it) =>
      mapItemBasic(it)
    );
    delete obj.deliveryCharge;
    delete obj.extraFee;
    delete obj.totalPrice;
    delete obj.availabilityCheckedAt;
  };

  if (status === "Processing") {
    stripAllPricing();
    return obj;
  }

  if (status === "Quoted") {
    // show full pricing (availability only if shortage)
    keepFullPricing();
    return obj;
  }

  if (status === "Confirmed") {
    keepOnlyTotal();
    return obj;
  }

  if (status === "Cancelled") {
    stripAllPricingAndAvailability();
    return obj;
  }

  // default fallback: be conservative
  stripAllPricingAndAvailability();
  return obj;
};

const normalizeAvailabilityInQuote = (quoteDoc) => {
  const obj = quoteDoc.toObject ? quoteDoc.toObject() : { ...quoteDoc };
  obj.requestedItems = (obj.requestedItems || []).map((it) => ({
    ...it,
    availabilityStatus: normalizeAvailabilityStatus(it.availabilityStatus),
  }));
  return obj;
};

const sanitizeAvailabilityForCancelled = (quoteDoc) => {
  const obj = quoteDoc.toObject ? quoteDoc.toObject() : { ...quoteDoc };
  if (obj.status !== "Cancelled") return obj;

  obj.requestedItems = (obj.requestedItems || []).map((it) => ({
    product: it.product,
    productName: it.productName || it.product?.name || "",
    qty: it.qty,
  }));
  delete obj.availabilityCheckedAt;

  return obj;
};

const throwHttpError = (res, status, message) => {
  res.status(status);
  throw new Error(message);
};

const ensureQuoteEditable = (res, quote) => {
  if (quote.order) {
    throwHttpError(
      res,
      409,
      "Quote is locked because an order already exists for it."
    );
  }
  if (quote.manualInvoiceId) {
    throwHttpError(
      res,
      409,
      "Quote is locked because a manual invoice was created."
    );
  }
};

const parseNonNegativeNumber = (res, raw, message) => {
  if (raw === "" || raw === null || raw === undefined) {
    throwHttpError(res, 400, message);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throwHttpError(res, 400, message);
  }
  return n;
};

const buildIncomingItemsMap = (
  res,
  requestedItems,
  currentItems,
  missingMessage
) => {
  if (!Array.isArray(requestedItems) || requestedItems.length === 0) {
    throwHttpError(res, 400, "Quote must contain at least one item.");
  }

  if (!Array.isArray(currentItems) || currentItems.length === 0) {
    throwHttpError(res, 400, "Quote has no items.");
  }

  const currentById = new Map(
    currentItems.map((it) => [String(it.product), it])
  );
  const incomingById = new Map();

  for (const it of requestedItems) {
    if (!it || !it.product) {
      throwHttpError(res, 400, "Each item must include a product id.");
    }

    const productId = String(it.product);
    if (!mongoose.Types.ObjectId.isValid(productId)) {
      throwHttpError(res, 400, "Invalid product in requested items.");
    }

    if (!currentById.has(productId)) {
      throwHttpError(res, 400, "You cannot add new products to the quote.");
    }

    if (incomingById.has(productId)) {
      throwHttpError(res, 400, "Duplicate product in requested items.");
    }

    incomingById.set(productId, it);
  }

  if (incomingById.size !== currentById.size) {
    throwHttpError(
      res,
      400,
      missingMessage || "All quote items must be included when updating."
    );
  }

  return { currentById, incomingById };
};

const populateAdminQuote = (quoteId) =>
  Quote.findById(quoteId)
    .populate("user", "name email phoneNumber")
    .populate("requestedItems.product", "sku name priceRule")
    .populate("order", "orderNumber");


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

  // Sanitize: qty can be 0 in your schema
  const safeItems = requestedItems.map((it) => {
    const qty = Math.max(0, Number(it.qty) || 0);
    return {
      product: it.product,
      qty,
      unitPrice: 0,

      // Snapshot defaults (will be overwritten)
      availableNow: 0,
      shortage: 0,
      availabilityStatus: "NOT_AVAILABLE",
    };
  });

  // Validate product ids early (optional but recommended)
  const seenProducts = new Set();
  for (const it of safeItems) {
    if (!mongoose.Types.ObjectId.isValid(it.product)) {
      res.status(400);
      throw new Error("Invalid product in requested items.");
    }
    const key = String(it.product);
    if (seenProducts.has(key)) {
      res.status(400);
      throw new Error("Duplicate product in requested items.");
    }
    seenProducts.add(key);
  }

  const productIds = safeItems.map((it) => it.product);

  const products = await Product.find(
    { _id: { $in: productIds } },
    { _id: 1, name: 1, productType: 1, sku: 1 }
  ).lean();
  const productMetaMap = new Map(
    products.map((p) => [
      String(p._id),
      { name: p.name, productType: p.productType, sku: p.sku },
    ])
  );

  for (const it of safeItems) {
    it.productName = productMetaMap.get(String(it.product))?.name || "";
  }

  // Compute availability snapshot (single aggregation for all products)
  const totalsMap = await getAvailabilityTotalsByProduct(productIds);

  for (const it of safeItems) {
    const availableNow = totalsMap.get(String(it.product)) || 0;
    it.availableNow = availableNow;
    it.shortage = Math.max(0, it.qty - availableNow);
    it.availabilityStatus = getAvailabilityStatus(it.qty, availableNow);
  }

  const now = new Date();

  // Create quote with snapshot embedded (ONE write)
  const quote = await Quote.create({
    user: req.user._id,
    requestedItems: safeItems,
    clientToAdminNote,
    availabilityCheckedAt: now,
  });

  const populated = await quote.populate({
    path: "requestedItems.product",
    select: "sku name",
  });
  const sanitized = sanitizeQuoteForOwner(populated);

  const skuLines = buildSkuSummary(safeItems, productMetaMap);
  const { lines: productTypeLines, fallbackLine } = buildProductTypeSummary(
    safeItems,
    productMetaMap
  );
  const messageLines = ["🟣 Quote requested"];
  const pushBlankLine = () => {
    if (messageLines.length === 0) return;
    if (messageLines[messageLines.length - 1] !== "") {
      messageLines.push("");
    }
  };
  const pushSection = (title, lines) => {
    if (!lines || lines.length === 0) return;
    pushBlankLine();
    messageLines.push(title);
    messageLines.push(...lines);
    pushBlankLine();
  };
  const addLine = (label, value) => {
    const cleaned = String(value || "").trim();
    if (!cleaned) return;
    messageLines.push(`${label}: ${escapeTelegramMarkdown(cleaned)}`);
  };

  addLine("Quote #", quote.quoteNumber || quote._id);
  addLine("Customer", req.user?.name);
  addLine("Email", req.user?.email);
  addLine("Phone", req.user?.phoneNumber);

  const note = String(clientToAdminNote || "").trim();
  if (note) {
    addLine("Note", note);
  }

  const summaryLines =
    productTypeLines.length > 0 ? productTypeLines : [fallbackLine];
  pushSection("Summary:", summaryLines);
  if (skuLines.length > 0) {
    pushSection("Items:", skuLines);
  }

  const frontendBaseUrl = String(
    process.env.FRONTEND_URL || "https://www.megadie.com"
  ).replace(/\/$/, "");
  const quoteUrl = `${frontendBaseUrl}/admin/requests/${quote._id}`;
  pushBlankLine();
  messageLines.push(quoteUrl);

  void sendTelegramAlert(messageLines.join("\n"));

  res.setHeader("Location", `/api/quotes/${quote._id}`);

  res.status(201).json({
    success: true,
    message: "Quote created successfully.",
    data: sanitized,
  });
});

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

  if (quote.order) {
    res.status(409);
    throw new Error("Quote already has an order and cannot be cancelled.");
  }
  if (quote.manualInvoiceId) {
    res.status(409);
    throw new Error("Manual invoice created — quote locked.");
  }

  if (!["Processing", "Quoted"].includes(quote.status)) {
    res.status(409);
    throw new Error("Only Processing or Quoted quotes can be cancelled.");
  }

  const previousStatus = quote.status;
  quote.status = "Cancelled";
  const updated = await quote.save();
  const sanitized = sanitizeQuoteForOwner(updated);

  const itemsForSummary = updated.requestedItems || [];
  const productMetaMap = await buildProductMetaMap(itemsForSummary);
  const { lines: productTypeLines, fallbackLine } = buildProductTypeSummary(
    itemsForSummary,
    productMetaMap
  );
  const messageLines = ["🔴 Quote cancelled"];
  const addLine = (label, value) => {
    const cleaned = String(value || "").trim();
    if (!cleaned) return;
    messageLines.push(`${label}: ${escapeTelegramMarkdown(cleaned)}`);
  };

  addLine("Quote #", updated.quoteNumber || updated._id);
  addLine("Customer", req.user?.name);
  addLine("Email", req.user?.email);
  addLine("Phone", req.user?.phoneNumber);
  addLine("Prev status", previousStatus);

  if (productTypeLines.length > 0) {
    messageLines.push("Product types:");
    messageLines.push(...productTypeLines);
  } else {
    messageLines.push(fallbackLine);
  }

  const frontendBaseUrl = String(
    process.env.FRONTEND_URL || "https://www.megadie.com"
  ).replace(/\/$/, "");
  const quoteUrl = `${frontendBaseUrl}/admin/requests/${updated._id}`;
  messageLines.push("");
  messageLines.push(quoteUrl);

  void sendTelegramAlert(messageLines.join("\n"));

  res.status(200).json({
    success: true,
    message: "Quote cancelled successfully.",
    data: sanitized,
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

  if (quote.status !== "Quoted") {
    res.status(409);
    throw new Error("Only Quoted quotes can be confirmed.");
  }
  if (quote.manualInvoiceId) {
    res.status(409);
    throw new Error("Manual invoice created — quote locked.");
  }

  const items = quote.requestedItems || [];
  if (hasAvailabilityShortage(items)) {
    res.status(409);
    throw new Error(
      "Cannot confirm while there is a shortage. Please accept the shortage or update quantities."
    );
  }

  quote.status = "Confirmed";
  const updated = await quote.save();
  const sanitized = sanitizeQuoteForOwner(updated);

  const itemsForSummary = updated.requestedItems || [];
  const productMetaMap = await buildProductMetaMap(itemsForSummary);
  const { lines: productTypeLines, fallbackLine } = buildProductTypeSummary(
    itemsForSummary,
    productMetaMap
  );
  const messageLines = ["🟢 Quote confirmed"];
  const addLine = (label, value) => {
    const cleaned = String(value || "").trim();
    if (!cleaned) return;
    messageLines.push(`${label}: ${escapeTelegramMarkdown(cleaned)}`);
  };

  addLine("Quote #", updated.quoteNumber || updated._id);
  addLine("Customer", req.user?.name);
  addLine("Email", req.user?.email);
  addLine("Phone", req.user?.phoneNumber);

  if (productTypeLines.length > 0) {
    messageLines.push("Product types:");
    messageLines.push(...productTypeLines);
  } else {
    messageLines.push(fallbackLine);
  }

  const frontendBaseUrl = String(
    process.env.FRONTEND_URL || "https://www.megadie.com"
  ).replace(/\/$/, "");
  const quoteUrl = `${frontendBaseUrl}/admin/requests/${updated._id}`;
  messageLines.push("");
  messageLines.push(quoteUrl);

  void sendTelegramAlert(messageLines.join("\n"));

  res.status(200).json({
    success: true,
    message: "Quote confirmed successfully.",
    data: sanitized,
  });
});

/* =========================
   PUT /api/quotes/:id/update-quantities
   Private (Owner)
   Update quantities while Processing (capped by availability)
   ========================= */
export const updateQuoteQuantitiesByUser = asyncHandler(async (req, res) => {
  const quote = await Quote.findById(req.params.id);

  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  // Owner check
  const isOwner = String(quote.user) === String(req.user._id);
  if (!isOwner) {
    res.status(403);
    throw new Error("Not authorized to update this quote.");
  }

  if (!["Processing", "Quoted"].includes(quote.status)) {
    res.status(409);
    throw new Error("Quantities can only be updated while Processing or Quoted.");
  }

  if (quote.order) {
    res.status(409);
    throw new Error("Quote already has an order.");
  }
  if (quote.manualInvoiceId) {
    res.status(409);
    throw new Error("Manual invoice created — quote locked.");
  }

  if (quote.clientQtyEditLocked) {
    res.status(409);
    throw new Error("Quantities are locked for this quote.");
  }

  const { requestedItems } = req.body || {};
  if (!Array.isArray(requestedItems) || requestedItems.length === 0) {
    res.status(400);
    throw new Error("Quote must contain at least one item.");
  }

  const currentItems = quote.requestedItems || [];
  if (!currentItems.length) {
    res.status(400);
    throw new Error("Quote has no items.");
  }

  const currentById = new Map(
    currentItems.map((it) => [String(it.product), it])
  );
  const incomingById = new Map();

  for (const it of requestedItems) {
    if (!it || !it.product) {
      res.status(400);
      throw new Error("Each item must include a product id.");
    }

    const productId = String(it.product);
    if (!mongoose.Types.ObjectId.isValid(productId)) {
      res.status(400);
      throw new Error("Invalid product in requested items.");
    }

    if (!currentById.has(productId)) {
      res.status(400);
      throw new Error("You cannot add new products to the quote.");
    }

    if (incomingById.has(productId)) {
      res.status(400);
      throw new Error("Duplicate product in requested items.");
    }

    const rawQty = it.qty;
    if (rawQty === "" || rawQty === null || rawQty === undefined) {
      res.status(400);
      throw new Error("Each item must include a quantity.");
    }

    const qty = Number(rawQty);
    if (!Number.isFinite(qty) || qty < 0) {
      res.status(400);
      throw new Error("Quantity must be a non-negative number.");
    }

    incomingById.set(productId, { ...it, qty });
  }

  if (incomingById.size !== currentById.size) {
    res.status(400);
    throw new Error("All quote items must be included when updating quantities.");
  }

  const productIds = [...currentById.keys()];
  const totalsMap = await getAvailabilityTotalsByProduct(productIds);

  const updatedItems = currentItems.map((existing) => {
    const productId = String(existing.product);
    const incoming = incomingById.get(productId);
    const availableNow = totalsMap.get(productId) || 0;
    const nextQty = Math.min(Math.max(0, Number(incoming.qty) || 0), availableNow);
    const nextShortage = Math.max(0, nextQty - availableNow);
    const nextStatus = getAvailabilityStatus(nextQty, availableNow);

    return {
      product: existing.product,
      productName: existing.productName || existing.product?.name || "",
      qty: nextQty,
      priceRule: null,
      unitPrice: Math.max(0, Number(existing.unitPrice) || 0),
      availableNow,
      shortage: nextShortage,
      availabilityStatus: nextStatus,
    };
  });

  const filteredItems = updatedItems.filter((it) => Number(it.qty) > 0);
  if (!filteredItems.length) {
    res.status(409);
    throw new Error("At least one item must remain in the quote.");
  }

  quote.requestedItems = filteredItems;
  quote.availabilityCheckedAt = new Date();
  quote.clientQtyEditLocked = true;

  await quote.save();

  const populated = await Quote.findById(quote._id).populate(
    "requestedItems.product",
    "sku name"
  );
  const sanitized = sanitizeQuoteForOwner(populated);

  res.status(200).json({
    success: true,
    message: "Quantities updated.",
    data: sanitized,
  });
});

/* =========================
   PUT /api/quotes/admin/:id/owner
   Private/Admin
   Update quote owner only
   ========================= */
export const updateQuoteOwnerByAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const quote = await Quote.findById(id);

  if (!quote) {
    res.status(404);
    throw new Error("Quote not found");
  }

  ensureQuoteEditable(res, quote);

  const uid = String(req.body?.user || "");
  if (!uid) {
    throwHttpError(res, 400, "User is required");
  }
  if (!mongoose.Types.ObjectId.isValid(uid)) {
    throwHttpError(res, 400, "Invalid user id");
  }

  quote.user = uid;
  await quote.save();

  const populated = await populateAdminQuote(quote._id);
  res.status(200).json({
    success: true,
    message: "Owner updated.",
    data: populated,
  });
});

/* =========================
   PUT /api/quotes/admin/:id/quantities
   Private/Admin
   Update quantities only (capped by availability)
   ========================= */
export const updateQuoteQuantitiesByAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const quote = await Quote.findById(id);

  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  ensureQuoteEditable(res, quote);

  const { requestedItems } = req.body || {};
  const currentItems = quote.requestedItems || [];
  const { incomingById } = buildIncomingItemsMap(
    res,
    requestedItems,
    currentItems,
    "All quote items must be included when updating quantities."
  );

  const productIds = currentItems.map((it) => String(it.product));
  const totalsMap = await getAvailabilityTotalsByProduct(productIds);

  const updatedItems = currentItems.map((existing, idx) => {
    const productId = String(existing.product);
    const incoming = incomingById.get(productId);
    const qty = parseNonNegativeNumber(
      res,
      incoming?.qty,
      `Invalid qty for item #${idx + 1}. Must be >= 0.`
    );
    const availableNow = totalsMap.get(productId) || 0;
    const nextQty = Math.min(Math.max(0, qty), availableNow);
    const nextShortage = Math.max(0, nextQty - availableNow);
    const nextStatus = getAvailabilityStatus(nextQty, availableNow);

    return {
      product: existing.product,
      productName: existing.productName || existing.product?.name || "",
      qty: nextQty,
      priceRule: null,
      unitPrice: Math.max(0, Number(existing.unitPrice) || 0),
      availableNow,
      shortage: nextShortage,
      availabilityStatus: nextStatus,
    };
  });

  const filteredItems = updatedItems.filter((it) => Number(it.qty) > 0);
  if (!filteredItems.length) {
    throwHttpError(res, 409, "At least one item must remain in the quote.");
  }

  quote.requestedItems = filteredItems;
  quote.availabilityCheckedAt = new Date();

  await quote.save();

  const populated = await populateAdminQuote(quote._id);
  res.status(200).json({
    success: true,
    message: "Quantities updated.",
    data: populated,
  });
});

/* =========================
   PUT /api/quotes/admin/:id/pricing
   Private/Admin
   Update pricing only (unit prices + charges)
   ========================= */
export const updateQuotePricingByAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const quote = await Quote.findById(id);

  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  ensureQuoteEditable(res, quote);

  const { requestedItems, deliveryCharge, extraFee } = req.body || {};
  const currentItems = quote.requestedItems || [];
  const { incomingById } = buildIncomingItemsMap(
    res,
    requestedItems,
    currentItems,
    "All quote items must be included when updating pricing."
  );

  const updatedItems = currentItems.map((existing, idx) => {
    const productId = String(existing.product);
    const incoming = incomingById.get(productId);
    const unitPrice = parseNonNegativeNumber(
      res,
      incoming?.unitPrice,
      `Invalid unitPrice for item #${idx + 1}. Must be >= 0.`
    );

    return {
      product: existing.product,
      productName: existing.productName || existing.product?.name || "",
      qty: Math.max(0, Number(existing.qty) || 0),
      priceRule: null,
      unitPrice,
      availableNow: Math.max(0, Number(existing.availableNow) || 0),
      shortage: Math.max(0, Number(existing.shortage) || 0),
      availabilityStatus: existing.availabilityStatus || "NOT_AVAILABLE",
    };
  });

  if (deliveryCharge !== undefined) {
    quote.deliveryCharge = parseNonNegativeNumber(
      res,
      deliveryCharge,
      "Invalid deliveryCharge. Must be >= 0."
    );
  }

  if (extraFee !== undefined) {
    quote.extraFee = parseNonNegativeNumber(
      res,
      extraFee,
      "Invalid extraFee. Must be >= 0."
    );
  }

  quote.requestedItems = updatedItems;

  await quote.save();

  const populated = await populateAdminQuote(quote._id);
  res.status(200).json({
    success: true,
    message: "Pricing updated.",
    data: populated,
  });
});

/* =========================
   POST /api/quotes/admin/:id/assign-user-prices
   Private/Admin
   Assign unit prices based on the user's price rules
   ========================= */
export const assignUserPricesByAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const quote = await Quote.findById(id);

  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  ensureQuoteEditable(res, quote);

  const items = quote.requestedItems || [];
  if (!items.length) {
    res.status(400);
    throw new Error("Quote has no items.");
  }

  const productIds = items
    .map((it) => it.product?._id || it.product)
    .filter(Boolean)
    .map((id) => String(id));

  const products = await Product.find({ _id: { $in: productIds } })
    .select("_id priceRule")
    .lean();

  const priceRuleByProduct = new Map(
    products.map((p) => [String(p._id), p.priceRule])
  );

  const missingRules = items.filter((it) => {
    const productId = String(it.product?._id || it.product || "");
    if (!productId) return true;
    return !priceRuleByProduct.get(productId);
  });
  if (missingRules.length) {
    res.status(409);
    throw new Error(
      "Some products are missing price rules. Update the product and try again."
    );
  }

  const priceRules = Array.from(
    new Set(
      productIds
        .map((id) => priceRuleByProduct.get(id))
        .filter(Boolean)
        .map((rule) => String(rule))
    )
  );

  if (!priceRules.length) {
    res.status(400);
    throw new Error("No price rules found on products.");
  }

  const userId = quote.user?._id || quote.user;

  const [userPrices, ruleDefaults] = await Promise.all([
    UserPrice.find({
      user: userId,
      priceRule: { $in: priceRules },
    })
      .select("priceRule unitPrice")
      .lean(),
    PriceRule.find({ code: { $in: priceRules } })
      .select("code defaultPrice")
      .lean(),
  ]);

  const priceByRule = new Map(userPrices.map((p) => [p.priceRule, p.unitPrice]));
  const defaultByRule = new Map(
    ruleDefaults.map((rule) => [rule.code, rule.defaultPrice])
  );

  quote.requestedItems = items.map((it) => {
    const productId = String(it.product?._id || it.product);
    const ruleCode = priceRuleByProduct.get(productId);
    const resolved = ruleCode ? priceByRule.get(ruleCode) : null;
    const fallback = ruleCode ? defaultByRule.get(ruleCode) : null;
    const unitPrice =
      resolved == null
        ? fallback == null
          ? Math.max(0, Number(it.unitPrice) || 0)
          : fallback
        : resolved;

    return {
      product: it.product,
      productName: it.productName || it.product?.name || "",
      qty: Math.max(0, Number(it.qty) || 0),
      priceRule: null,
      unitPrice: Math.max(0, Number(unitPrice) || 0),
      availableNow: Math.max(0, Number(it.availableNow) || 0),
      shortage: Math.max(0, Number(it.shortage) || 0),
      availabilityStatus: it.availabilityStatus || "NOT_AVAILABLE",
    };
  });

  await quote.save();

  const populated = await populateAdminQuote(quote._id);
  res.status(200).json({
    success: true,
    message: "User prices assigned.",
    data: populated,
  });
});

/* =========================
   PUT /api/quotes/admin/:id/notes
   Private/Admin
   Update notes only
   ========================= */
export const updateQuoteNotesByAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const quote = await Quote.findById(id);

  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  ensureQuoteEditable(res, quote);

  const { adminToAdminNote, adminToClientNote } = req.body || {};
  if (adminToAdminNote !== undefined) {
    quote.adminToAdminNote = String(adminToAdminNote || "");
  }
  if (adminToClientNote !== undefined) {
    quote.adminToClientNote = String(adminToClientNote || "");
  }

  await quote.save();

  const populated = await populateAdminQuote(quote._id);
  res.status(200).json({
    success: true,
    message: "Notes updated.",
    data: populated,
  });
});

/* =========================
   PUT /api/quotes/admin/:id/status
   Private/Admin
   Update status only
   ========================= */
export const updateQuoteStatusByAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const quote = await Quote.findById(id);

  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  ensureQuoteEditable(res, quote);

  const { status } = req.body || {};
  if (!status) {
    throwHttpError(res, 400, "Status is required.");
  }
  if (!allowedStatusesSet.has(status)) {
    throwHttpError(
      res,
      400,
      `Invalid status. Allowed: ${ALLOWED_STATUSES.join(", ")}`
    );
  }

  if (status === "Quoted") {
    const items = quote.requestedItems || [];
    if (!items.length) {
      throwHttpError(res, 400, "Quote has no items.");
    }
    if (!hasAnyAvailability(items)) {
      throwHttpError(
        res,
        409,
        "Cannot mark quote as Quoted while no items are available. Recheck availability first."
      );
    }
  }

  if (status === "Confirmed") {
    const items = quote.requestedItems || [];
    if (hasAvailabilityShortage(items)) {
      throwHttpError(
        res,
        409,
        "Cannot confirm while there is a shortage. Please accept the shortage or update quantities."
      );
    }
  }

  quote.status = status;
  await quote.save();

  const populated = await populateAdminQuote(quote._id);
  res.status(200).json({
    success: true,
    message: `Status updated to ${status}.`,
    data: populated,
  });
});

/* =========================
   PUT /api/quotes/admin/:id/recheck-availability
   Private/Admin
   Refresh availability snapshot
   ========================= */
export const recheckQuoteAvailabilityByAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const quote = await Quote.findById(id);

  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  ensureQuoteEditable(res, quote);

  const items = quote.requestedItems || [];
  if (!items.length) {
    res.status(400);
    throw new Error("Quote has no items.");
  }

  const productIds = items.map((it) => it.product?._id || it.product);
  const totalsMap = await getAvailabilityTotalsByProduct(productIds);

  quote.requestedItems = items.map((it) => {
    const productId = it.product?._id || it.product;
    const availableNow = totalsMap.get(String(productId)) || 0;
    const qty = Math.max(0, Number(it.qty) || 0);
    const shortage = Math.max(0, qty - availableNow);
    const nextStatus = getAvailabilityStatus(qty, availableNow);

    return {
      product: it.product,
      productName: it.productName || it.product?.name || "",
      qty,
      priceRule: null,
      unitPrice: Math.max(0, Number(it.unitPrice) || 0),
      availableNow,
      shortage,
      availabilityStatus: nextStatus,
    };
  });

  quote.availabilityCheckedAt = new Date();
  await quote.save();

  const populated = await populateAdminQuote(quote._id);
  res.status(200).json({
    success: true,
    message: "Availability refreshed.",
    data: populated,
  });
});

/* =========================
   GET /api/quotes/admin/:id/stock-check
   Private/Admin
   Returns on-hand and available-after-reserve totals per item
   ========================= */
export const getQuoteStockCheckByAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error("Invalid quote id.");
  }

  const quote = await Quote.findById(id)
    .select("requestedItems")
    .lean();
  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  const rawIds = (quote.requestedItems || [])
    .map((it) => it?.product?._id || it?.product)
    .filter(Boolean)
    .map((value) => String(value))
    .filter((value) => mongoose.Types.ObjectId.isValid(value));
  const uniqueIds = Array.from(new Set(rawIds));
  const productObjectIds = uniqueIds.map(
    (value) => new mongoose.Types.ObjectId(value)
  );

  let onHandRows = [];
  let reservedRows = [];

  if (productObjectIds.length > 0) {
    [onHandRows, reservedRows] = await Promise.all([
      SlotItem.aggregate([
        { $match: { product: { $in: productObjectIds } } },
        { $group: { _id: "$product", onHand: { $sum: "$qty" } } },
      ]),
      OrderAllocation.aggregate([
        {
          $match: {
            product: { $in: productObjectIds },
            $or: [{ status: "Reserved" }, { status: { $exists: false } }],
          },
        },
        { $group: { _id: "$product", reserved: { $sum: "$qty" } } },
      ]),
    ]);
  }

  const onHandByProduct = new Map(
    onHandRows.map((row) => [String(row._id), Number(row.onHand) || 0])
  );
  const reservedByProduct = new Map(
    reservedRows.map((row) => [String(row._id), Number(row.reserved) || 0])
  );

  const items = uniqueIds.map((productId) => {
    const onHand = onHandByProduct.get(productId) || 0;
    const reserved = reservedByProduct.get(productId) || 0;
    const availableAfterReserve = Math.max(0, onHand - reserved);
    return {
      productId,
      onHand,
      reserved,
      availableAfterReserve,
    };
  });

  res.status(200).json({
    success: true,
    message: "Stock check retrieved.",
    data: {
      checkedAt: new Date(),
      items,
    },
  });
});


/* =========================
   PUT /api/quotes/admin/:id/quantities
   Private/Admin
   Update quantities only (capped by availability)
   ========================= */

/* =========================
   PUT /api/quotes/admin/:id/pricing
   Private/Admin
   Update pricing only (unit prices + charges)
   ========================= */

/* =========================
   PUT /api/quotes/admin/:id/notes
   Private/Admin
   Update notes only
   ========================= */

/* =========================
   PUT /api/quotes/admin/:id/status
   Private/Admin
   Update status only
   ========================= */

/* =========================
   GET /api/quotes/my
   Private
   Paginated: newest -> oldest
   Limit capped at 5
   Sanitized by status
   ========================= */
export const getMyQuotes = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

  const limitRaw = parseInt(req.query.limit, 10);
  const limit = Math.min(Math.max(limitRaw || 5, 1), 5);

  const skip = (page - 1) * limit;

  const statusRaw = req.query.status ? String(req.query.status).trim() : "";
  const filter = { user: req.user._id };
  if (statusRaw) {
    if (!allowedStatusesSet.has(statusRaw)) {
      res.status(400);
      throw new Error(`Invalid status. Allowed: ${ALLOWED_STATUSES.join(", ")}`);
    }
    filter.status = statusRaw;
  }
  const sort = { createdAt: -1, _id: -1 };

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
    .populate("requestedItems.product", "name sku code size");

  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  if (quote.status !== "Quoted") {
    res.status(400);
    throw new Error("PDF can only be generated for Quoted requests.");
  }

  const html = renderQuoteHtml({ quote });
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
      footerTemplate: quoteFooterTemplate,
      margin: { top: "18mm", bottom: "22mm", left: "16mm", right: "16mm" },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename=quote-${quote._id}.pdf`
    );
    res.end(pdfBuffer);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

/* =========================
   GET /api/quotes/:id/share
   Private/Admina
   Lightweight payload for sharing (clipboard)
   ========================= */
export const getQuoteShare = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error("Invalid quote id.");
  }

  const quote = await Quote.findById(id)
    .select(
      [
        "quoteNumber",
        "status",
        "createdAt",
        "deliveryCharge",
        "extraFee",
        "totalPrice",
        "requestedItems",
        "user",
      ].join(" ")
    )
    .populate("user", "name email")
    .populate("requestedItems.product", "name");

  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  res.status(200).json({
    success: true,
    message: "Quote share data retrieved.",
    data: quote,
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
   GET /api/quotes/admin?page=1&limit=20&status=Processing&search=abc
   Private/Admin
   Get all quotes (paginated, newest first)
   ========================= */
export const getQuotes = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 20));
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
      .select(
        [
          "quoteNumber",
          "status",
          "createdAt",
          "deliveryCharge",
          "extraFee",
          "totalPrice",
          "availabilityCheckedAt",
          "requestedItems.qty",
          "requestedItems.unitPrice",
          "requestedItems.availableNow",
          "requestedItems.shortage",
          "requestedItems.availabilityStatus",
          "user",
          "order",
          "manualInvoiceId",
          "manualInvoiceCreatedAt",
        ].join(" ")
      )
      .populate("user", "name email")
      // optional: show order number in admin list
      .populate("order", "orderNumber status")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  const sanitized = (quotes || [])
    .map((quote) => normalizeAvailabilityInQuote(quote))
    .map((quote) => sanitizeAvailabilityForCancelled(quote));

  res.status(200).json({
    success: true,
    message: "Quotes retrieved successfully.",
    page,
    pages: totalPages,
    total,
    limit,
    data: sanitized,
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
    .populate("requestedItems.product", "name sku priceRule")
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
    const data =
      quote.status === "Cancelled" ? sanitizeAvailabilityForCancelled(quote) : quote;
    return res.status(200).json({
      success: true,
      message: "Quote retrieved successfully.",
      data,
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
   PUT /api/quotes/admin/:id/quantities
   Private/Admin
   Update quantities only (capped by availability)
   ========================= */

/* =========================
   PUT /api/quotes/admin/:id/pricing
   Private/Admin
   Update pricing only (unit prices + charges)
   ========================= */

/* =========================
   PUT /api/quotes/admin/:id/notes
   Private/Admin
   Update notes only
   ========================= */

/* =========================
   PUT /api/quotes/admin/:id/status
   Private/Admin
   Update status only
   ========================= */









