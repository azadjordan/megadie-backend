// models/orderModel.js (MVP Clean)
import mongoose from "mongoose";
import crypto from "crypto";

/* ========== Subschemas ========== */
const OrderItemSchema = new mongoose.Schema(
  {
    product:   { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    sku:       { type: String, required: true, trim: true },
    productName: { type: String, trim: true },
    qty: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: "qty must be a whole number",
      },
    },
    unitPrice: { type: Number, required: true, min: 0 },
    lineTotal: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

/* ========== Main schema ========== */
const deliveryDetailsSchema = new mongoose.Schema({
  contactName: { type: String, default: "" },
  phoneNumber: { type: String, default: "" },
  secondaryPhoneNumber: { type: String, default: "" },
  address: { type: String, default: "" },
  googleMapsUrl: { type: String, default: "" },
  notes: { type: String, default: "" },
}, { _id: false });

const orderSchema = new mongoose.Schema(
  {
    user:        { type: mongoose.Schema.Types.ObjectId, required: true, ref: "User", index: true },
    orderNumber: { type: String, required: true, unique: true, index: true },
    deliveryDetails: { type: deliveryDetailsSchema, default: undefined },
    deliveryRevision: { type: Number, default: 0, min: 0, validate: Number.isInteger },
    preparationMode: { type: String, enum: ["", "prepare_only", "prepare_deliver"], default: "" },
    assignedTo: { type: String, trim: true, maxlength: 120, default: "" },
    packingWorker: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    packingSentAt: { type: Date },
    packingHandoverAt: { type: Date },
    packedAt: { type: Date },
    packedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    packingSummary: {
      totalItems: { type: Number, default: 0 },
      collectedItems: { type: Number, default: 0 },
      inProgressItems: { type: Number, default: 0 },
      needsHelp: { type: Boolean, default: false },
    },
    packingReports: { type: [{
      allocation: { type: mongoose.Schema.Types.ObjectId },
      product: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
      sku: String,
      slot: { type: mongoose.Schema.Types.ObjectId, ref: "Slot" },
      slotLabel: String,
      requestedQty: Number,
      pickedQty: Number,
      shortQty: Number,
      note: { type: String, maxlength: 500 },
      by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      byName: String,
      at: { type: Date, default: Date.now },
      checkedAt: Date,
      checkedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      checkedByName: String,
    }], default: [], select: false },
    packingReportsRevision: { type: Number, default: 0, select: false },
    packingHelp: { type: [{
      product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
      sku: String,
      requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      requestedByName: String,
      requestedAt: { type: Date, default: Date.now },
      reason: { type: String, enum: ["no_alternative", "worker_requested"] },
      note: { type: String, maxlength: 500 },
      resolvedAt: Date,
      notification: {
        attempts: { type: Number, default: 0 },
        nextAttemptAt: { type: Date, default: Date.now },
        claim: String,
        leaseUntil: Date,
        sentAt: Date,
        lastError: { type: String, maxlength: 200 },
      },
    }], default: [], select: false },
    packingActivity: { type: [{
      action: String,
      actor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      actorName: String,
      product: { type: mongoose.Schema.Types.ObjectId },
      slot: { type: mongoose.Schema.Types.ObjectId },
      toSlot: { type: mongoose.Schema.Types.ObjectId },
      previousQty: Number,
      qty: Number,
      note: { type: String, maxlength: 500 },
      changes: { type: [{ product: mongoose.Schema.Types.ObjectId, sku: String, fromQty: Number, toQty: Number, unit: String }], default: undefined, _id: false },
      at: { type: Date, default: Date.now },
    }], default: [], select: false },
    itemChanges: { type: [{
      by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      byName: String,
      before: { type: [OrderItemSchema], default: [] },
      after: { type: [OrderItemSchema], default: [] },
      returns: { type: [{ product: { type: mongoose.Schema.Types.ObjectId }, sku: String, slot: { type: mongoose.Schema.Types.ObjectId }, slotLabel: String, qty: Number }], default: [] },
      cancelled: { type: Boolean, default: false },
      at: { type: Date, default: Date.now },
    }], default: [], select: false },

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

    deliveryMovement: { type: new mongoose.Schema({
      method: { type: String, enum: ["courier", "company", "collection"] },
      handler: { type: String, trim: true, maxlength: 120 },
      departedAt: Date,
      returnedAt: Date,
      slotsReturnedAt: Date,
    }, { _id: false }), default: undefined },
    deliveryHistory: { type: [{
      action: { type: String, enum: ["departed", "delivered", "collected", "returned", "reshelved"] },
      method: { type: String, enum: ["courier", "company", "collection"] },
      handler: String,
      actor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      actorName: String,
      note: { type: String, maxlength: 500 },
      at: { type: Date, default: Date.now },
    }], default: [], select: false },
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
    reservationRevision: { type: Number, default: 0, select: false },

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
orderSchema.index({ createdAt: -1, _id: -1 });
orderSchema.index({ status: 1, createdAt: -1, _id: -1 });
orderSchema.index({ user: 1, createdAt: -1, _id: -1 });
orderSchema.index({ invoice: 1, createdAt: -1, _id: -1 });

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
