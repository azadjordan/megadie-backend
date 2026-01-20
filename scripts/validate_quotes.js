import dotenv from "dotenv";
import mongoose from "mongoose";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs/promises";
import path from "node:path";

dotenv.config();

const BATCH_SIZE = 200;
const FAILURE_PATH = path.resolve("scripts", "_migration_failures_quotes.json");
const STATUS_VALUES = ["Processing", "Quoted", "Confirmed", "Cancelled"];
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
    console.log("Validation aborted.");
    return false;
  }

  return true;
};

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const isValidNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

const isValidDateValue = (value) => {
  if (value == null) return true;
  const date = value instanceof Date ? value : new Date(value);
  return !Number.isNaN(date.getTime());
};

const validateRequestedItem = (item, index) => {
  const errors = [];

  if (!item || !isValidObjectId(item.product)) {
    errors.push(`requestedItems[${index}].product is required.`);
  }

  if (!isValidNumber(item.qty) || item.qty < 0) {
    errors.push(`requestedItems[${index}].qty must be a number >= 0.`);
  }

  if (!isValidNumber(item.unitPrice) || item.unitPrice < 0) {
    errors.push(`requestedItems[${index}].unitPrice must be a number >= 0.`);
  }

  if (!isValidNumber(item.availableNow) || item.availableNow < 0) {
    errors.push(`requestedItems[${index}].availableNow must be a number >= 0.`);
  }

  if (!isValidNumber(item.shortage) || item.shortage < 0) {
    errors.push(`requestedItems[${index}].shortage must be a number >= 0.`);
  }

  if (!AVAILABILITY_VALUES.includes(item.availabilityStatus)) {
    errors.push(
      `requestedItems[${index}].availabilityStatus must be one of ${AVAILABILITY_VALUES.join(
        ", "
      )}.`
    );
  }

  return errors;
};

const validateQuote = (quote) => {
  const errors = [];

  if (!isValidObjectId(quote.user)) {
    errors.push("user is required.");
  }

  if (typeof quote.quoteNumber !== "string" || quote.quoteNumber.trim() === "") {
    errors.push("quoteNumber is required.");
  }

  if (!Array.isArray(quote.requestedItems) || quote.requestedItems.length === 0) {
    errors.push("requestedItems must be a non-empty array.");
  } else {
    quote.requestedItems.forEach((item, index) => {
      errors.push(...validateRequestedItem(item, index));
    });
  }

  if (!isValidNumber(quote.deliveryCharge) || quote.deliveryCharge < 0) {
    errors.push("deliveryCharge must be a number >= 0.");
  }

  if (!isValidNumber(quote.extraFee) || quote.extraFee < 0) {
    errors.push("extraFee must be a number >= 0.");
  }

  if (!isValidNumber(quote.totalPrice) || quote.totalPrice < 0) {
    errors.push("totalPrice must be a number >= 0.");
  }

  if (!STATUS_VALUES.includes(quote.status)) {
    errors.push(`status must be one of ${STATUS_VALUES.join(", ")}.`);
  }

  if (!isValidDateValue(quote.availabilityCheckedAt)) {
    errors.push("availabilityCheckedAt must be a valid date or null.");
  }

  if (
    quote.clientQtyEditLocked != null &&
    typeof quote.clientQtyEditLocked !== "boolean"
  ) {
    errors.push("clientQtyEditLocked must be a boolean if set.");
  }

  if (quote.order != null && !isValidObjectId(quote.order)) {
    errors.push("order must be a valid ObjectId if set.");
  }

  if (quote.isOrderCreated != null || quote.createdOrderId != null) {
    errors.push("legacy order fields (isOrderCreated/createdOrderId) must be removed.");
  }

  return errors;
};

const runValidation = async () => {
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
  const cursor = mongoose.connection
    .collection("quotes")
    .find({}, { batchSize: BATCH_SIZE });

  for await (const quote of cursor) {
    counts.scanned += 1;
    const errors = validateQuote(quote);

    if (errors.length > 0) {
      counts.failed += 1;
      failures.push({ _id: quote._id, errors });
      errors.forEach((error) => {
        console.error(`Quote ${quote._id}: ${error}`);
      });
    } else {
      counts.skipped += 1;
    }
  }

  await fs.writeFile(FAILURE_PATH, JSON.stringify(failures, null, 2));

  console.log("Validation complete.");
  console.log(`Scanned: ${counts.scanned}`);
  console.log(`Updated: ${counts.updated}`);
  console.log(`Skipped: ${counts.skipped}`);
  console.log(`Failed: ${counts.failed}`);

  await mongoose.disconnect();
};

runValidation().catch((error) => {
  console.error("Validation failed:", error.message || error);
  mongoose.disconnect();
  process.exitCode = 1;
});
