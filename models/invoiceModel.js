import mongoose from "mongoose";

const invoiceSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    payments: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Payment",
      },
    ],
    invoiceNumber: {
      type: String,
      required: true,
      unique: true,
    },
    amountDue: {
      type: Number,
      required: true,
    },
    amountPaid: {
      type: Number,
      default: 0,
    },
    dueDate: {
      type: Date,
    },
    paidAt: {
      type: Date,
    },
    status: {
      type: String,
      enum: ["Unpaid", "Partially Paid", "Paid", "Overdue"],
      default: "Unpaid",
    },

    // ✅ Removed default empty string (it's better to omit empty notes)
    adminNote: {
      type: String,
    },
  },
  { timestamps: true }
);

// 🔄 Auto-generate invoice number before saving
invoiceSchema.pre("validate", async function (next) {
  if (!this.invoiceNumber) {
    const lastInvoice = await mongoose
      .model("Invoice")
      .findOne({})
      .sort({ createdAt: -1 })
      .lean();

    const lastNumber = lastInvoice?.invoiceNumber?.split("-")[1] || "00000";
    const nextNumber = String(parseInt(lastNumber) + 1).padStart(5, "0");

    this.invoiceNumber = `INV-${nextNumber}`;
  }

  next();
});

const Invoice = mongoose.model("Invoice", invoiceSchema);
export default Invoice;
