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
  "_migration_failures_payments_v2.json"
);
const RECEIVED_BY_OPTIONS = [
  "Azad",
  "Momani",
  "Company Account",
  "Ahmad Emad",
];
const FALLBACK_RECEIVED_BY = "Unknown";
const LEGACY_FIELDS = ["amount", "paidTo", "status"];

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

const normalizeNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const normalizeForCompare = (value) => {
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizeForCompare(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, normalizeForCompare(val)])
    );
  }
  return value;
};

const areValuesEqual = (current, next) => {
  if (current === next) return true;
  return (
    JSON.stringify(normalizeForCompare(current)) ===
    JSON.stringify(normalizeForCompare(next))
  );
};

const computePaymentStatus = (amountMinor, paidTotalMinor) => {
  const amount = Math.max(0, Number(amountMinor) || 0);
  const paid = Math.max(0, Number(paidTotalMinor) || 0);

  if (paid <= 0) return "Unpaid";
  if (paid >= amount) return "Paid";
  return "PartiallyPaid";
};

const getInvoiceData = async (invoiceId, invoicesCollection, cache) => {
  if (!invoiceId) return null;

  const key = invoiceId.toString();
  if (cache.has(key)) return cache.get(key);

  const invoice = await invoicesCollection.findOne(
    { _id: new mongoose.Types.ObjectId(key) },
    { projection: { user: 1, status: 1, amountMinor: 1 } }
  );

  cache.set(key, invoice || null);
  return invoice || null;
};

const buildUpdatesForPayment = (payment, invoice) => {
  const errors = [];

  if (!payment.invoice) {
    errors.push("invoice is required.");
  }

  if (!invoice) {
    errors.push("invoice not found.");
    return { errors };
  }

  if (invoice.status === "Cancelled") {
    errors.push("Invoice is Cancelled");
    return { errors };
  }

  if (invoice.status !== "Issued") {
    errors.push("invoice status must be Issued.");
  }

  let amountMinor = payment.amountMinor;
  if (!Number.isInteger(amountMinor) || amountMinor < 1) {
    const amount = normalizeNumber(payment.amount);
    if (amount == null) {
      errors.push("amount is invalid.");
    } else {
      amountMinor = Math.max(1, Math.round(amount * 100));
    }
  }

  let receivedBy = payment.receivedBy;
  const paidTo =
    typeof payment.paidTo === "string" ? payment.paidTo.trim() : "";
  let note = typeof payment.note === "string" ? payment.note.trim() : "";

  if (!RECEIVED_BY_OPTIONS.includes(receivedBy) && receivedBy !== FALLBACK_RECEIVED_BY) {
    if (RECEIVED_BY_OPTIONS.includes(paidTo)) {
      receivedBy = paidTo;
    } else {
      receivedBy = FALLBACK_RECEIVED_BY;
      if (paidTo) {
        const legacyNote = `Original paidTo: ${paidTo}`;
        if (!note.includes(legacyNote)) {
          note = note ? `${note} | ${legacyNote}` : legacyNote;
        }
      }
    }
  }

  if (receivedBy !== FALLBACK_RECEIVED_BY && !RECEIVED_BY_OPTIONS.includes(receivedBy)) {
    errors.push("receivedBy is invalid.");
  }

  const setUpdates = {
    amountMinor,
    receivedBy,
    user: invoice.user,
  };

  if (note) {
    setUpdates.note = note;
  }

  const unsetUpdates = {};
  LEGACY_FIELDS.forEach((field) => {
    if (payment[field] != null) {
      unsetUpdates[field] = "";
    }
  });

  const update = { $set: setUpdates };
  const hasUnset = Object.keys(unsetUpdates).length > 0;
  if (hasUnset) {
    update.$unset = unsetUpdates;
  }

  let hasChanges = hasUnset;
  if (!hasChanges) {
    hasChanges = Object.entries(setUpdates).some(([key, value]) => {
      return !areValuesEqual(payment[key], value);
    });
  }

  return { update, hasChanges, errors };
};

