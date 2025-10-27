import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
  {
    // Each payment belongs to one invoice
    invoice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      required: true,
      index: true,
    },

    // Mirrors invoice.user for fast filtering (auto-synced in hook)
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Single source of truth for amount
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },

    paymentMethod: {
      type: String,
      enum: ["Cash", "Bank Transfer", "Credit Card", "Cheque", "Other"],
      required: true,
    },

    paymentDate: {
      type: Date,
      default: Date.now,
      index: true,
    },

    note: { type: String, trim: true },

    // Status helps handle refunds or reversals
    status: {
      type: String,
      enum: ["Received", "Refunded"],
      default: "Received",
      index: true,
    },

    // Who physically received or processed the payment (cashier, admin, etc.)
    paidTo: {
      type: String,
      required: true,
      trim: true,
    },

    // Optional external reference (bank transfer ID, cheque number, etc.)
    reference: { type: String, trim: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/* ---------------------------------------
   Guards & Auto-sync (the 3 small guards)
   --------------------------------------- */
paymentSchema.pre("validate", async function (next) {
  try {
    // 0) Basic positive-amount check for received payments
    if (this.status === "Received" && !(this.amount > 0)) {
      return next(new Error("Received payments must have a positive amount."));
    }

    // Fetch the invoice to validate and sync fields
    const Invoice = mongoose.model("Invoice");
    const inv = await Invoice.findById(this.invoice).select("user amount").lean();
    if (!inv) return next(new Error("Invoice not found."));

    // 1) Auto-sync user from invoice if not provided
    if (!this.user) this.user = inv.user;

    // 2) Guard: user mismatch (if user is provided, must match invoice.user)
    if (String(this.user) !== String(inv.user)) {
      return next(new Error("Payment user must match the invoice user."));
    }

    // 3) (Optional) Overpay policy
    // If you want to block overpaying beyond invoice amount, set to true.
    const BLOCK_OVERPAY = false;
    if (BLOCK_OVERPAY && this.status === "Received") {
      const Payment = mongoose.model("Payment");
      const agg = await Payment.aggregate([
        { $match: { invoice: this.invoice, status: "Received" } },
        { $group: { _id: null, totalPaid: { $sum: "$amount" } } },
      ]);
      const alreadyPaid = agg?.[0]?.totalPaid || 0;
      if (alreadyPaid + this.amount > inv.amount) {
        return next(new Error("Payment exceeds invoice amount."));
      }
    }

    next();
  } catch (err) {
    next(err);
  }
});

/* ------------ Indexes ------------ */
paymentSchema.index({ invoice: 1, paymentDate: -1 });
paymentSchema.index({ user: 1, paymentDate: -1 });

const Payment = mongoose.models.Payment || mongoose.model("Payment", paymentSchema);
export default Payment;
