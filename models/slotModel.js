// models/slotModel.js
import mongoose from "mongoose";
import {
  SLOT_STORES,
  SLOT_UNITS,
  SLOT_POSITIONS,
} from "../constants.js";

const slotSchema = new mongoose.Schema(
  {
    store: {
      type: String,
      required: true,
      trim: true,
      enum: SLOT_STORES, // "AE1", etc.
    },
    unit: {
      type: String,
      required: true,
      trim: true,
      enum: SLOT_UNITS,  // "A"–"N"
    },
    position: {
      type: Number,
      required: true,
      enum: SLOT_POSITIONS, // 1–16
      min: 1,
      max: 16,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    cbm: {
      type: Number,
      required: true,
      min: 0,
    },
    occupiedCbm: {
      type: Number,
      default: 0,
      min: 0,
    },
    fillPercent: {
      type: Number,
      default: 0,
      min: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    notes: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

// Unique within a store
slotSchema.index({ store: 1, unit: 1, position: 1 }, { unique: true });

// Auto-generate label like “A1-AE1”
slotSchema.pre("validate", function (next) {
  if (this.store && this.unit && this.position != null) {
    this.label = `${this.unit}${this.position}-${this.store}`;
  }
  next();
});

const Slot = mongoose.models.Slot || mongoose.model("Slot", slotSchema);
export default Slot;
