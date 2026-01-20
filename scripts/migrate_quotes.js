import dotenv from "dotenv";
import mongoose from "mongoose";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs/promises";
import path from "node:path";

dotenv.config();

const BATCH_SIZE = 200;
const FAILURE_PATH = path.resolve("scripts", "_migration_failures_quotes.json");
const AVAILABILITY_VALUES = [
  "AVAILABLE",
  "PARTIAL",
  "SHORTAGE",
  "NOT_AVAILABLE",
];

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

const buildQuoteNumber = (quote) => {
  if (typeof quote.quoteNumber === "string" && quote.quoteNumber.trim() !== "") {
    return quote.quoteNumber;
  }

  const createdAt = quote.createdAt ? new Date(quote.createdAt) : new Date();
  const yy = String(createdAt.getFullYear()).slice(-2);
  const mm = String(createdAt.getMonth() + 1).padStart(2, "0");
  const dd = String(createdAt.getDate()).padStart(2, "0");
  const idSource = quote._id?.toString?.() ?? String(quote._id || "");
  const suffix = idSource.slice(-6).toUpperCase().padStart(6, "0");

  return `QTE-${yy}${mm}${dd}-${suffix}`;
};

const normalizeStatus = (status) => {
  const map = {
    Requested: "Processing",
    Rejected: "Cancelled",
    Processing: "Processing",
    Quoted: "Quoted",
    Confirmed: "Confirmed",
    Cancelled: "Cancelled",
  };

  return map[status] || "Processing";
};

const normalizeAvailabilityStatus = (status) =>
  AVAILABILITY_VALUES.includes(status) ? status : "NOT_AVAILABLE";

const normalizeRequestedItems = (items) =>
  items.map((item) => ({
    product: item.product,
    productName: item.productName,
    qty: normalizeNumber(item.qty, 0),
    unitPrice: normalizeNumber(item.unitPrice, 0),
    priceRule: item.priceRule ?? null,
    availableNow: normalizeNumber(item.availableNow, 0),
    shortage: normalizeNumber(item.shortage, 0),
    availabilityStatus: normalizeAvailabilityStatus(item.availabilityStatus),
  }));

const calculateTotalPrice = (items, deliveryCharge, extraFee) => {
  const itemsTotal = items.reduce(
    (sum, item) => sum + item.qty * item.unitPrice,
    0
  );
  return normalizeNumber(itemsTotal + deliveryCharge + extraFee, 0);
};

const normalizeDateValue = (value) => {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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

const buildUpdatesForQuote = (quote) => {
  const errors = [];

  if (!Array.isArray(quote.requestedItems) || quote.requestedItems.length === 0) {
    errors.push("requestedItems must be a non-empty array.");
  }

  if (quote.requestedItems?.some((item) => !item?.product)) {
    errors.push("requestedItems entries must include product.");
  }

  if (errors.length > 0) {
    return { errors };
  }

  const normalizedItems = normalizeRequestedItems(quote.requestedItems);
  const deliveryCharge = normalizeNumber(quote.deliveryCharge, 0);
  const extraFee = normalizeNumber(quote.extraFee, 0);
  const totalPrice = calculateTotalPrice(
    normalizedItems,
    deliveryCharge,
    extraFee
  );
  const status = normalizeStatus(quote.status);

  const setUpdates = {
    quoteNumber: buildQuoteNumber(quote),
    requestedItems: normalizedItems,
    deliveryCharge,
    extraFee,
    totalPrice,
    status,
    availabilityCheckedAt: normalizeDateValue(quote.availabilityCheckedAt),
    clientQtyEditLocked: Boolean(quote.clientQtyEditLocked),
  };

  if (quote.order == null && quote.createdOrderId != null) {
    setUpdates.order = quote.createdOrderId;
  }

  const unsetUpdates = {};
  if (quote.isOrderCreated != null) {
    unsetUpdates.isOrderCreated = "";
  }
  if (quote.createdOrderId != null) {
    unsetUpdates.createdOrderId = "";
  }

  const update = {};
  const hasUnset = Object.keys(unsetUpdates).length > 0;

  update.$set = setUpdates;
  if (hasUnset) {
    update.$unset = unsetUpdates;
  }

  let hasChanges = hasUnset;
  if (!hasChanges) {
    hasChanges = Object.entries(setUpdates).some(([key, value]) => {
      const currentValue =
        key === "availabilityCheckedAt"
          ? normalizeDateValue(quote.availabilityCheckedAt)
          : quote[key];

      return !areValuesEqual(currentValue, value);
    });
  }

  return { update, hasChanges };
};

const flushBatch = async (operations, counts, failures) => {
  if (operations.length === 0) return;

  const pending = operations.length;

  try {
    const result = await mongoose.connection
      .collection("quotes")
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
  const cursor = mongoose.connection
    .collection("quotes")
    .find({}, { batchSize: BATCH_SIZE });

  for await (const quote of cursor) {
    counts.scanned += 1;

    const { update, errors, hasChanges } = buildUpdatesForQuote(quote);
    if (errors) {
      counts.failed += 1;
      failures.push({ _id: quote._id, errors });
      errors.forEach((error) => {
        console.error(`Quote ${quote._id}: ${error}`);
      });
      continue;
    }

    if (!hasChanges) {
      counts.skipped += 1;
      continue;
    }

    operations.push({
      _id: quote._id,
      operation: {
        updateOne: {
          filter: { _id: quote._id },
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
