// models/slotItemModel.js
import mongoose from "mongoose";

const slotItemSchema = new mongoose.Schema(
  {
    // One SKU in one slot
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    slot:    { type: mongoose.Schema.Types.ObjectId, ref: "Slot", required: true, index: true },

    // Quantity currently stored in this slot for this product
    qty: { type: Number, required: true, min: 0 },

    // TOTAL CBM for this row (always recalculated = qty * product.cbm)
    cbm: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);

// Enforce one document per (product, slot)
slotItemSchema.index({ product: 1, slot: 1 }, { unique: true });

// Always recalc total CBM before validate (simple, reliable)
slotItemSchema.pre("validate", async function (next) {
  try {
    if (typeof this.qty !== "number" || this.qty < 0) {
      return next(new Error("qty must be a non-negative number"));
    }

    const Product = this.model("Product");
    const p = await Product.findById(this.product).select("cbm").lean();
    if (!p) return next(new Error("Invalid product"));

    const unitCbm = typeof p.cbm === "number" ? p.cbm : 0;
    this.cbm = (this.qty || 0) * unitCbm;

    // Final guard
    if (typeof this.cbm !== "number" || this.cbm < 0) this.cbm = 0;

    next();
  } catch (err) {
    next(err);
  }
});

slotItemSchema.set("toJSON", {
  versionKey: false,
  virtuals: true,
  transform: (_doc, ret) => { ret.id = ret._id; delete ret._id; },
});

const SlotItem = mongoose.models.SlotItem || mongoose.model("SlotItem", slotItemSchema);
export default SlotItem;
