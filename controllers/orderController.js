import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import Order from "../models/orderModel.js";
import Quote from "../models/quoteModel.js";

/* =========================
   Helpers
   ========================= */
const parsePagination = (req, { defaultLimit = 20, maxLimit = 100 } = {}) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || defaultLimit, 1), maxLimit);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

/* =========================
   Delete (Admin)
   DELETE /api/orders/:id
   ========================= */
export const deleteOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) {
    res.status(404);
    throw new Error("Order not found.");
  }

  // ✅ Prevent deleting delivered orders
  if (order.status === "Delivered") {
    res.status(400);
    throw new Error("Delivered orders cannot be deleted. Set status to 'Cancelled' instead.");
  }

  await order.deleteOne();
  res.status(204).end();
});

/* =========================
   Get by ID (User or Admin)
   GET /api/orders/:id
   ========================= */
export const getOrderById = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id)
    .populate("user", "name email")
    .populate("orderItems.product", "name sku size");

  if (!order) {
    res.status(404);
    throw new Error("Order not found");
  }

  const isAdmin = !!req.user?.isAdmin;
  const isOwner = String(order.user?._id || order.user) === String(req.user._id);
  if (!isAdmin && !isOwner) {
    res.status(403); // ✅ changed from 401 to 403
    throw new Error("Not authorized to view this order");
  }

  res.json(order);
});

/* =========================
   Get my orders (User)
   GET /api/orders/my
   ========================= */
export const getMyOrders = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req, { defaultLimit: 20, maxLimit: 100 });
  const filter = { user: req.user._id };
  const sort = { createdAt: -1, _id: 1 };

  const [total, orders] = await Promise.all([
    Order.countDocuments(filter),
    Order.find(filter)
      .populate("invoice", "invoiceNumber")
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  res.json({
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
   Get all orders (Admin)
   GET /api/orders
   ========================= */
export const getOrders = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req, { defaultLimit: 20, maxLimit: 200 });

  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.user) {
    if (!mongoose.isValidObjectId(req.query.user)) {
      res.status(400);
      throw new Error("Invalid user id");
    }
    filter.user = req.query.user;
  }

  const sort = { createdAt: -1, _id: 1 };

  const [total, orders] = await Promise.all([
    Order.countDocuments(filter),
    Order.find(filter)
      .populate("user", "name email")
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  res.json({
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
   Create order from quote (Admin)
   POST /api/orders/from-quote/:quoteId
   ========================= */
export const createOrderFromQuote = asyncHandler(async (req, res) => {
  const { quoteId } = req.params;
  if (!mongoose.isValidObjectId(quoteId)) {
    res.status(400);
    throw new Error("Invalid quote id");
  }

  const session = await mongoose.startSession();
  let createdOrder;

  try {
    await session.withTransaction(async () => {
      const quote = await Quote.findById(quoteId)
        .populate("requestedItems.product", "_id sku")
        .session(session);

      if (!quote) {
        res.status(404);
        throw new Error("Quote not found.");
      }
      if (!Array.isArray(quote.requestedItems) || quote.requestedItems.length === 0) {
        res.status(400);
        throw new Error("Quote has no items.");
      }

      const orderItems = quote.requestedItems.map((it) => {
        const product = it.product;
        const skuSnapshot = product?.sku || ""; // ✅ fixed: rely on Product.sku only
        if (!skuSnapshot) {
          res.status(400);
          throw new Error("Missing SKU on referenced product.");
        }
        if (typeof it.unitPrice !== "number") {
          res.status(400);
          throw new Error("Each quoted item must have a unitPrice before creating an order.");
        }
        return {
          product: product?._id || it.product,
          sku: skuSnapshot,
          qty: it.qty,
          unitPrice: it.unitPrice,
        };
      });

      const orderPayload = {
        user: quote.user,
        orderItems,
        deliveryCharge: Math.max(0, quote.deliveryCharge || 0),
        extraFee: Math.max(0, quote.extraFee || 0),
        totalPrice: 0, // computed in pre('validate')
        clientToAdminNote: quote.clientToAdminNote,
        adminToAdminNote: quote.adminToAdminNote,
        adminToClientNote: quote.adminToClientNote,
        status: "Processing",
      };

      const [order] = await Order.create([orderPayload], { session });
      createdOrder = order;

      await Quote.deleteOne({ _id: quote._id }).session(session);
    });

    res.status(201).json(createdOrder);
  } finally {
    session.endSession();
  }
});

/* =========================
   Update order (Admin)
   PUT /api/orders/:id
   ========================= */
export const updateOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) {
    res.status(404);
    throw new Error("Order not found.");
  }

  // ❌ Still blocking orderItems edits
  if (Object.prototype.hasOwnProperty.call(req.body, "orderItems")) {
    res.status(400);
    throw new Error("Order items are immutable after creation and cannot be modified.");
  }

  // ✅ Allow status edits even after delivery, but deliveredAt only set once
  const { status } = req.body;
  if (status && status === "Delivered" && !order.deliveredAt) {
    order.deliveredAt = new Date();
  }

  const allowedTopLevel = new Set([
    "user",
    "status",
    "deliveryCharge",
    "extraFee",
    "deliveredBy",
    "clientToAdminNote",
    "adminToAdminNote",
    "adminToClientNote",
    "stockUpdated",
    "invoiceGenerated",
  ]);

  Object.keys(req.body || {}).forEach((k) => {
    if (!allowedTopLevel.has(k)) return;
    if ((k === "deliveryCharge" || k === "extraFee") && typeof req.body[k] === "number") {
      order[k] = Math.max(0, req.body[k]);
    } else {
      order[k] = req.body[k];
    }
  });

  const updated = await order.save();
  res.json(updated);
});
