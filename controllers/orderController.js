import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import Order from "../models/orderModel.js";
import Quote from "../models/quoteModel.js";
import Invoice from "../models/invoiceModel.js";
import Payment from "../models/paymentModel.js";
import Product from "../models/productModel.js";

/* =========================
   Helpers (pagination)
   ========================= */
const parsePagination = (req, { defaultLimit = 20, maxLimit = 100 } = {}) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(
    Math.max(parseInt(req.query.limit, 10) || defaultLimit, 1),
    maxLimit
  );
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

// Remove all pricing fields for client/owner responses
const sanitizeOrderForClient = (order) => {
  if (!order) return order;

  // If it's a mongoose doc, convert safely; if it's already lean, keep as-is
  const o = typeof order.toObject === "function" ? order.toObject() : order;

  // Strip top-level pricing
  delete o.totalPrice;
  delete o.deliveryCharge;
  delete o.extraFee;

  // Strip item pricing
  if (Array.isArray(o.orderItems)) {
    o.orderItems = o.orderItems.map((it) => {
      const item = { ...(it || {}) };
      delete item.unitPrice;
      delete item.lineTotal;
      return item;
    });
  }

  return o;
};

/* =========================
   DELETE /api/orders/:id
   Private/Admin
   Delete order only if status === "Cancelled".
   Cascades: delete dependent invoice + its dependent payments (if any).
   ========================= */
export const deleteOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id).select(
    "_id status invoice"
  );
  if (!order) {
    res.status(404);
    throw new Error("Order not found.");
  }

  if (order.status === "Delivered") {
    res.status(400);
    throw new Error(
      "Delivered orders cannot be deleted. Change status to 'Cancelled' first, then delete."
    );
  }

  if (order.status !== "Cancelled") {
    res.status(409);
    throw new Error(
      "Only 'Cancelled' orders can be deleted. Update status to 'Cancelled' first."
    );
  }

  let paymentsDeleted = 0;
  let invoiceDeleted = false;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (order.invoice) {
        const inv = await Invoice.findById(order.invoice).session(session);
        if (inv) {
          const payDel = await Payment.deleteMany(
            { invoice: inv._id },
            { session }
          );
          paymentsDeleted = payDel.deletedCount || 0;
          await inv.deleteOne({ session });
          invoiceDeleted = true;
        }
      }
      await order.deleteOne({ session });
    });

    res.status(200).json({
      success: true,
      message: invoiceDeleted
        ? `Order deleted successfully. Associated invoice deleted and ${paymentsDeleted} payment(s) removed.`
        : "Order deleted successfully.",
      orderId: order._id,
      invoiceDeleted,
      paymentsDeleted,
    });
  } finally {
    session.endSession();
  }
});

/* =========================
   GET /api/orders/:id
   Private (Owner) or Admin
   Returns a single order by ID
   ========================= */
export const getOrderById = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id)
    .populate("user", "name email")
    .populate("invoice", "invoiceNumber")
    .populate("orderItems.product", "name sku size");

  if (!order) {
    res.status(404);
    throw new Error("Order not found.");
  }

  const isAdmin = !!req.user?.isAdmin;
  const isOwner = String(order.user?._id || order.user) === String(req.user._id);

  if (!isAdmin && !isOwner) {
    res.status(403);
    throw new Error("Not authorized to view this order.");
  }

  // Admin sees full order (unchanged). Owner sees sanitized order (no pricing).
  const payload = isAdmin ? order : sanitizeOrderForClient(order);

  res.status(200).json({
    success: true,
    message: "Order retrieved successfully.",
    data: payload,
  });
});

/* =========================
   GET /api/orders/my
   Private (Owner)
   Paginated list of the authenticated user's orders
   ========================= */
