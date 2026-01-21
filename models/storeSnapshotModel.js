// models/storeSnapshotModel.js
import mongoose from "mongoose";

const slotSummarySchema = new mongoose.Schema({
  slotId: { type: mongoose.Schema.Types.ObjectId, ref: "Slot", required: true },
  label:  { type: String, required: true },
  capacityCbm: { type: Number, required: true, min: 0 },
  occupiedCbm: { type: Number, required: true, min: 0 },
  freeCbm:     { type: Number, required: true, min: 0 },
}, { _id: false });

const unitSummarySchema = new mongoose.Schema({
  capacityCbm: { type: Number, required: true, min: 0 },
  occupiedCbm: { type: Number, required: true, min: 0 },
  freeCbm:     { type: Number, required: true, min: 0 },
  // O(1) lookups by label + stable rendering order
  slotsByLabel: { type: Map, of: slotSummarySchema, default: {} },
  slotsOrdered: { type: [slotSummarySchema], default: [] },
}, { _id: false });

const storeSnapshotSchema = new mongoose.Schema({
  store: { type: String, required: true, unique: true, index: true },
  totals: {
    capacityCbm: { type: Number, required: true, default: 0 },
    occupiedCbm: { type: Number, required: true, default: 0 },
    freeCbm:     { type: Number, required: true, default: 0 },
    nUnits:      { type: Number, required: true, default: 0 },
    nSlots:      { type: Number, required: true, default: 0 },
    nSlotItems:  { type: Number, required: true, default: 0 },
  },
  units: { type: Map, of: unitSummarySchema, default: {} },
  generatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

export default mongoose.models.StoreSnapshot ||
  mongoose.model("StoreSnapshot", storeSnapshotSchema);
