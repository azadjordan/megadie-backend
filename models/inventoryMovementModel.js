// models/inventoryMovementModel.js
import mongoose from "mongoose";

export const INVENTORY_MOVEMENT_TYPES = [
  "ADD",
  "MOVE",
  "ADJUST",
  "REMOVE_ITEM",
  "DEDUCT",
];

const inventoryMovementSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, enum: INVENTORY_MOVEMENT_TYPES, index: true },

    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },

    // For MOVE: both set
    fromSlot: { type: mongoose.Schema.Types.ObjectId, ref: "Slot", index: true },
    toSlot:   { type: mongoose.Schema.Types.ObjectId, ref: "Slot", index: true },

    qty: { type: Number, required: true, min: 0 },

    // Who did it
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },

    // Link to order when type=DEDUCT (and optionally for MOVE/ADJUST etc if you ever want)
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", index: true },

    // Useful for ADJUST (Cycle count, Damage, Correction...)
    reason: { type: String, trim: true },

    note: { type: String, trim: true },
  },
  { timestamps: true }
);

// Indexes tuned for your UI queries
inventoryMovementSchema.index({ createdAt: -1 });
inventoryMovementSchema.index({ type: 1, createdAt: -1 });
inventoryMovementSchema.index({ product: 1, createdAt: -1 });
inventoryMovementSchema.index({ fromSlot: 1, createdAt: -1 });
inventoryMovementSchema.index({ toSlot: 1, createdAt: -1 });
inventoryMovementSchema.index({ order: 1, createdAt: -1 });

inventoryMovementSchema.set("toJSON", {
  versionKey: false,
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
  },
});

const InventoryMovement =
  mongoose.models.InventoryMovement || mongoose.model("InventoryMovement", inventoryMovementSchema);

export default InventoryMovement;
