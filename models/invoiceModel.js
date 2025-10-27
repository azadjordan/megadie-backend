import mongoose from "mongoose";
import crypto from "crypto";

const invoiceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    // One-to-one with Order
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      unique: true,
      index: true,
    },

    // Single monetary source of truth
    amount: { type: Number, required: true, min: 0 },

    // Simple human-friendly number like the order number
    invoiceNumber: { type: String, required: true, unique: true, index: true },

    dueDate: { type: Date },
    adminNote: { type: String },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/* ---------------------------------
   Number gen + business validations
   --------------------------------- */
// Format: INV-YYMMDD-XXXXXX (no extra models)
invoiceSchema.pre("validate", async function (next) {
  try {
    // Generate a simple unique invoice number if missing
    if (!this.invoiceNumber) {
      const now = new Date();
      const yy = String(now.getFullYear()).slice(-2);
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");

      for (let i = 0; i < 3; i++) {
        const rand = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6 chars
        const candidate = `INV-${yy}${mm}${dd}-${rand}`;
        const exists = await mongoose.models.Invoice.exists({ invoiceNumber: candidate });
        if (!exists) {
          this.invoiceNumber = candidate;
          break;
        }
      }
      if (!this.invoiceNumber) {
        return next(new Error("Failed to generate a unique invoice number."));
      }
    }

    // Validate order state + default amount from order.totalPrice
    const Order = mongoose.model("Order");
    const ord = await Order.findById(this.order).select("status totalPrice user").lean();
    if (!ord) return next(new Error("Order not found."));
    if (ord.status !== "Delivered") {
      return next(new Error("Invoice can only be created for a Delivered order."));
    }

    // Default amount from order.totalPrice if not provided or invalid
    if (!(this.amount >= 0)) {
      this.amount = Math.max(0, ord.totalPrice || 0);
    }

    // Ensure invoice.user matches order.user
    if (String(this.user) !== String(ord.user)) {
      return next(new Error("Invoice user must match the order user."));
    }

    next();
  } catch (err) {
    next(err);
  }
});

/* ------------------------------
   Virtuals (computed properties)
   ------------------------------ */

// Virtual populate: get all payments linked to this invoice
invoiceSchema.virtual("payments", {
  ref: "Payment",
  localField: "_id",
  foreignField: "invoice",
});

// totalPaid/balanceDue/status are computed when payments are populated
invoiceSchema.virtual("totalPaid").get(function () {
  if (!this.populated("payments") || !Array.isArray(this.payments)) return undefined;
  return this.payments
    .filter((p) => p.status === "Received")
    .reduce((sum, p) => sum + (p.amount || 0), 0);
});

invoiceSchema.virtual("balanceDue").get(function () {
  const totalPaid = typeof this.totalPaid === "number" ? this.totalPaid : undefined;
  return typeof totalPaid === "number" ? Math.max(this.amount - totalPaid, 0) : undefined;
});

invoiceSchema.virtual("status").get(function () {
  const totalPaid = this.totalPaid;
  if (typeof totalPaid !== "number") return undefined;

  const fullyPaid = totalPaid >= this.amount;
  const hasAnyPayment = totalPaid > 0;
  const pastDue = !!this.dueDate && new Date() > this.dueDate && !fullyPaid;

  if (fullyPaid) return "Paid";
  if (pastDue) return "Overdue";
  if (hasAnyPayment) return "Partially Paid";
  return "Unpaid";
});

/* ------------ Indexes ------------ */
invoiceSchema.index({ user: 1, createdAt: -1 });

const Invoice = mongoose.models.Invoice || mongoose.model("Invoice", invoiceSchema);
export default Invoice;
