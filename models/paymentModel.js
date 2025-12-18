// megadie-backend/models/paymentModel.js
import mongoose from "mongoose";

/**
 * Payment (currency-agnostic, integer minor units)
 *
 * Key decisions:
 * - No refunds: payments are always positive amountMinor > 0
 * - Payment belongs to an Issued invoice only (at creation time)
 * - Payment mirrors invoice.user (immutable) for fast filtering
 * - Hooks keep Invoice.paidTotalMinor / balanceDueMinor / paymentStatus in sync
 *
 * IMPORTANT:
 * - Invoice cache updates are done via an ATOMIC update pipeline to avoid concurrency bugs.
 * - Invoice.updatedAt IS updated when payments are created/deleted (so activity shows up in UI).
 */

const paymentSchema = new mongoose.Schema(
  {
    invoice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      required: true,
      immutable: true,
    },

    // Mirrors invoice.user for fast filtering
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },

    // Integer minor units (e.g., cents/fils)
    amountMinor: {
      type: Number,
      required: true,
      min: 1,
      immutable: true,
    },

    paymentMethod: {
      type: String,
      enum: ["Cash", "Bank Transfer", "Credit Card", "Cheque", "Other"],
      required: true,
      immutable: true,
    },

    paymentDate: {
      type: Date,
      default: Date.now,
      immutable: true,
    },

    note: { type: String, trim: true },
    reference: { type: String, trim: true },

    // Who received / processed the payment
    receivedBy: { type: String, required: true, trim: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/* ---------------------------------------
   Validation & rules
---------------------------------- */
paymentSchema.pre("validate", async function (next) {
  try {
    // Ensure integer minor units
    if (!Number.isInteger(this.amountMinor) || this.amountMinor <= 0) {
      return next(new Error("Payment amountMinor must be a positive integer."));
    }

    const Invoice = mongoose.model("Invoice");
    const inv = await Invoice.findById(this.invoice)
      .select("_id user status amountMinor paidTotalMinor currency minorUnitFactor")
      .lean();

    if (!inv) return next(new Error("Invoice not found."));

    // Creation rule: payments can only be added to Issued invoices.
    if (inv.status !== "Issued") {
      return next(new Error("Payments can only be added to Issued invoices."));
    }

    // Mirror invoice.user if not provided
    if (!this.user) this.user = inv.user;

    if (String(this.user) !== String(inv.user)) {
      return next(new Error("Payment user must match the invoice user."));
    }

    /**
     * Optional strict overpay prevention.
     * If true, blocks paidTotalMinor + amountMinor > invoice.amountMinor.
     * If false, overpay is allowed (invoice will still show Paid when paid >= amount).
     */
    const BLOCK_OVERPAY = false;
    if (BLOCK_OVERPAY) {
      const paid = Math.max(0, Number(inv.paidTotalMinor) || 0);
      const totalIfAdded = paid + this.amountMinor;
      if (totalIfAdded > (Number(inv.amountMinor) || 0)) {
        return next(new Error("Payment exceeds invoice amount."));
      }
    }

    next();
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------
   Invoice cache sync (CONCURRENCY SAFE)
---------------------------------- */

/**
 * Atomically apply a delta to Invoice.paidTotalMinor and recompute:
 * - balanceDueMinor = max(0, amountMinor - paidTotalMinor)
 * - paymentStatus:
 *    - Unpaid if paidTotalMinor <= 0
 *    - Paid if paidTotalMinor >= amountMinor
 *    - PartiallyPaid otherwise
 *
 * Also updates Invoice.updatedAt to "now" (so payment activity updates invoice recency).
 *
 * NOTE: Requires MongoDB 4.2+ (pipeline updates).
 */
async function applyInvoiceDeltaMinorAtomic(invoiceId, deltaMinor) {
  const Invoice = mongoose.model("Invoice");

  // Guard: only integers
  const delta = Number.isInteger(deltaMinor) ? deltaMinor : Number(deltaMinor) || 0;
  if (!delta) return;

  await Invoice.updateOne(
    { _id: invoiceId },
    [
      // Stage 1: adjust paidTotalMinor (clamp to >= 0)
      {
        $set: {
          paidTotalMinor: {
            $max: [0, { $add: ["$paidTotalMinor", delta] }],
          },
        },
      },
      // Stage 2: recompute derived caches + bump updatedAt
      {
        $set: {
          balanceDueMinor: {
            $max: [0, { $subtract: ["$amountMinor", "$paidTotalMinor"] }],
          },
          paymentStatus: {
            $cond: [
              { $lte: ["$paidTotalMinor", 0] },
              "Unpaid",
              {
                $cond: [
                  { $gte: ["$paidTotalMinor", "$amountMinor"] },
                  "Paid",
                  "PartiallyPaid",
                ],
              },
            ],
          },
          // MongoDB server time (preferred over client time)
          updatedAt: "$$NOW",
        },
      },
    ]
  );
}

/**
 * Track isNew so post-save knows whether to apply delta.
 * (We only apply delta for new payments; edits aren't allowed due to immutables.)
 */
paymentSchema.pre("save", function (next) {
  this._wasNew = this.isNew;
  next();
});

paymentSchema.post("save", async function (doc, next) {
  try {
    if (doc._wasNew) {
      await applyInvoiceDeltaMinorAtomic(doc.invoice, doc.amountMinor);
    }
    next();
  } catch (err) {
    next(err);
  }
});

/**
 * Deletions: apply negative delta.
 * Note: This runs for deleteOne() doc middleware and for findOneAndDelete query middleware.
 * It will NOT run for deleteMany (MongoDB doesn't run per-doc middleware for that).
 */

// Document deletion: paymentDoc.deleteOne()
paymentSchema.pre(
  "deleteOne",
  { document: true, query: false },
  async function (next) {
    try {
      await applyInvoiceDeltaMinorAtomic(this.invoice, -this.amountMinor);
      next();
    } catch (err) {
      next(err);
    }
  }
);

// Query deletion: Payment.findByIdAndDelete / findOneAndDelete
paymentSchema.pre("findOneAndDelete", async function (next) {
  try {
    const doc = await this.model
      .findOne(this.getQuery())
      .select("invoice amountMinor")
      .lean();

    if (!doc) return next();

    await applyInvoiceDeltaMinorAtomic(doc.invoice, -doc.amountMinor);
    next();
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------
   Indexes
---------------------------------- */
paymentSchema.index({ invoice: 1, paymentDate: -1 });
paymentSchema.index({ user: 1, paymentDate: -1 });

const Payment = mongoose.models.Payment || mongoose.model("Payment", paymentSchema);
export default Payment;
