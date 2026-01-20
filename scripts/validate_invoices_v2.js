import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env.development") });

const BATCH_SIZE = 200;
const PAYMENT_STATUS_VALUES = ["Unpaid", "PartiallyPaid", "Paid"];
const STATUS_VALUES = ["Issued", "Cancelled"];
const LEGACY_FIELDS = ["payments", "amountDue", "amountPaid", "paidAt"];

const ensureMongoUri = () => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is not set in the environment.");
  }
};

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const isValidNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

const isValidInteger = (value) =>
  Number.isInteger(value) && Number.isFinite(value);

const normalizeDateValue = (value) => {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const computePaymentStatus = (amountMinor, paidTotalMinor) => {
  const amount = Math.max(0, Number(amountMinor) || 0);
  const paid = Math.max(0, Number(paidTotalMinor) || 0);

  if (paid <= 0) return "Unpaid";
  if (paid >= amount) return "Paid";
  return "PartiallyPaid";
};

const buildOrderDuplicateMap = async () => {
  const duplicates = await mongoose.connection
    .collection("invoices")
    .aggregate([
      { $match: { order: { $exists: true, $ne: null } } },
      { $sort: { createdAt: 1, _id: 1 } },
      {
        $group: {
          _id: "$order",
          ids: { $push: "$_id" },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  const conflictMap = new Map();

  duplicates.forEach((group) => {
    const ids = group.ids || [];
    if (ids.length <= 1) return;
    conflictMap.set(group._id.toString(), {
      keepId: ids[0],
      dropIds: ids.slice(1),
    });
  });

  return conflictMap;
};

const validateInvoice = (invoice, duplicateMap) => {
  const errors = [];

  if (!isValidObjectId(invoice.user)) {
    errors.push("user is required.");
  }

  if (!isValidObjectId(invoice.order)) {
    errors.push("order is required.");
  }

  if (
    typeof invoice.invoiceNumber !== "string" ||
    invoice.invoiceNumber.trim() === ""
  ) {
    errors.push("invoiceNumber is required.");
  }

  if (!isValidInteger(invoice.amountMinor) || invoice.amountMinor < 0) {
    errors.push("amountMinor must be an integer >= 0.");
  }

  if (!isValidInteger(invoice.paidTotalMinor) || invoice.paidTotalMinor < 0) {
    errors.push("paidTotalMinor must be an integer >= 0.");
  }

  if (!isValidInteger(invoice.balanceDueMinor) || invoice.balanceDueMinor < 0) {
    errors.push("balanceDueMinor must be an integer >= 0.");
  }

  if (isValidInteger(invoice.amountMinor) && isValidInteger(invoice.paidTotalMinor)) {
    const expectedBalance = Math.max(
      0,
      invoice.amountMinor - invoice.paidTotalMinor
    );
    if (invoice.balanceDueMinor !== expectedBalance) {
      errors.push("balanceDueMinor does not match amountMinor - paidTotalMinor.");
    }

    const expectedPaymentStatus = computePaymentStatus(
      invoice.amountMinor,
      invoice.paidTotalMinor
    );
    if (invoice.paymentStatus !== expectedPaymentStatus) {
      errors.push("paymentStatus does not match amountMinor/paidTotalMinor.");
    }
  }

  if (!PAYMENT_STATUS_VALUES.includes(invoice.paymentStatus)) {
    errors.push(
      `paymentStatus must be one of ${PAYMENT_STATUS_VALUES.join(", ")}.`
    );
  }

  if (!STATUS_VALUES.includes(invoice.status)) {
    errors.push(`status must be one of ${STATUS_VALUES.join(", ")}.`);
  }

  if (typeof invoice.currency !== "string" || invoice.currency.trim() === "") {
    errors.push("currency must be a non-empty string.");
  }

  if (!isValidInteger(invoice.minorUnitFactor) || invoice.minorUnitFactor < 1) {
    errors.push("minorUnitFactor must be an integer >= 1.");
  }

  const dueDate = normalizeDateValue(invoice.dueDate);
  if (!dueDate) {
    errors.push("dueDate is required and must be a valid date.");
  }

  LEGACY_FIELDS.forEach((field) => {
    if (invoice[field] != null) {
      errors.push(`${field} must be removed from invoices.`);
    }
  });

  if (invoice.order && duplicateMap.has(invoice.order.toString())) {
    const { keepId } = duplicateMap.get(invoice.order.toString());
    if (keepId.toString() !== invoice._id.toString()) {
      errors.push("duplicate invoice for order detected.");
    }
  }

  return errors;
};

const runValidation = async () => {
  ensureMongoUri();
  await mongoose.connect(process.env.MONGO_URI);

  console.log(`Connected to database: ${mongoose.connection.name}`);

  const counts = {
    scanned: 0,
    passed: 0,
    failed: 0,
  };

  const duplicateMap = await buildOrderDuplicateMap();

  const cursor = mongoose.connection
    .collection("invoices")
    .find({}, { batchSize: BATCH_SIZE });

  for await (const invoice of cursor) {
    counts.scanned += 1;

    const errors = validateInvoice(invoice, duplicateMap);
    if (errors.length > 0) {
      counts.failed += 1;
      errors.forEach((error) => {
        console.error(`Invoice ${invoice._id}: ${error}`);
      });
    } else {
      counts.passed += 1;
    }
  }

  console.log("Validation complete.");
  console.log(`Scanned: ${counts.scanned}`);
  console.log(`Passed: ${counts.passed}`);
  console.log(`Failed: ${counts.failed}`);

  await mongoose.disconnect();
};

runValidation().catch((error) => {
  console.error("Validation failed:", error.message || error);
  mongoose.disconnect();
  process.exitCode = 1;
});
