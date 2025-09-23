import mongoose from "mongoose";

const invoiceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    payments: [{ type: mongoose.Schema.Types.ObjectId, ref: "Payment" }],
    invoiceNumber: { type: String, required: true, unique: true },
    amountDue: { type: Number, required: true },
    amountPaid: { type: Number, default: 0 },
    dueDate: { type: Date },
    paidAt: { type: Date },
    status: {
      type: String,
      enum: ["Unpaid", "Partially Paid", "Paid", "Overdue"],
      default: "Unpaid",
    },
    adminNote: { type: String },
  },
  { timestamps: true }
);

// ✅ Simple time-based invoice number generator
invoiceSchema.pre("validate", function (next) {
  if (!this.invoiceNumber) {
    const now = new Date();
    // Example: 20250923-105913-274 (YYYYMMDD-HHmmss-SSS)
    const formatted =
      now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 15) +
      "-" +
      now.getMilliseconds().toString().padStart(3, "0");

    this.invoiceNumber = `INV-${formatted}`;
  }
  next();
});

const Invoice =
  mongoose.models.Invoice || mongoose.model("Invoice", invoiceSchema);
export default Invoice;
