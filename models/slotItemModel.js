import mongoose from "mongoose";

const slotItemSchema = new mongoose.Schema(
  {
    slot: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Slot",
      required: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    // Quantity of this product currently in this slot
    quantity: {
      type: Number,
      required: true,
      default: 0,
      min: [0, "Quantity cannot be negative"],
    },
  },
  { timestamps: true }
);

// Ensure only one row per product+slot
slotItemSchema.index({ product: 1, slot: 1 }, { unique: true });
// Quick lookups
slotItemSchema.index({ slot: 1 });
slotItemSchema.index({ product: 1 });

const SlotItem = mongoose.model("SlotItem", slotItemSchema);
export default SlotItem;
