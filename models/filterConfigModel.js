// models/filterConfigModel.js
import mongoose from "mongoose";
import { PRODUCT_TYPES, FILTER_FIELD_TYPES, FILTER_UI_TYPES } from "../constants.js";

const allowedValueMetaSchema = new mongoose.Schema(
  {
    value: { type: String },
    label: { type: String },
    explanation: { type: String },
  },
  { _id: false }
);

const filterFieldSchema = new mongoose.Schema(
  {
    key:           { type: String, required: true },
    label:         { type: String, required: true },
    type:          { type: String, enum: FILTER_FIELD_TYPES, required: true },
    allowedValues: { type: [String], default: [] },
    allowedValueMeta: { type: [allowedValueMetaSchema], default: [] },
    multi:         { type: Boolean, default: true },
    ui:            { type: String, enum: FILTER_UI_TYPES, default: "chips" },
    sort:          { type: Number, default: 0 },
  },
  { _id: false }
);

const filterConfigSchema = new mongoose.Schema(
  {
    productType: { type: String, enum: PRODUCT_TYPES, required: true, unique: true },

    // ✅ NEW: controls product type order on the client (e.g., switcher order)
    sort: { type: Number, default: 0, index: true },

    fields: { type: [filterFieldSchema], default: [] },
  },
  { timestamps: true }
);

const FilterConfig = mongoose.model("FilterConfig", filterConfigSchema);
export default FilterConfig;
