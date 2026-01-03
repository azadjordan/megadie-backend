// models/priceRuleModel.js
import mongoose from "mongoose";

const priceRuleSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      trim: true,
      unique: true,
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
