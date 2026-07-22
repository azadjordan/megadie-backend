import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import Order from "../models/orderModel.js";
import Quote from "../models/quoteModel.js";
import Invoice from "../models/invoiceModel.js";
import Payment from "../models/paymentModel.js";
import Product from "../models/productModel.js";
import SlotItem from "../models/slotItemModel.js";
import User from "../models/userModel.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import { logInventoryMovement } from "../utils/inventoryMovement.js";
import { applySlotOccupancyDelta } from "../utils/slotOccupancy.js";

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

const escapeRegex = (text = "") =>
  String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ADMIN_ORDER_INVOICE_SELECT = [
  "invoiceNumber",
  "status",
  "paymentStatus",
  "amountMinor",
  "paidTotalMinor",
  "balanceDueMinor",
  "currency",
  "minorUnitFactor",
  "dueDate",
].join(" ");

const ADMIN_ORDER_INVOICE_POPULATE = {
  path: "invoice",
  select: ADMIN_ORDER_INVOICE_SELECT,
  populate: {
    path: "payments",
    select: "receivedBy paymentMethod",
    options: { sort: { paymentDate: -1, createdAt: -1 } },
  },
};

const ORDER_USER_DELIVERY_SELECT = [
  "name",
  "email",
  "phoneNumber",
  "secondaryPhoneNumber",
  "address",
  "deliveryGoogleMapsUrl",
  "deliveryNotes",
].join(" ");

const ORDER_PAYMENT_FILTER_VALUES = new Set([
  "noInvoice",
  "notFullyPaid",
  "Unpaid",
  "PartiallyPaid",
  "Paid",
]);

const ORDER_INVOICE_PAYMENT_STATUSES = ["Unpaid", "PartiallyPaid", "Paid"];
const ORDER_ACTIVE_STATUSES = ["Processing", "Shipping", "Delivered"];
const ORDER_UNPAID_PAYMENT_STATUSES = ["Unpaid", "PartiallyPaid"];
const ORDER_WORK_FILTER_VALUES = new Set([
  "noInvoice",
  "paymentDue",
  "needsReservation",
  "readyToDeliver",
  "needsStockDeduction",
]);
const ORDER_WORK_SUMMARY_KEYS = [
  "noInvoice",
  "paymentDue",
  "needsReservation",
  "readyToDeliver",
  "needsStockDeduction",
];

const addFilterCondition = (filter, condition) => {
  if (!condition || Object.keys(condition).length === 0) return;
  filter.$and = filter.$and || [];
  filter.$and.push(condition);
};

const getPaymentDueInvoiceIds = () =>
  Invoice.distinct("_id", {
    status: "Issued",
    paymentStatus: { $in: ORDER_UNPAID_PAYMENT_STATUSES },
  });

