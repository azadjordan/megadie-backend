// models/inventoryMovementModel.js
import mongoose from "mongoose";

const movementSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ["ADJUST_IN", "ADJUST_OUT", "MOVE", "RESERVE", "RELEASE", "DEDUCT"],
      index: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    qty: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: "qty must be a whole number",
      },
    },

    // Primary slot (single-slot movements)
    slot: { type: mongoose.Schema.Types.ObjectId, ref: "Slot", index: true },

    // Move-specific slots
    fromSlot: { type: mongoose.Schema.Types.ObjectId, ref: "Slot", index: true },
    toSlot: { type: mongoose.Schema.Types.ObjectId, ref: "Slot", index: true },

    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", index: true },
    allocation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OrderAllocation",
      index: true,
    },

    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    note: { type: String, trim: true },

    unitCbm: { type: Number, min: 0 },
    cbm: { type: Number, min: 0 },

    meta: { type: mongoose.Schema.Types.Mixed },
    eventAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

movementSchema.index({ product: 1, eventAt: -1 });
movementSchema.index({ slot: 1, eventAt: -1 });
movementSchema.index({ fromSlot: 1, eventAt: -1 });
movementSchema.index({ toSlot: 1, eventAt: -1 });
movementSchema.index({ order: 1, eventAt: -1 });
movementSchema.index({ actor: 1, eventAt: -1 });
movementSchema.index({ type: 1, eventAt: -1 });

movementSchema.set("toJSON", {
  versionKey: false,
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
  },
});

const InventoryMovement =
  mongoose.models.InventoryMovement ||
  mongoose.model("InventoryMovement", movementSchema);

export default InventoryMovement;
