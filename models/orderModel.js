import mongoose from "mongoose";

const orderSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
    orderNumber: {
      type: String,
      required: true,
      unique: true,
    },
    orderItems: [
      {
        product: {
          type: mongoose.Schema.Types.ObjectId,
          required: true,
          ref: "Product",
        },
        productName: { type: String, required: true },
        qty: { type: Number, required: true },
        unitPrice: { type: Number, required: true },
      },
    ],
    invoice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
    },
    totalPrice: { type: Number, required: true, default: 0.0 },
    deliveryCharge: { type: Number, required: true, default: 0.0 },
    extraFee: { type: Number, required: true, default: 0.0 },

    // ✅ Leave empty if not filled — no need to default to empty string
    deliveredBy: { type: String },

    isDelivered: { type: Boolean, required: true, default: false },
    deliveredAt: { type: Date },

    status: {
      type: String,
      enum: ["Processing", "Delivered", "Returned", "Cancelled"],
      default: "Processing",
    },

    // ✅ Notes: if not provided, should be undefined, not an empty string
    clientToAdminNote: { type: String },
    adminToAdminNote: { type: String },
    adminToClientNote: { type: String },

    stockUpdated: { type: Boolean, required: true, default: false },
    invoiceGenerated: { type: Boolean, required: true, default: false },
  },
  { timestamps: true }
);

// 🔄 Auto-generate order number before validation
orderSchema.pre("validate", async function (next) {
  if (!this.orderNumber) {
    const lastOrder = await mongoose
      .model("Order")
      .findOne({})
      .sort({ createdAt: -1 })
      .lean();

    const lastNumber = lastOrder?.orderNumber?.split("-")[1] || "00000";
    const nextNumber = String(parseInt(lastNumber) + 1).padStart(5, "0");

    this.orderNumber = `ORD-${nextNumber}`;
  }

  next();
});

const Order = mongoose.model("Order", orderSchema);
export default Order;
