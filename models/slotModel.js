import mongoose from "mongoose";

const slotSchema = new mongoose.Schema(
  {
    // High-level place (e.g. "Warehouse", "Garage", "Floor")
    store: { type: String, required: true, trim: true },

    // Sub-division inside the store (e.g. "A", "Rack-1", "Zone-3")
    unit: { type: String, required: true, trim: true },

    // Unique identifier used as the slot code (e.g. "A1", "GAR-LEFT")
    code: { type: String, required: true, trim: true, unique: true },

    isActive: { type: Boolean, default: true },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

// Helpful indexes
slotSchema.index({ store: 1, unit: 1 });

const Slot = mongoose.model("Slot", slotSchema);
export default Slot;
