// megadie-backend/models/invoiceModel.js
import mongoose from "mongoose";
import crypto from "crypto";

/**
 * Invoice (currency-agnostic, integer minor units)
 *
 * Key decisions:
 * - Money is stored in integer minor units (amountMinor, paidTotalMinor, balanceDueMinor)
 * - Optional currency metadata is stored (currency, minorUnitFactor) for future multi-currency support
 * - Cached paid/status fields live on Invoice for fast "unpaid" queries and list pages
 * - Only Cancelled invoices can be deleted; deleting a Cancelled invoice deletes linked payments
 */

const invoiceSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // One-to-one with Order
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      unique: true,
    },

    /**
     * Monetary source of truth: integer minor units.
     * Examples (if factor=100): 10.50 -> 1050
     */
    amountMinor: {
      type: Number,
      required: true,
      min: 0,
      immutable: true,
    },

    /**
     * Optional currency metadata (safe to add now; doesn’t force AED naming)
     * - currency: ISO 4217 code (e.g., "AED", "USD", "EUR", "JPY")
     * - minorUnitFactor: how many minor units in 1 major unit (100 for cents/fils, 1 for JPY, etc.)
     *
     * If you don’t want currency yet, you can keep defaults and ignore at UI level.
     */
    currency: {
      type: String,
      trim: true,
      uppercase: true,
      default: "AED", // you can change global default later
      index: true,
    },
    minorUnitFactor: {
      type: Number,
      default: 100,
      min: 1,
    },

    invoiceNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["Issued", "Cancelled"],
      default: "Issued",
      index: true,
    },

    dueDate: { type: Date, required: true, index: true },

    // Admin-editable metadata (controller controls allowed edits)
    adminNote: { type: String, trim: true },

    cancelledAt: { type: Date },
    cancelReason: { type: String, trim: true },

    /**
     * Cached summary fields for fast list filtering:
     * - updated by Payment hooks
     */
    paidTotalMinor: { type: Number, default: 0, min: 0 },
    balanceDueMinor: { type: Number, default: 0, min: 0 },
    paymentStatus: {
      type: String,
      enum: ["Unpaid", "PartiallyPaid", "Paid"],
      default: "Unpaid",
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/* ---------------------------------
   Helpers
---------------------------------- */
function computePaymentStatus(amountMinor, paidTotalMinor) {
  const a = Math.max(0, Number(amountMinor) || 0);
  const p = Math.max(0, Number(paidTotalMinor) || 0);

  if (p <= 0) return "Unpaid";
  if (p >= a) return "Paid";
  return "PartiallyPaid";
}

invoiceSchema.methods.recomputeCaches = function recomputeCaches() {
  const amountMinor = Math.max(0, Number(this.amountMinor) || 0);
  const paidMinor = Math.max(0, Number(this.paidTotalMinor) || 0);

  this.balanceDueMinor = Math.max(0, amountMinor - paidMinor);
  this.paymentStatus = computePaymentStatus(amountMinor, paidMinor);
};

/* ---------------------------------
   Invoice number generation
---------------------------------- */
invoiceSchema.pre("validate", async function (next) {
  try {
    // Basic sanity for minorUnitFactor (keep it integer-ish)
    if (this.minorUnitFactor && !Number.isInteger(this.minorUnitFactor)) {
      return next(new Error("minorUnitFactor must be an integer."));
    }

    // Generate invoiceNumber if missing
    if (!this.invoiceNumber) {
      const now = new Date();
      const yy = String(now.getFullYear()).slice(-2);
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");

      for (let i = 0; i < 5; i++) {
        const rand = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6 chars
        const candidate = `INV-${yy}${mm}${dd}-${rand}`;
        const exists = await this.constructor.exists({
          invoiceNumber: candidate,
        });
        if (!exists) {
          this.invoiceNumber = candidate;
          break;
        }
      }

      if (!this.invoiceNumber) {
        return next(new Error("Failed to generate a unique invoice number."));
      }
    }

    // Ensure caches are correct at creation
    if (this.isNew) {
      if (typeof this.paidTotalMinor !== "number") this.paidTotalMinor = 0;
      this.recomputeCaches();
    }

    // If Cancelled, ensure cancelledAt is set
    if (this.status === "Cancelled" && !this.cancelledAt) {
      this.cancelledAt = new Date();
    }

    next();
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------
   Keep caches consistent on save
---------------------------------- */
invoiceSchema.pre("save", function (next) {
  try {
    if (this.isModified("paidTotalMinor")) {
      this.recomputeCaches();
    }
    next();
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------
   Virtual populate: payments
---------------------------------- */
invoiceSchema.virtual("payments", {
  ref: "Payment",
  localField: "_id",
  foreignField: "invoice",
});

/* ---------------------------------
   Deletion rule + cascade payments
   - Only Cancelled invoices can be deleted
   - Deleting a Cancelled invoice deletes all linked payments
---------------------------------- */

// Document deletion: invoiceDoc.deleteOne()
invoiceSchema.pre(
  "deleteOne",
  { document: true, query: false },
  async function (next) {
    try {
      if (this.status !== "Cancelled") {
        return next(new Error("Only Cancelled invoices can be deleted."));
      }

      const Payment = mongoose.model("Payment");
      await Payment.deleteMany({ invoice: this._id }); // ok because invoice is being deleted anyway
      next();
    } catch (err) {
      next(err);
    }
  }
);

// Query deletion: Invoice.findByIdAndDelete / findOneAndDelete
invoiceSchema.pre("findOneAndDelete", async function (next) {
  try {
    const doc = await this.model
      .findOne(this.getQuery())
      .select("_id status")
      .lean();
    if (!doc) return next();

    if (doc.status !== "Cancelled") {
      return next(new Error("Only Cancelled invoices can be deleted."));
    }

    const Payment = mongoose.model("Payment");
    await Payment.deleteMany({ invoice: doc._id });
    next();
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------
   Indexes for lists/filters
---------------------------------- */
invoiceSchema.index({ user: 1, createdAt: -1 });
invoiceSchema.index({ status: 1, createdAt: -1 });
invoiceSchema.index({ paymentStatus: 1, createdAt: -1 });
invoiceSchema.index({ user: 1, paymentStatus: 1, createdAt: -1 });
invoiceSchema.index({ currency: 1, createdAt: -1 });

const Invoice =
  mongoose.models.Invoice || mongoose.model("Invoice", invoiceSchema);
export default Invoice;
