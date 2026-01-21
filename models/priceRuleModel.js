// models/priceRuleModel.js
import mongoose from "mongoose";
import { PRODUCT_TYPES } from "../constants.js";

const priceRuleSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    productType: {
      type: String,
      enum: PRODUCT_TYPES,
      required: true,
      index: true,
      trim: true,
    },
    defaultPrice: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { timestamps: true }
);

const PriceRule = mongoose.model("PriceRule", priceRuleSchema);
export default PriceRule;
