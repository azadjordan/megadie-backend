import mongoose from "mongoose";

const slotItemSchema = new mongoose.Schema(
  {
    slot:    { type: mongoose.Schema.Types.ObjectId, ref: "Slot", required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    quantity:{ type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true }
);

// Ensure one entry per (slot, product)
slotItemSchema.index({ product: 1, slot: 1 }, { unique: true });
slotItemSchema.index({ slot: 1 });
slotItemSchema.index({ product: 1 });

const SlotItem = mongoose.model("SlotItem", slotItemSchema);
export default SlotItem;
