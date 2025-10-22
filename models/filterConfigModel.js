import mongoose from "mongoose";
import { PRODUCT_TYPES, FILTER_FIELD_TYPES, FILTER_UI_TYPES } from "../constants.js";

const filterFieldSchema = new mongoose.Schema(
  {
    key:           { type: String, required: true },                 // "categoryKey","size","catalogCode","parentColor"
    label:         { type: String, required: true },
    type:          { type: String, enum: FILTER_FIELD_TYPES, required: true },
    allowedValues: { type: [String], default: [] },
    multi:         { type: Boolean, default: true },
    ui:            { type: String, enum: FILTER_UI_TYPES, default: "chips" },
    sort:          { type: Number, default: 0 },
  },
  { _id: false }
);

const filterConfigSchema = new mongoose.Schema(
  {
    productType: { type: String, enum: PRODUCT_TYPES, required: true, unique: true },
    fields:      { type: [filterFieldSchema], default: [] },
  },
  { timestamps: true }
);

const FilterConfig = mongoose.model("FilterConfig", filterConfigSchema);
export default FilterConfig;