const flushBatch = async (operations, counts, failures) => {
  if (operations.length === 0) return;

  const pending = operations.length;

  try {
    const result = await mongoose.connection
      .collection("payments")
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

const recomputeInvoiceCaches = async () => {
  const invoicesCollection = mongoose.connection.collection("invoices");
  const paymentsCollection = mongoose.connection.collection("payments");

  console.log("Recomputing invoice payment caches...");

  const totals = await paymentsCollection
    .aggregate([
      {
        $group: {
          _id: "$invoice",
          paidTotalMinor: { $sum: "$amountMinor" },
        },
      },
    ])
    .toArray();

  const totalMap = new Map();
  totals.forEach((entry) => {
    if (entry._id) {
      totalMap.set(entry._id.toString(), Math.max(0, entry.paidTotalMinor || 0));
    }
  });

  const cursor = invoicesCollection.find({}, { batchSize: BATCH_SIZE });
  const operations = [];
  let updated = 0;

  for await (const invoice of cursor) {
    const paidTotalMinor = totalMap.get(invoice._id.toString()) || 0;
    const amountMinor = Math.max(0, Number(invoice.amountMinor) || 0);
    const balanceDueMinor = Math.max(0, amountMinor - paidTotalMinor);
    const paymentStatus = computePaymentStatus(amountMinor, paidTotalMinor);

    const setUpdates = {
      paidTotalMinor,
      balanceDueMinor,
      paymentStatus,
    };

    const hasChanges = Object.entries(setUpdates).some(([key, value]) => {
      return !areValuesEqual(invoice[key], value);
    });

    if (!hasChanges) {
      continue;
    }

    operations.push({
      updateOne: {
        filter: { _id: invoice._id },
        update: {
          $set: {
            ...setUpdates,
            updatedAt: new Date(),
          },
        },
      },
    });

    if (operations.length >= BATCH_SIZE) {
      const result = await invoicesCollection.bulkWrite(operations, {
        ordered: false,
      });
      updated += result.modifiedCount;
      operations.length = 0;
    }
  }

  if (operations.length > 0) {
    const result = await invoicesCollection.bulkWrite(operations, {
      ordered: false,
    });
    updated += result.modifiedCount;
    operations.length = 0;
  }

  console.log(`Invoice cache recompute updated: ${updated}`);
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
  const invoicesCollection = mongoose.connection.collection("invoices");
  const invoiceCache = new Map();

  const cursor = mongoose.connection
    .collection("payments")
    .find({}, { batchSize: BATCH_SIZE });

  for await (const payment of cursor) {
    counts.scanned += 1;

    const invoice = await getInvoiceData(
      payment.invoice,
      invoicesCollection,
      invoiceCache
    );

    const { update, hasChanges, errors } = buildUpdatesForPayment(
      payment,
      invoice
    );

    if (errors && errors.length > 0) {
      counts.failed += 1;
      failures.push({ _id: payment._id, errors });
      errors.forEach((error) => {
        console.error(`Payment ${payment._id}: ${error}`);
      });
      continue;
    }

    if (!hasChanges) {
      counts.skipped += 1;
      continue;
    }

    operations.push({
      _id: payment._id,
      operation: {
        updateOne: {
          filter: { _id: payment._id },
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

  await fs.writeFile(FAILURE_PATH, JSON.stringify(failures, null, 2));

  console.log("Payment migration complete.");
  console.log(`Scanned: ${counts.scanned}`);
  console.log(`Updated: ${counts.updated}`);
  console.log(`Skipped: ${counts.skipped}`);
  console.log(`Failed: ${counts.failed}`);

  await recomputeInvoiceCaches();

  await mongoose.disconnect();
};

runMigration().catch((error) => {
  console.error("Migration failed:", error.message || error);
  mongoose.disconnect();
  process.exitCode = 1;
});
