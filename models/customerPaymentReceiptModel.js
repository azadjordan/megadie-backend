import mongoose from "mongoose";
import {
  PAYMENT_METHOD_OPTIONS,
  RECEIVED_BY_OPTIONS,
} from "./paymentModel.js";

const receiptAllocationSchema = new mongoose.Schema(
  {
    invoice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      required: true,
      immutable: true,
    },
    invoiceNumber: { type: String, trim: true, immutable: true },
    amountMinor: {
      type: Number,
      required: true,
      min: 1,
      immutable: true,
    },
    invoiceBalanceBeforeMinor: {
      type: Number,
      required: true,
      min: 0,
      immutable: true,
    },
    invoiceBalanceAfterMinor: {
      type: Number,
      required: true,
      min: 0,
      immutable: true,
    },
  },
  { _id: false }
);

const customerPaymentReceiptSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
      immutable: true,
    },
    amountMinor: {
      type: Number,
      required: true,
      min: 1,
      immutable: true,
    },
    allocatedTotalMinor: {
      type: Number,
      required: true,
      min: 1,
      immutable: true,
    },
    currency: {
      type: String,
      trim: true,
      uppercase: true,
      default: "AED",
      immutable: true,
    },
    minorUnitFactor: {
      type: Number,
      default: 100,
      min: 1,
      immutable: true,
    },
    paymentMethod: {
      type: String,
      enum: PAYMENT_METHOD_OPTIONS,
      required: true,
      immutable: true,
    },
    paymentDate: {
      type: Date,
      default: Date.now,
      immutable: true,
    },
    receivedBy: {
      type: String,
      required: true,
      trim: true,
      enum: RECEIVED_BY_OPTIONS,
    },
    reference: { type: String, trim: true },
    note: { type: String, trim: true },
    status: {
      type: String,
      enum: ["Applied"],
      default: "Applied",
      immutable: true,
    },
    allocations: {
      type: [receiptAllocationSchema],
      default: [],
      validate: {
        validator(value) {
          return Array.isArray(value) && value.length > 0;
        },
        message: "Receipt must include at least one allocation.",
      },
    },
  },
  { timestamps: true }
);

customerPaymentReceiptSchema.pre("validate", function validateReceipt(next) {
  try {
    if (!Number.isInteger(this.amountMinor) || this.amountMinor <= 0) {
      return next(new Error("Receipt amountMinor must be a positive integer."));
    }
    if (
      !Number.isInteger(this.allocatedTotalMinor) ||
      this.allocatedTotalMinor <= 0
    ) {
      return next(
        new Error("Receipt allocatedTotalMinor must be a positive integer.")
      );
    }
    if (this.allocatedTotalMinor !== this.amountMinor) {
      return next(new Error("Receipt allocations must equal the receipt amount."));
    }
    if (!Number.isInteger(this.minorUnitFactor) || this.minorUnitFactor <= 0) {
      return next(new Error("minorUnitFactor must be a positive integer."));
    }

    const allocationTotal = (this.allocations || []).reduce(
      (sum, allocation) => sum + (Number(allocation?.amountMinor) || 0),
      0
    );
    if (allocationTotal !== this.amountMinor) {
      return next(new Error("Allocation total must equal receipt amount."));
    }

    next();
  } catch (err) {
    next(err);
  }
});

customerPaymentReceiptSchema.index({ user: 1, paymentDate: -1 });
customerPaymentReceiptSchema.index({ reference: 1 });

const CustomerPaymentReceipt =
  mongoose.models.CustomerPaymentReceipt ||
  mongoose.model("CustomerPaymentReceipt", customerPaymentReceiptSchema);

export default CustomerPaymentReceipt;
