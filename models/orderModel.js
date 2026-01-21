// models/orderModel.js (MVP Clean)
import mongoose from "mongoose";
import crypto from "crypto";

/* ========== Subschemas ========== */
const OrderItemSchema = new mongoose.Schema(
  {
    product:   { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    sku:       { type: String, required: true, trim: true },
    productName: { type: String, trim: true },
    qty:       { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    lineTotal: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

/* ========== Main schema ========== */
const orderSchema = new mongoose.Schema(
  {
    user:        { type: mongoose.Schema.Types.ObjectId, required: true, ref: "User", index: true },
    orderNumber: { type: String, required: true, unique: true, index: true },

    // link to quote (optional, 1:1 when exists)
    quote: { type: mongoose.Schema.Types.ObjectId, ref: "Quote", default: null },

    // optional invoice link
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", default: null },

    orderItems: {
      type: [OrderItemSchema],
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length > 0,
        message: "At least one order item is required.",
      },
      required: true,
    },

    totalPrice:     { type: Number, required: true, default: 0, min: 0 },
    deliveryCharge: { type: Number, required: true, default: 0, min: 0 },
    extraFee:       { type: Number, required: true, default: 0, min: 0 },

    deliveredBy: { type: String },
    deliveredAt: { type: Date },

    status: {
      type: String,
      enum: ["Processing", "Shipping", "Delivered", "Cancelled"],
      default: "Processing",
      index: true,
    },

    // Minimal allocation state for UI (source of truth is OrderAllocation docs)
    allocationStatus: {
      type: String,
      enum: ["Unallocated", "PartiallyAllocated", "Allocated"],
      default: "Unallocated",
      index: true,
    },
    allocatedAt: { type: Date },
    stockFinalizedAt: { type: Date },

    clientToAdminNote: { type: String },
    adminToAdminNote:  { type: String },
    adminToClientNote: { type: String },
  },
  { timestamps: true }
);

/* ========== Virtuals ========== */
orderSchema.virtual("isDelivered").get(function () {
  return this.status === "Delivered";
});
orderSchema.virtual("isFromQuote").get(function () {
  return !!this.quote;
});

/* ========== Validators ========== */
// Invoice allowed for any status you had (keep it)
orderSchema.path("invoice").validate(function (val) {
  if (!val) return true;
  return ["Processing", "Shipping", "Delivered", "Cancelled"].includes(this.status);
}, "Invoice can only be attached for Processing, Shipping, Delivered, or Cancelled orders.");

// Quote allowed only while Processing/Cancelled (same logic you had)
orderSchema.path("quote").validate(function (val) {
  if (!val) return true;
  return ["Processing", "Shipping", "Cancelled"].includes(this.status);
}, "Quote can only be attached for Processing, Shipping, or Cancelled orders.");

/* ========== Hooks ========== */
orderSchema.pre("validate", function (next) {
  try {
    if (this.isNew && !this.orderNumber) {
      const now = new Date();
      const yy = String(now.getFullYear()).slice(-2);
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const randomHex = crypto.randomBytes(3).toString("hex").toUpperCase();
      this.orderNumber = `ORD-${yy}${mm}${dd}-${randomHex}`;
    }

    let itemsSum = 0;
    this.orderItems = (this.orderItems || []).map((it) => {
      const unit = typeof it.unitPrice === "number" ? it.unitPrice : 0;
      const qty  = typeof it.qty === "number" ? it.qty : 0;
      const lineTotal = Math.max(0, unit * qty);
      itemsSum += lineTotal;
      const base = typeof it.toObject === "function" ? it.toObject() : it;
      return { ...base, lineTotal };
    });

    const delivery = this.deliveryCharge || 0;
    const extra    = this.extraFee || 0;
    this.totalPrice = Math.max(0, itemsSum + delivery + extra);

    if (this.status === "Delivered" && !this.deliveredAt) {
      this.deliveredAt = new Date();
    }

    next();
  } catch (err) {
    next(err);
  }
});

/* ========== Serialization ========== */
orderSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => { ret.id = ret._id; return ret; },
});

orderSchema.set("toObject", {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => { ret.id = ret._id; return ret; },
});

/* ========== Indexes ========== */
orderSchema.index({ user: 1, createdAt: -1 });

orderSchema.index(
  { quote: 1 },
  { unique: true, partialFilterExpression: { quote: { $exists: true, $ne: null } } }
);

orderSchema.index(
  { invoice: 1 },
  { unique: true, partialFilterExpression: { invoice: { $exists: true, $ne: null } } }
);

const Order = mongoose.models.Order || mongoose.model("Order", orderSchema);
export default Order;
