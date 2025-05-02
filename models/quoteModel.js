import mongoose from "mongoose";

const quoteSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    requestedItems: [
      {
        product: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Product",
          required: true,
        },
        qty: { type: Number, required: true },
        unitPrice: { type: Number, required: true },
      },
    ],

    deliveryCharge: { type: Number, required: true, default: 0.0 },
    extraFee: { type: Number, required: true, default: 0.0 },
    totalPrice: { type: Number, required: true, default: 0.0 },

    status: {
      type: String,
      enum: ["Requested", "Quoted", "Confirmed", "Rejected"],
      default: "Requested",
    },

    adminToAdminNote: String,       // ✅ Removed default: ""
    clientToAdminNote: String,      // ✅ Removed default: ""
    adminToClientNote: String,      // ✅ Renamed for consistency, removed default

    isOrderCreated: { type: Boolean, default: false },
    createdOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
    },
  },
  { timestamps: true }
);

const Quote = mongoose.model("Quote", quoteSchema);
export default Quote;
