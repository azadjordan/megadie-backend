// models/slotModel.js
import mongoose from "mongoose";

const slotSchema = new mongoose.Schema(
  {
    store:    { type: String, required: true, trim: true },
    unit:     { type: String, required: true, trim: true },  // e.g. "A"
    position: { type: Number, required: true, min: 1, max: 16 },
    label:    { type: String, required: true, trim: true },  // e.g. "A1"

    cbm:      { type: Number, required: true, min: 0 },      // slot capacity in m³
    isActive: { type: Boolean, default: true },
    notes:    { type: String, trim: true },
  },
  { timestamps: true }
);

// Unique within a store
slotSchema.index({ store: 1, unit: 1, position: 1 }, { unique: true });

// Auto-generate label like “A1”
slotSchema.pre("validate", function (next) {
  if (this.unit && this.position != null) this.label = `${this.unit}${this.position}`;
  next();
});

const Slot = mongoose.models.Slot || mongoose.model("Slot", slotSchema);
export default Slot;
