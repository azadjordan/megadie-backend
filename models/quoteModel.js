// models/quoteModel.js (MVP additions + availabilityCheckedAt)
import mongoose from "mongoose";
import crypto from "crypto";

/* =========================
   Subschema: Requested Item
   ========================= */
const requestedItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    productName: { type: String, trim: true },

    // ✅ Admin UI needs to allow qty = 0
    qty: { type: Number, required: true, default: 0, min: [0, "Quantity must be at least 0"] },

    // ✅ unitPrice can be 0
    unitPrice: { type: Number, required: true, default: 0, min: [0, "Unit price cannot be negative"] },

    // Pricing rule code (legacy; pricing derives from Product at assign time)
    priceRule: { type: String, trim: true, default: null },

    /* ---- Availability snapshot (computed in controller/service, NOT here) ---- */
    availableNow: { type: Number, required: true, default: 0, min: 0 },
    shortage:     { type: Number, required: true, default: 0, min: 0 },
    availabilityStatus: {
      type: String,
      enum: ["AVAILABLE", "PARTIAL", "SHORTAGE", "NOT_AVAILABLE"],
      default: "NOT_AVAILABLE",
      required: true,
    },
  },
  { _id: false }
);

/* =========================
   Main schema: Quote
   ========================= */
const quoteSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    // ✅ Human-friendly quote identifier (like orderNumber)
    // Format: QTE-YYMMDD-XXXXXX
    quoteNumber: { type: String, required: true, unique: true, index: true },

    // ✅ Link to Order (set when admin creates an order from this quote)
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },

    requestedItems: {
      type: [requestedItemSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "Quote must contain at least one item.",
      },
      required: true,
    },

    deliveryCharge: { type: Number, required: true, default: 0, min: [0, "Delivery charge cannot be negative"] },
    extraFee:       { type: Number, required: true, default: 0, min: [0, "Extra fee cannot be negative"] },
    totalPrice:     { type: Number, required: true, default: 0, min: [0, "Total price cannot be negative"] },

    status: {
      type: String,
      enum: ["Processing", "Quoted", "Confirmed", "Cancelled"],
      default: "Processing",
      index: true,
    },

    // ✅ Quote-level timestamp for the snapshot
    // - set whenever you compute availability snapshot (on create, or admin refresh)
    availabilityCheckedAt: { type: Date, default: null, index: true },

    adminToAdminNote:  { type: String },
    clientToAdminNote: { type: String },
    adminToClientNote: { type: String },

    clientQtyEditLocked: { type: Boolean, default: false },
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
quoteSchema.virtual("isOrderCreated").get(function () {
  return Boolean(this.order);
});

/* =========================
   Hooks
   ========================= */
// Generate quote number before validation (required/unique)
quoteSchema.pre("validate", function (next) {
  try {
    if (!this.quoteNumber) {
      const now = new Date();
      const yy = String(now.getFullYear()).slice(-2);
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const randomHex = crypto.randomBytes(3).toString("hex").toUpperCase();
      this.quoteNumber = `QTE-${yy}${mm}${dd}-${randomHex}`;
    }
    next();
  } catch (err) {
    next(err);
  }
});

// Recompute totals before save (availability snapshot is computed elsewhere)
quoteSchema.pre("save", function (next) {
  const items = this.requestedItems || [];

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

// ✅ Enforce 1:1 between Quote and Order (only when order != null)
quoteSchema.index(
  { order: 1 },
  { unique: true, partialFilterExpression: { order: { $exists: true, $ne: null } } }
);

/* =========================
   Model export
   ========================= */
const Quote = mongoose.models.Quote || mongoose.model("Quote", quoteSchema);
export default Quote;