export const getMyOrders = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req, {
    defaultLimit: 5,
    maxLimit: 5,
  });

  const filter = { user: req.user._id };
  const sort = { createdAt: -1, _id: -1 };

  const [total, ordersRaw] = await Promise.all([
    Order.countDocuments(filter),
    Order.find(filter)
      .select(
        "-totalPrice -deliveryCharge -extraFee -orderItems.unitPrice -orderItems.lineTotal"
      )
      .populate("invoice", "invoiceNumber")
      .populate("orderItems.product", "name sku size")
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  const orders = (ordersRaw || []).map(sanitizeOrderForClient);

  res.status(200).json({
    success: true,
    message: "Orders retrieved successfully.",
    data: orders,
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
   GET /api/orders
   Private/Admin
   Paginated list of orders with optional filters
   Query: status, user
   ========================= */
export const getOrders = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req, {
    defaultLimit: 10,
    maxLimit: 20,
  });

  const filter = {};
  if (req.query.status) filter.status = req.query.status;

  if (req.query.user) {
    if (!mongoose.isValidObjectId(req.query.user)) {
      res.status(400);
      throw new Error("Invalid user id.");
    }
    filter.user = req.query.user;
  }

  const sort = { createdAt: -1, _id: -1 };

  const [total, orders] = await Promise.all([
    Order.countDocuments(filter),
    Order.find(filter)
      .populate("user", "name email")
      // ✅ populate invoice number for UI
      .populate("invoice", "invoiceNumber")
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  const totalPages = Math.max(Math.ceil(total / limit), 1);

  res.status(200).json({
    success: true,
    message: "Orders retrieved successfully.",
    data: orders,
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
   POST /api/orders/from-quote/:quoteId
   Private/Admin
   Create an order from a Confirmed quote
   ========================= */
export const createOrderFromQuote = asyncHandler(async (req, res) => {
  const { quoteId } = req.params;

  // -------------------------
  // 1. Load quote
  // -------------------------
  const quote = await Quote.findById(quoteId).lean(false);
  if (!quote) {
    res.status(404);
    throw new Error("Quote not found.");
  }

  // -------------------------
  // 2. Business rules
  // -------------------------
  if (quote.status !== "Confirmed") {
    res.status(400);
    throw new Error("Only Confirmed quotes can be converted to orders.");
  }

  if (quote.order) {
    res.status(409);
    throw new Error("An order has already been created for this quote.");
  }

  // -------------------------
  // 3. Resolve product SKUs (snapshot)
  // -------------------------
  const productIds = quote.requestedItems.map((it) => it.product);

  const products = await Product.find(
    { _id: { $in: productIds } },
    { _id: 1, sku: 1 }
  ).lean();

  const skuMap = new Map(
    products.map((p) => [String(p._id), p.sku])
  );

  // -------------------------
  // 4. Map quote items → order items
  // qty = 0 is allowed by business rules
  // -------------------------
  const orderItems = quote.requestedItems.map((it) => ({
    product: it.product,
    sku: skuMap.get(String(it.product)) || "",
    qty: it.qty,
    unitPrice: it.unitPrice,
  }));

  // -------------------------
  // 5. Transaction (order + quote link)
  // -------------------------
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Create order
    const order = await Order.create(
      [
        {
          user: quote.user,           // always trust quote.user
          quote: quote._id,            // link quote → order
          orderItems,
          deliveryCharge: quote.deliveryCharge,
          extraFee: quote.extraFee,
          status: "Processing",
        },
      ],
      { session }
    );

    // Link quote → order
    quote.order = order[0]._id;
    await quote.save({ session });

    await session.commitTransaction();
    session.endSession();

    res.status(201).json(order[0]);
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err; // handled by error middleware
  }
});

/* =========================
   PUT /api/orders/:id
   Private/Admin
   Update allowed top-level fields; orderItems are immutable
   ========================= */
export const updateOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) {
    res.status(404);
    throw new Error("Order not found.");
  }

  // ❌ Order items are never editable after creation
  if (Object.prototype.hasOwnProperty.call(req.body, "orderItems")) {
    res.status(400);
    throw new Error(
      "Order items are immutable after creation and cannot be modified."
    );
  }

  const hasInvoice = !!order.invoice;

  // 🔒 If an invoice exists, lock financial fields and user
  if (hasInvoice) {
    const forbiddenIfInvoiced = [
      "deliveryCharge",
      "extraFee",
      "totalPrice",
      "user",
    ];

    const triedForbidden = Object.keys(req.body || {}).filter((k) =>
      forbiddenIfInvoiced.includes(k)
    );

    if (triedForbidden.length > 0) {
      res.status(400);
      throw new Error(
        `Cannot modify ${triedForbidden.join(
          ", "
        )} because an invoice already exists for this order. ` +
          `If you truly need to change pricing or customer, first delete the linked invoice ` +
          `(/api/invoices/:id), which will also delete its payments, then update the order and recreate the invoice.`
      );
    }
  }

  const prevStatus = order.status;
  const nextStatus = req.body.status ?? prevStatus;

  // Delivered stamp (first time)
  if (nextStatus === "Delivered" && !order.deliveredAt) {
    order.deliveredAt = new Date();
  }

  // Delivered → Cancelled : clear stamp (optional)
  if (prevStatus === "Delivered" && nextStatus === "Cancelled") {
    order.deliveredAt = null;
  }

  const allowedTopLevel = new Set([
    "user", // allowed unless invoice exists (guarded above)
    "status",
    "deliveryCharge", // allowed unless invoice exists (guarded above)
    "extraFee", // allowed unless invoice exists (guarded above)
    "deliveredBy",
    "clientToAdminNote",
    "adminToAdminNote",
    "adminToClientNote",
    "stockUpdated",
  ]);

  const changes = {};
  for (const k of Object.keys(req.body || {})) {
    if (!allowedTopLevel.has(k)) continue;

    let newVal = req.body[k];

    if (
      (k === "deliveryCharge" || k === "extraFee") &&
      typeof newVal === "number"
    ) {
      newVal = Math.max(0, newVal);
    }

    const oldVal = order[k];
    const different =
      (oldVal instanceof Date &&
        newVal instanceof Date &&
        oldVal.getTime() !== newVal.getTime()) ||
      (!(oldVal instanceof Date) && oldVal !== newVal);

    if (different) {
      changes[k] = { from: oldVal ?? null, to: newVal ?? null };
      order[k] = newVal;
    }
  }

  if (prevStatus !== nextStatus) {
    changes.status = { from: prevStatus, to: nextStatus };
  }

  const didTouchDeliveredAt = order.isModified("deliveredAt");
  const updated = await order.save();

  if (didTouchDeliveredAt) {
    const afterVal = updated.deliveredAt ?? null;
    changes.deliveredAt = { from: null, to: afterVal };
  }

  const changedKeys = Object.keys(changes);
  const message = changedKeys.length
    ? `Order updated successfully (${changedKeys.join(", ")}).`
    : "Order saved (no changes detected).";

  res.status(200).json({
    success: true,
    message,
    changed: changes,
    data: updated,
  });
});