const buildOrderWorkFilter = async (work) => {
  if (!work) return {};

  if (!ORDER_WORK_FILTER_VALUES.has(work)) {
    throw new Error(
      `Invalid work. Allowed: ${Array.from(ORDER_WORK_FILTER_VALUES).join(", ")}.`
    );
  }

  if (work === "noInvoice") {
    return {
      status: { $in: ORDER_ACTIVE_STATUSES },
      invoice: null,
    };
  }

  if (work === "paymentDue") {
    const invoiceIds = await getPaymentDueInvoiceIds();
    return {
      status: { $in: ORDER_ACTIVE_STATUSES },
      invoice: { $in: invoiceIds },
    };
  }

  if (work === "needsReservation") {
    return {
      status: "Shipping",
      allocationStatus: { $ne: "Allocated" },
      stockFinalizedAt: null,
    };
  }

  if (work === "readyToDeliver") {
    return {
      status: "Shipping",
      allocationStatus: "Allocated",
      stockFinalizedAt: null,
    };
  }

  if (work === "needsStockDeduction") {
    return {
      status: "Delivered",
      allocationStatus: "Allocated",
      stockFinalizedAt: null,
    };
  }

  return {};
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

const resolveId = (value) => {
  if (!value) return "";
  return String(value?._id || value?.id || value);
};

const isReservedAllocation = (allocation) =>
  !allocation?.status || allocation.status === "Reserved";

const isDeductedAllocation = (allocation) => allocation?.status === "Deducted";

const qtyOf = (allocation) => Math.max(0, Number(allocation?.qty) || 0);

const sumAllocationQty = (rows) =>
  rows.reduce((sum, row) => sum + qtyOf(row), 0);

const formatSlotLabel = (slot) => {
  if (!slot || typeof slot !== "object") return "Unknown slot";
  if (slot.label) return slot.label;
  if (slot.unit && slot.position && slot.store) {
    return `${slot.unit}${slot.position}-${slot.store}`;
  }
  return "Unknown slot";
};

const formatProductLabel = (product) => {
  if (!product || typeof product !== "object") return "Unknown product";
  return product.name || product.sku || "Unknown product";
};

const buildOrderDeletePreviewPayload = async (orderId, { session = null } = {}) => {
  const orderQuery = Order.findById(orderId).select(
    "_id orderNumber status invoice quote stockFinalizedAt orderItems.product orderItems.qty"
  );
  if (session) orderQuery.session(session);
  const order = await orderQuery.lean();
  if (!order) return null;

  let invoiceId = resolveId(order.invoice);
  const quoteId = resolveId(order.quote);

  let invoice = null;
  if (invoiceId) {
    const invoiceQuery = Invoice.findById(invoiceId).select(
      "invoiceNumber status amountMinor paidTotalMinor balanceDueMinor currency minorUnitFactor"
    );
    if (session) invoiceQuery.session(session);
    invoice = await invoiceQuery.lean();
  }
  if (!invoice) {
    const linkedInvoiceQuery = Invoice.findOne({ order: order._id }).select(
      "invoiceNumber status amountMinor paidTotalMinor balanceDueMinor currency minorUnitFactor"
    );
    if (session) linkedInvoiceQuery.session(session);
    invoice = await linkedInvoiceQuery.lean();
    if (invoice) invoiceId = resolveId(invoice._id);
  }

  let quote = null;
  if (quoteId) {
    const quoteQuery = Quote.findById(quoteId).select("quoteNumber status");
    if (session) quoteQuery.session(session);
    quote = await quoteQuery.lean();
  }
  if (!quote) {
    const linkedQuoteQuery = Quote.findOne({ order: order._id }).select(
      "quoteNumber status"
    );
    if (session) linkedQuoteQuery.session(session);
    quote = await linkedQuoteQuery.lean();
  }

  const allocationsQuery = OrderAllocation.find({ order: order._id })
    .select("_id product slot qty status")
    .populate("product", "name sku cbm")
    .populate("slot", "label store unit position")
    .lean();
  if (session) allocationsQuery.session(session);
  const allocations = await allocationsQuery;

  const payments = invoiceId
    ? await (() => {
        const paymentsQuery = Payment.find({ invoice: invoiceId })
          .select("amountMinor")
          .lean();
        if (session) paymentsQuery.session(session);
        return paymentsQuery;
      })()
    : [];

  const reservedRows = allocations.filter(isReservedAllocation);
  const deductedRows = allocations.filter(isDeductedAllocation);
  const cancelledRows = allocations.filter((row) => row?.status === "Cancelled");
  const reservedQty = sumAllocationQty(reservedRows);
  const deductedQty = sumAllocationQty(deductedRows);
  const stockFinalized = Boolean(order.stockFinalizedAt) || deductedRows.length > 0;
  const paymentTotalMinor = payments.reduce(
    (sum, payment) => sum + (Number(payment?.amountMinor) || 0),
    0
  );
  const restoreRows = deductedRows.map((row) => ({
    allocationId: resolveId(row._id),
    productId: resolveId(row.product),
    productName: formatProductLabel(row.product),
    slotId: resolveId(row.slot),
    slotLabel: formatSlotLabel(row.slot),
    qty: qtyOf(row),
  }));

  const orderedByProduct = new Map();
  for (const item of order.orderItems || []) {
    const productId = resolveId(item.product);
    const qtyValue = Math.max(0, Number(item.qty) || 0);
    if (productId && qtyValue > 0) {
      orderedByProduct.set(
        productId,
        (orderedByProduct.get(productId) || 0) + qtyValue
      );
    }
  }

  const deductedByProduct = new Map();
  for (const row of deductedRows) {
    const productId = resolveId(row.product);
    const qtyValue = qtyOf(row);
    if (productId && qtyValue > 0) {
      deductedByProduct.set(
        productId,
        (deductedByProduct.get(productId) || 0) + qtyValue
      );
    }
  }

  const blockers = [];
  if (stockFinalized && deductedRows.length === 0) {
    blockers.push(
      "Stock was finalized, but deducted allocation records are missing. Stock cannot be restored safely."
    );
  }
  if (stockFinalized && orderedByProduct.size === 0) {
    blockers.push("Order items are missing. Stock cannot be restored safely.");
  }
  for (const row of restoreRows) {
    if (!row.productId || row.productName === "Unknown product") {
      blockers.push("A deducted allocation is missing its product.");
      break;
    }
  }
  for (const row of restoreRows) {
    if (!row.slotId || row.slotLabel === "Unknown slot") {
      blockers.push("A deducted allocation is missing its original slot.");
      break;
    }
  }
  if (restoreRows.some((row) => row.qty <= 0 || !Number.isInteger(row.qty))) {
    blockers.push("A deducted allocation has an invalid quantity.");
  }
  if (stockFinalized) {
    for (const [productId, orderedQty] of orderedByProduct.entries()) {
      if ((deductedByProduct.get(productId) || 0) !== orderedQty) {
        blockers.push(
          "Deducted allocation records do not match the order items. Stock cannot be restored safely."
        );
        break;
      }
    }
    for (const productId of deductedByProduct.keys()) {
      if (!orderedByProduct.has(productId)) {
        blockers.push(
          "A deducted allocation references a product that is not in this order."
        );
        break;
      }
    }
  }

  const actions = [];
  if (deductedQty > 0) {
    actions.push(`Restore ${deductedQty} unit${deductedQty === 1 ? "" : "s"} to original slots`);
    actions.push("Log stock restore movements");
  }
  if (reservedQty > 0) {
    actions.push(`Release ${reservedQty} reserved unit${reservedQty === 1 ? "" : "s"}`);
  }
  if (allocations.length > 0) {
    actions.push(
      `Delete ${allocations.length} allocation record${
        allocations.length === 1 ? "" : "s"
      }`
    );
  }
  if (invoice) {
    actions.push(`Delete invoice ${invoice.invoiceNumber || invoice._id}`);
  } else if (invoiceId) {
    actions.push("Remove missing invoice reference");
  }
  if (payments.length > 0) {
    actions.push(
      `Delete ${payments.length} payment record${payments.length === 1 ? "" : "s"}`
    );
  }
  if (quote) {
    actions.push(`Delete linked quote ${quote.quoteNumber || quote._id}`);
  } else if (quoteId) {
    actions.push("Remove missing quote reference");
  }
  actions.push(`Delete order ${order.orderNumber || order._id}`);

  const warnings = [];
  if (deductedQty > 0) {
    warnings.push("Stock was already deducted and will be restored.");
  }
  if (payments.length > 0) {
    warnings.push("Payment records will be permanently deleted.");
  }
  if (invoiceId && !invoice) {
    warnings.push("The linked invoice record was not found.");
  }
  if (quoteId && !quote) {
    warnings.push("The linked quote record was not found.");
  }

  return {
    allowed: blockers.length === 0,
    blockers,
    order: {
      id: resolveId(order._id),
      orderNumber: order.orderNumber || resolveId(order._id),
      status: order.status || "-",
      stockFinalized,
    },
    stock: {
      mode: deductedQty > 0 ? "restore" : "release",
      stockFinalized,
      reservedQty,
      deductedQty,
      restoreRows,
    },
    allocations: {
      total: allocations.length,
      reservedCount: reservedRows.length,
      deductedCount: deductedRows.length,
      cancelledCount: cancelledRows.length,
    },
    invoice: invoice
      ? {
          exists: true,
          id: resolveId(invoice._id),
          invoiceNumber: invoice.invoiceNumber || resolveId(invoice._id),
          status: invoice.status || "-",
          amountMinor: invoice.amountMinor || 0,
          paidTotalMinor: invoice.paidTotalMinor || 0,
          balanceDueMinor: invoice.balanceDueMinor || 0,
          currency: invoice.currency || "AED",
          minorUnitFactor: invoice.minorUnitFactor || 100,
        }
      : { exists: false, id: invoiceId || "", invoiceNumber: "" },
    payments: {
      count: payments.length,
      totalMinor: paymentTotalMinor,
      currency: invoice?.currency || "AED",
      minorUnitFactor: invoice?.minorUnitFactor || 100,
    },
    quote: quote
      ? {
          exists: true,
          id: resolveId(quote._id),
          quoteNumber: quote.quoteNumber || resolveId(quote._id),
          status: quote.status || "-",
        }
      : { exists: false, id: quoteId || "", quoteNumber: "" },
    actions,
    warnings,
    confirmText: order.orderNumber || resolveId(order._id),
  };
};

const restoreDeductedAllocation = async ({
  allocation,
  orderId,
  actorId,
  session,
}) => {
  const productId = resolveId(allocation.product);
  const slotId = resolveId(allocation.slot);
  const qtyValue = qtyOf(allocation);
  if (!mongoose.isValidObjectId(productId) || !mongoose.isValidObjectId(slotId)) {
    throw new Error("Cannot restore stock because an allocation has an invalid product or slot.");
  }
  if (qtyValue <= 0 || !Number.isInteger(qtyValue)) {
    throw new Error("Cannot restore stock because an allocation has an invalid quantity.");
  }

  const product = await Product.findById(productId)
    .select("cbm")
    .session(session);
  if (!product) {
    throw new Error("Cannot restore stock because the product no longer exists.");
  }

  const unitCbm = Math.max(0, Number(product.cbm) || 0);
  const restoreCbm = unitCbm * qtyValue;
  let slotItem = await SlotItem.findOne({
    product: productId,
    slot: slotId,
  }).session(session);

  if (!slotItem) {
    slotItem = new SlotItem({
      product: productId,
      slot: slotId,
      qty: qtyValue,
      cbm: 0,
    });
  } else {
    slotItem.qty = Math.max(0, Number(slotItem.qty) || 0) + qtyValue;
  }
  await slotItem.save({ session });

  if (restoreCbm > 0) {
    await applySlotOccupancyDelta(slotId, restoreCbm, session);
  }

  await logInventoryMovement(
    {
      type: "RESTORE",
      product: productId,
      slot: slotId,
      order: orderId,
      allocation: allocation._id,
      qty: qtyValue,
      unitCbm: unitCbm || undefined,
      cbm: restoreCbm || undefined,
      actor: actorId || null,
      note: "Order deleted after stock deduction; stock restored.",
    },
    session
  );

  return { qty: qtyValue, cbm: restoreCbm };
};

/* =========================
   GET /api/orders/:id/delete-preview
   Private/Admin
   Shows the cleanup/restore impact before deleting an order.
   ========================= */
export const getOrderDeletePreview = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400);
    throw new Error("Invalid order id.");
  }

  const preview = await buildOrderDeletePreviewPayload(req.params.id);
  if (!preview) {
    res.status(404);
    throw new Error("Order not found.");
  }

  res.status(200).json({
    success: true,
    message: preview.allowed
      ? "Order delete preview generated."
      : "Order cannot be deleted safely.",
    data: preview,
  });
});

