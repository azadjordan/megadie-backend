// models/clientPriceModel.js
import mongoose from "mongoose";

const clientPriceSchema = new mongoose.Schema(
  {
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",       // your user model
      required: true,
    },

    // Must match Product.priceRule
    priceRule: {
      type: String,
      required: true,
      trim: true,
    },

    unitPrice: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { timestamps: true }
);

// One price per (client, rule)
clientPriceSchema.index(
  { client: 1, priceRule: 1 },
  { unique: true }
);

const ClientPrice = mongoose.model("ClientPrice", clientPriceSchema);
export default ClientPrice;
