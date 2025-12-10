// models/userPriceModel.js
import mongoose from "mongoose";
import { PRICE_RULES } from "../constants.js";

const userPriceSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Must match Product.priceRule and constants.PRICE_RULES
    priceRule: {
      type: String,
      required: true,
      trim: true,
      enum: PRICE_RULES,      // ⬅️ tie to shared enum
    },

    unitPrice: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { timestamps: true }
);

// One price per (user, priceRule)
userPriceSchema.index({ user: 1, priceRule: 1 }, { unique: true });

// Optional: if you often query all users for a given priceRule:
// userPriceSchema.index({ priceRule: 1 });

const UserPrice = mongoose.model("UserPrice", userPriceSchema);
export default UserPrice;