/* =========================
   DELETE /api/orders/:id
   Private/Admin
   Deletes an order as a correction workflow:
   - Reserved stock is released
   - Deducted stock is restored to original slots
   - Linked invoice/payments, quote, allocations, and order are removed
   ========================= */
export const deleteOrder = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400);
    throw new Error("Invalid order id.");
  }

  const session = await mongoose.startSession();
  let summary = null;

  try {
    await session.withTransaction(async () => {
      const preview = await buildOrderDeletePreviewPayload(req.params.id, {
        session,
      });
      if (!preview) {
        res.status(404);
        throw new Error("Order not found.");
      }
      if (!preview.allowed) {
        res.status(409);
        throw new Error(preview.blockers.join(" "));
      }

      const order = await Order.findById(req.params.id)
        .select("_id orderNumber invoice quote")
        .session(session);
      if (!order) {
        res.status(404);
        throw new Error("Order not found.");
      }

      const allocations = await OrderAllocation.find({ order: order._id })
        .select("_id product slot qty status note")
        .session(session);
      const reservedAllocations = allocations.filter(isReservedAllocation);
      const deductedAllocations = allocations.filter(isDeductedAllocation);

      let restoredQty = 0;
      let restoredCbm = 0;
      let releasedQty = 0;

      for (const allocation of reservedAllocations) {
        const qtyValue = qtyOf(allocation);
        releasedQty += qtyValue;
        await logInventoryMovement(
          {
            type: "RELEASE",
            product: allocation.product,
            slot: allocation.slot,
            order: order._id,
            allocation: allocation._id,
            qty: qtyValue,
            actor: req.user?._id || null,
            note: allocation.note || undefined,
          },
          session
        );
      }

      for (const allocation of deductedAllocations) {
        const restored = await restoreDeductedAllocation({
          allocation,
          orderId: order._id,
          actorId: req.user?._id || null,
          session,
        });
        restoredQty += restored.qty;
        restoredCbm += restored.cbm;
      }

      const allocationResult = await OrderAllocation.deleteMany({
        order: order._id,
      }).session(session);

      let invoiceDeleted = false;
      let paymentsDeleted = 0;
      let invoiceId = resolveId(order.invoice);
      let invoice = null;
      if (invoiceId) {
        invoice = await Invoice.findById(invoiceId).session(session);
      }
      if (!invoice) {
        invoice = await Invoice.findOne({ order: order._id }).session(session);
        if (invoice) invoiceId = resolveId(invoice._id);
      }
      if (invoiceId) {
        if (invoice) {
          if (invoice.status !== "Cancelled") {
            invoice.status = "Cancelled";
            invoice.cancelReason =
              invoice.cancelReason || "Deleted with order correction";
            if (!invoice.cancelledAt) invoice.cancelledAt = new Date();
            await invoice.save({ session });
          }
          await Invoice.deleteOne({ _id: invoice._id }).session(session);
          invoiceDeleted = true;
        }
        const paymentResult = await Payment.deleteMany({
          invoice: invoiceId,
        }).session(session);
        paymentsDeleted = paymentResult?.deletedCount || 0;
      }

      let quoteDeleted = false;
      let quote = null;
      if (order.quote) {
        quote = await Quote.findById(order.quote).session(session);
      }
      if (!quote) {
        quote = await Quote.findOne({ order: order._id }).session(session);
      }
      if (quote) {
        await quote.deleteOne({ session });
        quoteDeleted = true;
      }

      await order.deleteOne({ session });

      summary = {
        orderId: resolveId(order._id),
        orderNumber: order.orderNumber || resolveId(order._id),
        stockRestored: restoredQty > 0,
        restoredQty,
        restoredCbm,
        releasedQty,
        allocationsDeleted: allocationResult?.deletedCount || 0,
        invoiceDeleted,
        paymentsDeleted,
        quoteDeleted,
      };
    });
  } finally {
    session.endSession();
  }

  res.status(200).json({
    success: true,
    message: summary?.stockRestored
      ? "Order deleted and deducted stock restored."
      : "Order deleted and reservations released.",
    data: summary,
  });
});

