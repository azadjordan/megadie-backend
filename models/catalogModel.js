import mongoose from "mongoose";
import { PRODUCT_TYPES } from "../constants.js";

// One optional browsing catalog per product type. An inactive or absent catalog
// lets the shop navigate directly to the existing product results.
const catalogSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    productType: {
      type: String,
      enum: PRODUCT_TYPES,
      required: true,
    },
    // Only the Ribbon color-grid layout is implemented in this first schema.
    layout: {
      type: String,
      enum: ["color-grid"],
      default: "color-grid",
      required: true,
    },
    isActive: { type: Boolean, default: false },
  },
  { timestamps: true, strict: "throw", autoCreate: false, autoIndex: false }
);

catalogSchema.index({ productType: 1 }, { unique: true });

const Catalog = mongoose.model("Catalog", catalogSchema);
export default Catalog;
