import mongoose from "mongoose";
import { PRODUCT_TYPES } from "../constants.js";

const categorySchema = new mongoose.Schema(
  {
    key:         { type: String, required: true, trim: true },
    label:       { type: String, required: true, trim: true },
    productType: { type: String, enum: PRODUCT_TYPES, required: true },
    imageUrl:    { type: String, trim: true },
    isActive:    { type: Boolean, default: true },
    sort:        { type: Number, default: 0 },
  },
  { timestamps: true }
);

categorySchema.index({ productType: 1, key: 1 }, { unique: true });

const Category = mongoose.model("Category", categorySchema);
export default Category;