/* =========================
   GET /api/orders/:id
   Private (Owner) or Admin
   Returns a single order by ID
   ========================= */
export const getOrderById = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id)
    .populate("user", ORDER_USER_DELIVERY_SELECT)
    .populate("quote", "quoteNumber")
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
   GET /api/orders/work-summary
   Private/Admin
   Counts orders that need common admin actions
   ========================= */
export const getOrdersWorkSummary = asyncHandler(async (_req, res) => {
  const entries = await Promise.all(
    ORDER_WORK_SUMMARY_KEYS.map(async (key) => {
      const workFilter = await buildOrderWorkFilter(key);
      const count = await Order.countDocuments(workFilter);
      return [key, count];
    })
  );

  res.status(200).json({
    success: true,
    message: "Order work summary retrieved successfully.",
    data: Object.fromEntries(entries),
  });
});

/* =========================
   GET /api/orders
   Private/Admin
   Paginated list of orders with optional filters
   Query: status, paymentStatus, work, search (matches user name/email or order number)
   ========================= */
export const getOrders = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req, {
    defaultLimit: 10,
    maxLimit: 100,
  });

  const filter = {};
  const status = req.query.status ? String(req.query.status).trim() : "";
  if (status) {
    const allowedStatuses = new Set(Order.schema.path("status")?.enumValues || []);
    if (!allowedStatuses.has(status)) {
      res.status(400);
      throw new Error(
        `Invalid status. Allowed: ${Array.from(allowedStatuses).join(", ")}.`
      );
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
    const searchFilter = { $or: [{ orderNumber: searchRegex }] };
    if (userIds.length) {
      searchFilter.$or.push({ user: { $in: userIds } });
    }
    addFilterCondition(filter, searchFilter);
  } else if (req.query.user) {
    if (!mongoose.isValidObjectId(req.query.user)) {
      res.status(400);
      throw new Error("Invalid user id.");
    }
    filter.user = req.query.user;
  }

  const paymentStatus = req.query.paymentStatus
    ? String(req.query.paymentStatus).trim()
    : "";
  if (paymentStatus) {
    if (!ORDER_PAYMENT_FILTER_VALUES.has(paymentStatus)) {
      res.status(400);
      throw new Error(
        `Invalid paymentStatus. Allowed: ${Array.from(
          ORDER_PAYMENT_FILTER_VALUES
        ).join(", ")}.`
      );
    }

    if (paymentStatus === "noInvoice") {
      addFilterCondition(filter, { invoice: null });
    } else if (paymentStatus === "notFullyPaid") {
      const invoiceIds = await Invoice.distinct("_id", {
        paymentStatus: { $in: ["Unpaid", "PartiallyPaid"] },
      });
      addFilterCondition(filter, {
        $or: [{ invoice: null }, { invoice: { $in: invoiceIds } }],
      });
    } else if (ORDER_INVOICE_PAYMENT_STATUSES.includes(paymentStatus)) {
      const invoiceIds = await Invoice.distinct("_id", { paymentStatus });
      addFilterCondition(filter, { invoice: { $in: invoiceIds } });
    }
  }

  const work = req.query.work ? String(req.query.work).trim() : "";
  if (work) {
    if (!ORDER_WORK_FILTER_VALUES.has(work)) {
      res.status(400);
      throw new Error(
        `Invalid work. Allowed: ${Array.from(ORDER_WORK_FILTER_VALUES).join(
          ", "
        )}.`
      );
    }

    addFilterCondition(filter, await buildOrderWorkFilter(work));
  }

  const sort = { createdAt: -1, _id: -1 };

  const [total, orders] = await Promise.all([
    Order.countDocuments(filter),
    Order.find(filter)
      .populate("user", ORDER_USER_DELIVERY_SELECT)
      .populate(ADMIN_ORDER_INVOICE_POPULATE)
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
  if (quote.manualInvoiceId) {
    res.status(409);
    throw new Error("Manual invoice created — quote locked.");
  }

  // -------------------------
  // 3. Resolve product SKUs (snapshot)
  // -------------------------
  const productIds = quote.requestedItems.map((it) => it.product);

  const products = await Product.find(
    { _id: { $in: productIds } },
    { _id: 1, sku: 1, name: 1 }
  ).lean();

  const skuMap = new Map(products.map((p) => [String(p._id), p.sku]));
  const nameMap = new Map(products.map((p) => [String(p._id), p.name]));

  // -------------------------
  // 4. Map quote items → order items
  // qty = 0 is allowed by business rules
  // -------------------------
  const orderItems = quote.requestedItems.map((it) => ({
    product: it.product,
    sku: skuMap.get(String(it.product)) || "",
    productName: nameMap.get(String(it.product)) || "",
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
   PUT /api/orders/:id/deliver
   Private/Admin
   Mark order as Delivered and delete linked quote if present
   ========================= */
export const markOrderDelivered = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const body = req.body || {};

  const session = await mongoose.startSession();
  let quoteDeleted = false;
  let updated = null;

  try {
    await session.withTransaction(async () => {
      const order = await Order.findById(id).session(session);
      if (!order) {
        res.status(404);
        throw new Error("Order not found.");
      }

      if (order.status !== "Shipping") {
        res.status(400);
        throw new Error("Order must be Shipping before delivery.");
      }

      const triesDeliveryCharge = Object.prototype.hasOwnProperty.call(
        body,
        "deliveryCharge"
      );
      const triesExtraFee = Object.prototype.hasOwnProperty.call(body, "extraFee");

      if (order.invoice && (triesDeliveryCharge || triesExtraFee)) {
        res.status(400);
        throw new Error(
          "Cannot modify deliveryCharge or extraFee because an invoice already exists for this order."
        );
      }

      if (triesDeliveryCharge) {
        const val = Number(body.deliveryCharge);
        if (!Number.isFinite(val) || val < 0) {
          res.status(400);
          throw new Error("deliveryCharge must be a non-negative number.");
        }
        order.deliveryCharge = val;
      }

      if (triesExtraFee) {
        const val = Number(body.extraFee);
        if (!Number.isFinite(val) || val < 0) {
          res.status(400);
          throw new Error("extraFee must be a non-negative number.");
        }
        order.extraFee = val;
      }

      if (Object.prototype.hasOwnProperty.call(body, "adminToAdminNote")) {
        order.adminToAdminNote = String(body.adminToAdminNote ?? "");
      }

      if (Object.prototype.hasOwnProperty.call(body, "adminToClientNote")) {
        order.adminToClientNote = String(body.adminToClientNote ?? "");
      }

      const deliveredBy = String(
        body.deliveredBy || order.deliveredBy || ""
      ).trim();
      if (!deliveredBy) {
        res.status(400);
        throw new Error("Delivered by is required.");
      }
      order.deliveredBy = deliveredBy;

      const allocations = await OrderAllocation.find({ order: order._id })
        .select("product qty status")
        .lean()
        .session(session);

      const activeAllocations = allocations.filter(
        (row) => !row.status || row.status === "Reserved" || row.status === "Deducted"
      );

      if (!activeAllocations.length) {
        res.status(409);
        throw new Error(
          "Order has no reservations. Reserve all items before delivery."
        );
      }

      const reservedAllocations = activeAllocations.filter(
        (row) => !row.status || row.status === "Reserved"
      );
      const deductedAllocations = activeAllocations.filter(
        (row) => row.status === "Deducted"
      );

      if (reservedAllocations.length && deductedAllocations.length) {
        res.status(409);
        throw new Error(
          "Order allocations are partially deducted. Resolve before delivery."
        );
      }

      const allocatedTotals = new Map();
      for (const row of activeAllocations) {
        const key = String(row.product);
        allocatedTotals.set(
          key,
          (allocatedTotals.get(key) || 0) + (Number(row.qty) || 0)
        );
      }

      for (const item of order.orderItems || []) {
        const productId = String(item.product);
        const orderedQty = Number(item.qty) || 0;
        const allocatedQty = allocatedTotals.get(productId) || 0;
        if (allocatedQty !== orderedQty) {
          res.status(409);
          throw new Error(
            "All items must be fully reserved before delivery."
          );
        }
      }

      if (order.quote) {
        const quote = await Quote.findById(order.quote).session(session);
        if (quote) {
          await quote.deleteOne({ session });
          quoteDeleted = true;
        }
        order.quote = null;
      }

      order.status = "Delivered";
      if (!order.deliveredAt) {
        order.deliveredAt = new Date();
      }

      updated = await order.save({ session });
    });
  } finally {
    session.endSession();
  }

  res.status(200).json({
    success: true,
    message: quoteDeleted
      ? "Order delivered and quote deleted."
      : "Order delivered.",
    quoteDeleted,
    data: updated,
  });
});

/* =========================
   POST /api/orders/:id/cancel
   Private/Admin
   Cancel an order and cleanup:
   - Cancel + delete invoice and payments (if present)
   - Unreserve all allocations
   - Set status to Cancelled
   ========================= */
export const cancelOrderAndCleanup = asyncHandler(async (req, res) => {
  const { id: orderId } = req.params;

  if (!mongoose.isValidObjectId(orderId)) {
    res.status(400);
    throw new Error("Invalid order id.");
  }

  const session = await mongoose.startSession();
  const summary = {
    orderId,
    invoiceDeleted: false,
    paymentsDeleted: 0,
    allocationsDeleted: 0,
  };

  try {
    await session.withTransaction(async () => {
      const order = await Order.findById(orderId).session(session);
      if (!order) {
        res.status(404);
        throw new Error("Order not found.");
      }

      if (order.stockFinalizedAt) {
        res.status(409);
        throw new Error("Stock finalized orders cannot be cancelled.");
      }

      const allocations = await OrderAllocation.find({ order: orderId })
        .select("product slot qty status note")
        .lean()
        .session(session);

      const hasDeducted = allocations.some(
        (row) => row?.status === "Deducted"
      );
      if (hasDeducted) {
        res.status(409);
        throw new Error(
          "Order has deducted allocations. Reverse stock finalization before cancelling."
        );
      }

      if (order.invoice) {
        const invoice = await Invoice.findById(order.invoice).session(session);
        if (invoice) {
          if (invoice.status !== "Cancelled") {
            invoice.status = "Cancelled";
            invoice.cancelReason =
              invoice.cancelReason || "Cancelled with order";
            if (!invoice.cancelledAt) invoice.cancelledAt = new Date();
            await invoice.save({ session });
          }

          const paymentResult = await Payment.deleteMany({
            invoice: invoice._id,
          }).session(session);
          summary.paymentsDeleted = paymentResult?.deletedCount || 0;

          await Invoice.deleteOne({ _id: invoice._id }).session(session);
          summary.invoiceDeleted = true;
        }

        order.invoice = null;
      }

      const releaseAllocations = allocations.filter(
        (row) => !row?.status || row.status === "Reserved"
      );
      for (const allocation of releaseAllocations) {
        await logInventoryMovement(
          {
            type: "RELEASE",
            product: allocation.product,
            slot: allocation.slot,
            order: orderId,
            allocation: allocation._id,
            qty: Number(allocation.qty) || 0,
            actor: req.user?._id || null,
            note: allocation.note || undefined,
          },
          session
        );
      }

      const deleteResult = await OrderAllocation.deleteMany({
        order: orderId,
      }).session(session);
      summary.allocationsDeleted = deleteResult?.deletedCount || 0;

      order.status = "Cancelled";
      order.deliveredAt = null;
      order.allocationStatus = "Unallocated";
      order.allocatedAt = null;

      await order.save({ session });
    });
  } finally {
    session.endSession();
  }

  res.status(200).json({
    success: true,
    message: "Order cancelled and cleaned up.",
    data: summary,
  });
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

  if (req.body?.status === "Delivered") {
    res.status(400);
    throw new Error("Use /api/orders/:id/deliver to mark an order as Delivered.");
  }
  if (req.body?.status === "Cancelled") {
    res.status(409);
    throw new Error("Use /api/orders/:id/cancel to cancel orders.");
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

  if (
    Object.prototype.hasOwnProperty.call(req.body || {}, "status") &&
    nextStatus === "Shipping" &&
    prevStatus !== "Processing"
  ) {
    res.status(409);
    throw new Error("Only Processing orders can be set to Shipping.");
  }

  if (
    Object.prototype.hasOwnProperty.call(req.body || {}, "status") &&
    nextStatus === "Processing" &&
    prevStatus !== "Processing"
  ) {
    if (prevStatus === "Delivered") {
      res.status(409);
      throw new Error("Delivered orders cannot be moved back to Processing.");
    }
    if (prevStatus !== "Cancelled") {
      res.status(409);
      throw new Error("Only Cancelled orders can be moved back to Processing.");
    }
    if (order.stockFinalizedAt) {
      res.status(409);
      throw new Error("Stock finalized orders cannot be moved back to Processing.");
    }
    if (order.invoice) {
      res.status(409);
      throw new Error("Remove the invoice before moving this order back to Processing.");
    }

    const hasBlockingAllocations = await OrderAllocation.exists({
      order: order._id,
      $or: [
        { status: { $in: ["Reserved", "Deducted"] } },
        { status: { $exists: false } },
      ],
    });
    if (hasBlockingAllocations) {
      res.status(409);
      throw new Error(
        "Remove reserved or deducted allocations before moving this order back to Processing."
      );
    }
  }

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
