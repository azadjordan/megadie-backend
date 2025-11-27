import mongoose from "mongoose";

const requestedItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    qty: {
      type: Number,
      required: true,
      min: [1, "Quantity must be at least 1"],
    },
    unitPrice: {
      type: Number,
      required: true,
      default: 0,
      min: [0, "Unit price cannot be negative"],
    },
  },
  { _id: false }
);

const quoteSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    requestedItems: {
      type: [requestedItemSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "Quote must contain at least one item.",
      },
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
      enum: ["Processing", "Quoted", "Confirmed", "Rejected", "Cancelled"], // ← includes Cancelled
      default: "Processing", // ← replaces Requested
      index: true,
    },

    adminToAdminNote: String,
    clientToAdminNote: String,
    adminToClientNote: String,
  },
  { timestamps: true }
);

// Recompute totals before save
quoteSchema.pre("save", function (next) {
  const itemsTotal = (this.requestedItems || []).reduce(
    (sum, it) => sum + (Number(it.unitPrice) || 0) * (Number(it.qty) || 0),
    0
  );
  const delivery = Math.max(0, Number(this.deliveryCharge || 0));
  const extra = Math.max(0, Number(this.extraFee || 0));
  this.totalPrice = itemsTotal + delivery + extra;
  next();
});


const Quote = mongoose.model("Quote", quoteSchema);
export default Quote;
