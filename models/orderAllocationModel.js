// models/orderAllocationModel.js
import mongoose from "mongoose";

const orderAllocationSchema = new mongoose.Schema(
  {
    order:   { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    slot:    { type: mongoose.Schema.Types.ObjectId, ref: "Slot", required: true, index: true },

    qty: { type: Number, required: true, min: 1 },

    status: {
      type: String,
      enum: ["Reserved", "Deducted", "Cancelled"],
      default: "Reserved",
      index: true,
    },
    deductedAt: { type: Date },
    deductedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },

    // Who applied the allocation (admin user)
    by:   { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },

    note: { type: String, trim: true },
    expiresAt: { type: Date },
  },
  { timestamps: true }
);

// Enforce one row per (order, product, slot)
// If you need to increase qty for same slot, update this doc instead of creating another.
orderAllocationSchema.index({ order: 1, product: 1, slot: 1 }, { unique: true });

// Common queries
orderAllocationSchema.index({ order: 1, createdAt: -1 });
orderAllocationSchema.index({ product: 1, createdAt: -1 });
orderAllocationSchema.index({ slot: 1, createdAt: -1 });
orderAllocationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

orderAllocationSchema.set("toJSON", {
  versionKey: false,
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
  },
});

const OrderAllocation =
  mongoose.models.OrderAllocation || mongoose.model("OrderAllocation", orderAllocationSchema);

export default OrderAllocation;
