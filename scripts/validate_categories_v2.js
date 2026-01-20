import dotenv from "dotenv";
import mongoose from "mongoose";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "url";
import { PRODUCT_TYPES } from "../constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile =
  process.env.NODE_ENV === "production"
    ? ".env.production"
    : ".env.development";
dotenv.config({ path: path.resolve(__dirname, "..", envFile) });

const BATCH_SIZE = 200;
const FAILURE_PATH = path.resolve(
  "scripts",
  "_validation_failures_categories_v2.json"
);

const ensureMongoUri = () => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is not set in the environment.");
  }
};

const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim() !== "";

const isValidNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

const isValidBoolean = (value) => typeof value === "boolean";

const validateCategory = (category, seenKeys) => {
  const errors = [];

  if (!isNonEmptyString(category.key)) {
    errors.push("key is required.");
  }

  if (!isNonEmptyString(category.label)) {
    errors.push("label is required.");
  }

  if (!isNonEmptyString(category.productType)) {
    errors.push("productType is required.");
  } else if (!PRODUCT_TYPES.includes(category.productType)) {
    errors.push(
      `productType must be one of ${PRODUCT_TYPES.join(", ")} (received ${category.productType}).`
    );
  }

  if (category.imageUrl != null && !isNonEmptyString(category.imageUrl)) {
    errors.push("imageUrl must be a non-empty string if set.");
  }

  if (category.sort != null && !isValidNumber(category.sort)) {
    errors.push("sort must be a number if set.");
  }

  if (category.isActive != null && !isValidBoolean(category.isActive)) {
    errors.push("isActive must be a boolean if set.");
  }

  if (category.filters != null || category.description != null) {
    errors.push("legacy fields (filters/description) must be removed.");
  }

  if (isNonEmptyString(category.productType) && isNonEmptyString(category.key)) {
    const productKey = `${category.productType}::${category.key}`;
    const existing = seenKeys.get(productKey);
    if (existing && existing !== category._id.toString()) {
      errors.push(
        `duplicate key for productType+key (also used by ${existing}).`
      );
    } else {
      seenKeys.set(productKey, category._id.toString());
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

  const failures = [];
  const seenKeys = new Map();

  const cursor = mongoose.connection
    .collection("categories")
    .find({}, { batchSize: BATCH_SIZE });

  for await (const category of cursor) {
    counts.scanned += 1;
    const errors = validateCategory(category, seenKeys);

    if (errors.length > 0) {
      counts.failed += 1;
      failures.push({ _id: category._id, errors });
      errors.forEach((error) => {
        console.error(`Category ${category._id}: ${error}`);
      });
    } else {
      counts.passed += 1;
    }
  }

  await fs.writeFile(FAILURE_PATH, JSON.stringify(failures, null, 2));

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
