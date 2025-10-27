// models/orderModel.js
import mongoose from "mongoose";
import crypto from "crypto";

const OrderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    sku: { type: String, required: true, trim: true },
    qty: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    lineTotal: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "User", index: true },

    orderNumber: { type: String, required: true, unique: true, index: true },

    // One-to-one optional link to Invoice; must be set only after delivery
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", default: null, index: true },

    orderItems: {
      type: [OrderItemSchema],
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length > 0,
        message: "At least one order item is required.",
      },
      required: true,
    },

    totalPrice: { type: Number, required: true, default: 0, min: 0 },
    deliveryCharge: { type: Number, required: true, default: 0, min: 0 },
    extraFee: { type: Number, required: true, default: 0, min: 0 },

    deliveredBy: { type: String },
    deliveredAt: { type: Date },

    status: {
      type: String,
      enum: ["Processing", "Delivered", "Cancelled"],
      default: "Processing",
      index: true,
    },

    clientToAdminNote: { type: String },
    adminToAdminNote: { type: String },
    adminToClientNote: { type: String },

    stockUpdated: { type: Boolean, default: false },
  },
  { timestamps: true }
);

/* ------------ Virtuals ------------ */
orderSchema.virtual("isDelivered").get(function () {
  return this.status === "Delivered";
});

// Backward-compatible virtual (replaces the old stored flag)
orderSchema.virtual("invoiceGenerated").get(function () {
  return !!this.invoice;
});

/* ------------ Validators & Business Rules ------------ */
// Only allow attaching an invoice when the order is Delivered
orderSchema.path("invoice").validate(function (val) {
  if (val && this.status !== "Delivered") return false;
  return true;
}, "Invoice can only be attached after the order is delivered.");

/* ------------ Hooks ------------ */
// Generate order number & compute totals; stamp deliveredAt when first delivered
orderSchema.pre("validate", function (next) {
  try {
    // ORD-YYMMDD-XXXXXX
    if (!this.orderNumber) {
      const now = new Date();
      const yy = String(now.getFullYear()).slice(-2);
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const randomHex = crypto.randomBytes(3).toString("hex").toUpperCase();
      this.orderNumber = `ORD-${yy}${mm}${dd}-${randomHex}`;
    }

    // Recompute line totals & grand total
    let itemsSum = 0;
    this.orderItems = (this.orderItems || []).map((it) => {
      const unit = typeof it.unitPrice === "number" ? it.unitPrice : 0;
      const qty = typeof it.qty === "number" ? it.qty : 0;
      const lineTotal = Math.max(0, unit * qty);
      itemsSum += lineTotal;

      const base = typeof it.toObject === "function" ? it.toObject() : it;
      return { ...base, lineTotal };
    });

    const delivery = this.deliveryCharge || 0;
    const extra = this.extraFee || 0;
    this.totalPrice = Math.max(0, itemsSum + delivery + extra);

    // Stamp deliveredAt once when moving to Delivered
    if (this.status === "Delivered" && !this.deliveredAt) {
      this.deliveredAt = new Date();
    }

    next();
  } catch (err) {
    next(err);
  }
});

/* ------------ Serialization ------------ */
orderSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
  },
});

/* ------------ Indexes ------------ */
orderSchema.index({ user: 1, createdAt: -1 });

// Ensure one invoice cannot be linked to multiple orders
orderSchema.index(
  { invoice: 1 },
  { unique: true, partialFilterExpression: { invoice: { $exists: true, $ne: null } } }
);

const Order = mongoose.models.Order || mongoose.model("Order", orderSchema);
export default Order;
