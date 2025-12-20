// models/quoteModel.js
import mongoose from "mongoose";

/* =========================
   Subschema: Requested Item
   ========================= */
const requestedItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    // ✅ Admin UI needs to allow qty = 0 (do NOT force min 1)
    qty: {
      type: Number,
      required: true,
      default: 0,
      min: [0, "Quantity must be at least 0"],
    },

    // ✅ unitPrice can be 0
    unitPrice: {
      type: Number,
      required: true,
      default: 0,
      min: [0, "Unit price cannot be negative"],
    },
  },
  { _id: false }
);

/* =========================
   Main schema: Quote
   ========================= */
const quoteSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // ✅ Link to Order (set when admin creates an order from this quote)
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
      index: true,
    },

    requestedItems: {
      type: [requestedItemSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "Quote must contain at least one item.",
      },
      required: true,
    },

    deliveryCharge: {
      type: Number,
      required: true,
      default: 0,
      min: [0, "Delivery charge cannot be negative"],
    },

    extraFee: {
      type: Number,
      required: true,
      default: 0,
      min: [0, "Extra fee cannot be negative"],
    },

    totalPrice: {
      type: Number,
      required: true,
      default: 0,
      min: [0, "Total price cannot be negative"],
    },

    status: {
      type: String,
      enum: ["Processing", "Quoted", "Confirmed", "Cancelled"],
      default: "Processing",
      index: true,
    },

    adminToAdminNote: { type: String },
    clientToAdminNote: { type: String },
    adminToClientNote: { type: String },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, versionKey: false },
    toObject: { virtuals: true, versionKey: false },
  }
);

/* =========================
   Virtuals
   ========================= */
// ✅ Derived flag for UI (no risk of drift)
quoteSchema.virtual("isOrderCreated").get(function () {
  return Boolean(this.order);
});

/* =========================
   Hooks
   ========================= */
// Recompute totals before save
quoteSchema.pre("save", function (next) {
  const items = this.requestedItems || [];

  // ✅ (defensive) ensure no negatives slip through
  // (Schema already prevents negatives, but this keeps totals stable if raw data exists)
  const itemsTotal = items.reduce((sum, it) => {
    const qty = Math.max(0, Number(it.qty) || 0);
    const unitPrice = Math.max(0, Number(it.unitPrice) || 0);
    return sum + unitPrice * qty;
  }, 0);

  const delivery = Math.max(0, Number(this.deliveryCharge || 0));
  const extra = Math.max(0, Number(this.extraFee || 0));

  this.totalPrice = Math.max(0, itemsTotal + delivery + extra);
  next();
});

/* =========================
   Indexes
   ========================= */
quoteSchema.index({ user: 1, createdAt: -1 });
// Useful for admin dashboards / filtering "already converted to order"
quoteSchema.index({ order: 1, createdAt: -1 });

/* =========================
   Model export (avoid recompile in dev)
   ========================= */
const Quote = mongoose.models.Quote || mongoose.model("Quote", quoteSchema);
export default Quote;
