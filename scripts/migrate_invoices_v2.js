import dotenv from "dotenv";
import mongoose from "mongoose";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env.development") });

const BATCH_SIZE = 200;
const FAILURE_PATH = path.resolve(
  "scripts",
  "_migration_failures_invoices_v2.json"
);
const PAYMENT_STATUS_VALUES = ["Unpaid", "PartiallyPaid", "Paid"];
const STATUS_VALUES = ["Issued", "Cancelled"];

const ensureMongoUri = () => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is not set in the environment.");
  }
};

const promptToContinue = async () => {
  const rl = readline.createInterface({ input, output });
  const answer = (await rl.question("Continue migration? (y/n) "))
    .trim()
    .toLowerCase();
  rl.close();

  if (answer !== "y") {
    console.log("Migration aborted.");
    return false;
  }

  return true;
};

const normalizeNumber = (value, fallback = 0) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, num);
};

const normalizeInteger = (value, fallback = 0) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.round(num));
};

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

const areValuesEqual = (current, next) => {
  if (current === next) return true;

  const currentDate = current instanceof Date ? current : null;
  const nextDate = next instanceof Date ? next : null;

  if (currentDate || nextDate) {
    if (!currentDate || !nextDate) return false;
    return currentDate.getTime() === nextDate.getTime();
  }

  return JSON.stringify(current) === JSON.stringify(next);
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

const buildUpdatesForInvoice = (invoice, duplicateMap, dueDateLog) => {
  const errors = [];

  if (!invoice.order) {
    errors.push("order is required.");
  }

  if (errors.length > 0) {
    return { errors };
  }

  const currency =
    typeof invoice.currency === "string" && invoice.currency.trim() !== ""
      ? invoice.currency.trim().toUpperCase()
      : "AED";

  const minorUnitFactor = Number.isInteger(invoice.minorUnitFactor)
    ? Math.max(1, invoice.minorUnitFactor)
    : 100;

  const amountMinor = Number.isFinite(invoice.amountMinor)
    ? normalizeInteger(invoice.amountMinor)
    : normalizeInteger(normalizeNumber(invoice.amountDue) * 100);

  const paidTotalMinor = Number.isFinite(invoice.paidTotalMinor)
    ? normalizeInteger(invoice.paidTotalMinor)
    : normalizeInteger(normalizeNumber(invoice.amountPaid) * 100);

  const balanceDueMinor = Math.max(0, amountMinor - paidTotalMinor);
  const paymentStatus = computePaymentStatus(amountMinor, paidTotalMinor);

  let status = "Issued";
  if (invoice.status === "Cancelled") {
    status = "Cancelled";
  }

  const duplicateEntry =
    invoice.order && duplicateMap.get(invoice.order.toString());
  const isDuplicate =
    duplicateEntry &&
    duplicateEntry.keepId.toString() !== invoice._id.toString();

  if (isDuplicate) {
    status = "Cancelled";
  }

  let dueDate = normalizeDateValue(invoice.dueDate);
  if (!dueDate) {
    const createdAt = normalizeDateValue(invoice.createdAt) ?? new Date();
    dueDate = new Date(createdAt.getTime());
    dueDate.setDate(dueDate.getDate() + 30);
    dueDateLog.push({
      _id: invoice._id,
      createdAt,
      dueDate,
    });
  }

  const setUpdates = {
    amountMinor,
    currency,
    minorUnitFactor,
    paidTotalMinor,
    balanceDueMinor,
    paymentStatus,
    status,
    dueDate,
  };

  if (status === "Cancelled") {
    if (!invoice.cancelledAt) {
      setUpdates.cancelledAt = new Date();
    }
    if (!invoice.cancelReason) {
      setUpdates.cancelReason = "Duplicate invoice for order migration.";
    }
  }

  if (!PAYMENT_STATUS_VALUES.includes(paymentStatus)) {
    errors.push("paymentStatus is invalid.");
  }

  if (!STATUS_VALUES.includes(status)) {
    errors.push("status is invalid.");
  }

  const unsetUpdates = {};
  if (invoice.payments != null) {
    unsetUpdates.payments = "";
  }
  if (invoice.amountDue != null) {
    unsetUpdates.amountDue = "";
  }
  if (invoice.amountPaid != null) {
    unsetUpdates.amountPaid = "";
  }
  if (invoice.paidAt != null) {
    unsetUpdates.paidAt = "";
  }

  const update = { $set: setUpdates };
  const hasUnset = Object.keys(unsetUpdates).length > 0;
  if (hasUnset) {
    update.$unset = unsetUpdates;
  }

  let hasChanges = hasUnset;
  if (!hasChanges) {
    hasChanges = Object.entries(setUpdates).some(([key, value]) => {
      const currentValue =
        key === "dueDate" || key === "cancelledAt"
          ? normalizeDateValue(invoice[key])
          : invoice[key];
      return !areValuesEqual(currentValue, value);
    });
  }

  return { update, hasChanges, errors, isDuplicate };
};

const flushBatch = async (operations, counts, failures) => {
  if (operations.length === 0) return;

  const pending = operations.length;

  try {
    const result = await mongoose.connection
      .collection("invoices")
      .bulkWrite(
        operations.map((item) => item.operation),
        { ordered: false }
      );
    counts.updated += result.modifiedCount;

    const failed = pending - result.modifiedCount;
    if (failed > 0) {
      counts.failed += failed;
    }
  } catch (error) {
    console.error("Batch update failed:", error.message || error);
    counts.failed += pending;
    operations.forEach((item) => {
      failures.push({
        _id: item._id,
        errors: [error.message || String(error)],
      });
    });
  }

  operations.length = 0;
};

const runMigration = async () => {
  ensureMongoUri();
  await mongoose.connect(process.env.MONGO_URI);

  console.log(`Connected to database: ${mongoose.connection.name}`);

  const shouldContinue = await promptToContinue();
  if (!shouldContinue) {
    await mongoose.disconnect();
    return;
  }

  const counts = {
    scanned: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  };

  const failures = [];
  const operations = [];
  const dueDateLog = [];

  const duplicateMap = await buildOrderDuplicateMap();
  if (duplicateMap.size > 0) {
    console.log("Duplicate invoices detected per order:");
    duplicateMap.forEach(({ keepId, dropIds }, orderId) => {
      console.log(
        `Order ${orderId}: keeping ${keepId.toString()} and cancelling ${dropIds
          .map((id) => id.toString())
          .join(", ")}`
      );
    });
  }

  const cursor = mongoose.connection
    .collection("invoices")
    .find({}, { batchSize: BATCH_SIZE });

  for await (const invoice of cursor) {
    counts.scanned += 1;

    const { update, hasChanges, errors } = buildUpdatesForInvoice(
      invoice,
      duplicateMap,
      dueDateLog
    );

    if (errors && errors.length > 0) {
      counts.failed += 1;
      failures.push({ _id: invoice._id, errors });
      errors.forEach((error) => {
        console.error(`Invoice ${invoice._id}: ${error}`);
      });
      continue;
    }

    if (!hasChanges) {
      counts.skipped += 1;
      continue;
    }

    operations.push({
      _id: invoice._id,
      operation: {
        updateOne: {
          filter: { _id: invoice._id },
          update: {
            ...update,
            $set: {
              ...update.$set,
              updatedAt: new Date(),
            },
          },
        },
      },
    });

    if (operations.length >= BATCH_SIZE) {
      await flushBatch(operations, counts, failures);
    }
  }

  await flushBatch(operations, counts, failures);

  if (dueDateLog.length > 0) {
    dueDateLog.forEach((entry) => {
      console.warn(
        `Invoice ${entry._id}: dueDate missing; set to ${entry.dueDate.toISOString()}.`
      );
    });
  }

  await fs.writeFile(FAILURE_PATH, JSON.stringify(failures, null, 2));

  console.log("Migration complete.");
  console.log(`Scanned: ${counts.scanned}`);
  console.log(`Updated: ${counts.updated}`);
  console.log(`Skipped: ${counts.skipped}`);
  console.log(`Failed: ${counts.failed}`);

  await mongoose.disconnect();
};

runMigration().catch((error) => {
  console.error("Migration failed:", error.message || error);
  mongoose.disconnect();
  process.exitCode = 1;
});
