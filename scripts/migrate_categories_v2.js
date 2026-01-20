import dotenv from "dotenv";
import mongoose from "mongoose";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "url";
import { PRODUCT_TYPES } from "../constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env.development") });

const BATCH_SIZE = 200;
const FAILURE_PATH = path.resolve(
  "scripts",
  "_migration_failures_categories_v2.json"
);

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

const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim() !== "";

const isValidNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

const sanitizeKey = (name) =>
  name
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");

const ensureKeyMapEntry = (keyMap, productType, key) => {
  if (!keyMap.has(productType)) {
    keyMap.set(productType, new Map());
  }
  const productKeys = keyMap.get(productType);
  if (!productKeys.has(key)) {
    productKeys.set(key, new Set());
  }
  return productKeys.get(key);
};

const addKeyUsage = (keyMap, productType, key, id) => {
  const ids = ensureKeyMapEntry(keyMap, productType, key);
  ids.add(id);
};

const removeKeyUsage = (keyMap, productType, key, id) => {
  const productKeys = keyMap.get(productType);
  if (!productKeys) return;
  const ids = productKeys.get(key);
  if (!ids) return;
  ids.delete(id);
  if (ids.size === 0) {
    productKeys.delete(key);
  }
  if (productKeys.size === 0) {
    keyMap.delete(productType);
  }
};

const resolveUniqueKey = (keyMap, productType, baseKey, id, adjustmentLog) => {
  let candidate = baseKey;
  let suffix = 1;

  const isConflict = () => {
    const productKeys = keyMap.get(productType);
    if (!productKeys) return false;
    const ids = productKeys.get(candidate);
    if (!ids || ids.size === 0) return false;
    return !(ids.size === 1 && ids.has(id));
  };

  while (isConflict()) {
    candidate = `${baseKey}-${suffix}`;
    suffix += 1;
  }

  if (candidate !== baseKey) {
    adjustmentLog.push({
      _id: id,
      productType,
      originalKey: baseKey,
      adjustedKey: candidate,
    });
  }

  return candidate;
};

const buildKeyMap = async (collection) => {
  const keyMap = new Map();
  const cursor = collection.find(
    { key: { $type: "string" } },
    { projection: { productType: 1, key: 1 }, batchSize: BATCH_SIZE }
  );

  for await (const category of cursor) {
    if (!isNonEmptyString(category.productType) || !isNonEmptyString(category.key)) {
      continue;
    }
    addKeyUsage(
      keyMap,
      category.productType,
      category.key.trim(),
      category._id.toString()
    );
  }

  return keyMap;
};

const buildUpdatesForCategory = (category, keyMap, adjustmentLog) => {
  const errors = [];
  const update = { $set: {}, $unset: {} };

  const id = category._id.toString();
  const name = isNonEmptyString(category.name) ? category.name.trim() : "";
  const displayName = isNonEmptyString(category.displayName)
    ? category.displayName.trim()
    : "";
  const currentKey = isNonEmptyString(category.key) ? category.key.trim() : "";

  const baseKey = name ? sanitizeKey(name) : currentKey;
  if (!baseKey) {
    errors.push("name is required to generate key.");
  }

  const label = displayName || name || (isNonEmptyString(category.label) ? category.label.trim() : "");
  if (!label) {
    errors.push("label is required (displayName or name missing).");
  }

  if (!isNonEmptyString(category.productType)) {
    errors.push("productType is required.");
  } else if (!PRODUCT_TYPES.includes(category.productType)) {
    errors.push(
      `productType must be one of ${PRODUCT_TYPES.join(", ")} (received ${category.productType}).`
    );
  }

  if (errors.length > 0) {
    return { update: null, hasChanges: false, errors };
  }

  const productType = category.productType;
  const uniqueKey = resolveUniqueKey(
    keyMap,
    productType,
    baseKey,
    id,
    adjustmentLog
  );

  if (currentKey && currentKey !== uniqueKey) {
    removeKeyUsage(keyMap, productType, currentKey, id);
  }
  if (!currentKey || currentKey !== uniqueKey) {
    addKeyUsage(keyMap, productType, uniqueKey, id);
  }

  if (category.key !== uniqueKey) {
    update.$set.key = uniqueKey;
  }

  if (category.label !== label) {
    update.$set.label = label;
  }

  if (category.productType !== productType) {
    update.$set.productType = productType;
  }

  const imageUrl = isNonEmptyString(category.imageUrl)
    ? category.imageUrl.trim()
    : isNonEmptyString(category.image)
      ? category.image.trim()
      : undefined;
  if (imageUrl !== undefined && category.imageUrl !== imageUrl) {
    update.$set.imageUrl = imageUrl;
  }

  const sortValue = isValidNumber(category.sort)
    ? category.sort
    : isValidNumber(category.position)
      ? category.position
      : undefined;
  if (sortValue !== undefined && category.sort !== sortValue) {
    update.$set.sort = sortValue;
  }

  if (category.filters != null) {
    update.$unset.filters = "";
  }

  if (category.description != null) {
    update.$unset.description = "";
  }

  if (Object.keys(update.$set).length === 0) {
    delete update.$set;
  }

  if (Object.keys(update.$unset).length === 0) {
    delete update.$unset;
  }

  const hasChanges = Object.keys(update).length > 0;
  return { update, hasChanges, errors: [] };
};

const flushBatch = async (operations, counts, failures) => {
  if (operations.length === 0) return;

  const pending = operations.length;

  try {
    const result = await mongoose.connection
      .collection("categories")
      .bulkWrite(operations.map((item) => item.operation), { ordered: false });

    counts.updated += result.modifiedCount;

    const failuresCount = pending - result.modifiedCount;
    if (failuresCount > 0) {
      counts.failed += failuresCount;
      operations.forEach((item) => {
        failures.push({
          _id: item._id,
          errors: ["Bulk update failed."],
        });
      });
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
  const adjustmentLog = [];

  const categoriesCollection = mongoose.connection.collection("categories");
  const keyMap = await buildKeyMap(categoriesCollection);

  const cursor = categoriesCollection.find({}, { batchSize: BATCH_SIZE });

  for await (const category of cursor) {
    counts.scanned += 1;

    const { update, hasChanges, errors } = buildUpdatesForCategory(
      category,
      keyMap,
      adjustmentLog
    );

    if (errors && errors.length > 0) {
      counts.failed += 1;
      failures.push({ _id: category._id, errors });
      errors.forEach((error) => {
        console.error(`Category ${category._id}: ${error}`);
      });
      continue;
    }

    if (!hasChanges) {
      counts.skipped += 1;
      continue;
    }

    const setUpdates = { ...(update.$set ?? {}), updatedAt: new Date() };
    operations.push({
      _id: category._id,
      operation: {
        updateOne: {
          filter: { _id: category._id },
          update: {
            ...update,
            $set: setUpdates,
          },
        },
      },
    });

    if (operations.length >= BATCH_SIZE) {
      await flushBatch(operations, counts, failures);
    }
  }

  await flushBatch(operations, counts, failures);

  if (adjustmentLog.length > 0) {
    adjustmentLog.forEach((entry) => {
      console.warn(
        `Category ${entry._id}: key conflict for ${entry.productType}, adjusted ${entry.originalKey} -> ${entry.adjustedKey}.`
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
