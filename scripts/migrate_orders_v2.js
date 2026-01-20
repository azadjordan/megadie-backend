import dotenv from "dotenv";
import mongoose from "mongoose";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile =
  process.env.NODE_ENV === "production"
    ? ".env.production"
    : ".env.development";
dotenv.config({ path: path.resolve(__dirname, "..", envFile) });

const BATCH_SIZE = 200;
const FAILURE_PATH = path.resolve(
  "scripts",
  "_migration_failures_orders_v2.json"
);
const STATUS_VALUES = ["Processing", "Shipping", "Delivered", "Cancelled"];
const STATUS_MAP = {
  Returned: "Cancelled",
};
const ALLOCATION_VALUES = [
  "Unallocated",
  "PartiallyAllocated",
  "Allocated",
];

const ensureMongoUri = () => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is not set in the environment.");
  }
};

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

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

const normalizeNumber = (value, fallback = 0, min = 0) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, num);
};

const normalizeDateValue = (value) => {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const normalizeStatus = (status) => {
  if (STATUS_VALUES.includes(status)) return status;
  if (STATUS_MAP[status]) return STATUS_MAP[status];
  return "Processing";
};

const normalizeAllocationStatus = (status) => {
  if (ALLOCATION_VALUES.includes(status)) return status;
  return "Unallocated";
};

const resolveProductId = (item) => {
  const candidates = [
    item?.product,
    item?.productId,
    item?.product?._id,
    item?.product?.id,
  ];

  for (const candidate of candidates) {
    if (candidate == null) continue;

    if (isValidObjectId(candidate)) return candidate;

    if (typeof candidate === "object") {
      const nested = candidate._id ?? candidate.id;
      if (nested != null && isValidObjectId(nested)) return nested;
    }
  }

  return null;
};

const fetchSkuForProduct = async (productId, productsCollection, cache) => {
  if (!productId) return null;

  const key = productId.toString();
  if (cache.has(key)) return cache.get(key);

  const product = await productsCollection.findOne(
    { _id: new mongoose.Types.ObjectId(key) },
    { projection: { sku: 1 } }
  );

  const sku =
    product && typeof product.sku === "string" && product.sku.trim() !== ""
      ? product.sku.trim()
      : null;
  cache.set(key, sku);

  return sku;
};

const normalizeOrderItems = async (items, productsCollection, skuCache) => {
  const normalizedItems = [];
  const itemFailures = [];

  for (const [index, item] of items.entries()) {
    const productId = resolveProductId(item);
    if (!productId) {
      itemFailures.push(`orderItems[${index}].product is required.`);
      continue;
    }

    const qty = normalizeNumber(item.qty, 1, 1);
    const unitPrice = normalizeNumber(item.unitPrice, 0, 0);
    const lineTotal = Math.max(0, qty * unitPrice);

    let sku =
      typeof item.sku === "string" && item.sku.trim() !== ""
        ? item.sku.trim()
        : null;

    if (!sku) {
      const resolvedSku = await fetchSkuForProduct(
        productId,
        productsCollection,
        skuCache
      );
      sku = resolvedSku ?? "UNKNOWN";
    }

    normalizedItems.push({
      product: productId,
      sku,
      productName:
        typeof item.productName === "string" ? item.productName : null,
      qty,
      unitPrice,
      lineTotal,
    });
  }

  return { normalizedItems, itemFailures };
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

  const currentDate = current instanceof Date ? current : null;
  const nextDate = next instanceof Date ? next : null;

  if (currentDate || nextDate) {
    if (!currentDate || !nextDate) return false;
    return currentDate.getTime() === nextDate.getTime();
  }

  return (
    JSON.stringify(normalizeForCompare(current)) ===
    JSON.stringify(normalizeForCompare(next))
  );
};

const buildUpdatesForOrder = async (
  order,
  productsCollection,
  skuCache,
  invoiceConflictMap,
  invoiceConflictLog
) => {
  const errors = [];

  if (!Array.isArray(order.orderItems) || order.orderItems.length === 0) {
    errors.push("orderItems must be a non-empty array.");
    return { errors };
  }

  const { normalizedItems, itemFailures } = await normalizeOrderItems(
    order.orderItems,
    productsCollection,
    skuCache
  );

  if (normalizedItems.length === 0) {
    errors.push("orderItems must be a non-empty array after normalization.");
    return { errors, itemFailures };
  }

  const status = normalizeStatus(order.status);
  const allocationStatus = normalizeAllocationStatus(order.allocationStatus);

  const totalPrice = normalizeNumber(order.totalPrice, 0, 0);
  const deliveryCharge = normalizeNumber(order.deliveryCharge, 0, 0);
  const extraFee = normalizeNumber(order.extraFee, 0, 0);

  const deliveredAt =
    status === "Delivered"
      ? normalizeDateValue(order.deliveredAt) ?? new Date()
      : normalizeDateValue(order.deliveredAt);

  const allocatedAt = normalizeDateValue(order.allocatedAt);
  const stockFinalizedAt = normalizeDateValue(order.stockFinalizedAt);

  let invoice = order.invoice ?? null;
  if (invoice != null && invoiceConflictMap.has(invoice.toString())) {
    const { keepId } = invoiceConflictMap.get(invoice.toString());
    if (keepId.toString() !== order._id.toString()) {
      invoiceConflictLog.push({
        invoiceId: invoice,
        orderId: order._id,
        keptOrderId: keepId,
      });
      invoice = null;
    }
  }

  const quote = order.quote ?? null;

  const setUpdates = {
    status,
    allocationStatus,
    orderItems: normalizedItems,
    totalPrice,
    deliveryCharge,
    extraFee,
    deliveredAt,
    allocatedAt: allocatedAt ?? null,
    stockFinalizedAt: stockFinalizedAt ?? null,
    invoice,
    quote,
  };

  const unsetUpdates = {};
  if (order.isDelivered != null) {
    unsetUpdates.isDelivered = "";
  }
  if (order.stockUpdated != null) {
    unsetUpdates.stockUpdated = "";
  }
  if (order.invoiceGenerated != null) {
    unsetUpdates.invoiceGenerated = "";
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
        key === "deliveredAt" || key === "allocatedAt" || key === "stockFinalizedAt"
          ? normalizeDateValue(order[key])
          : order[key];
      return !areValuesEqual(currentValue, value);
    });
  }

  return { update, hasChanges, itemFailures };
};

const flushBatch = async (operations, counts, failures) => {
  if (operations.length === 0) return;

  const pending = operations.length;

  try {
    const result = await mongoose.connection
      .collection("orders")
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

const buildInvoiceConflictMap = async () => {
  const duplicates = await mongoose.connection
    .collection("orders")
    .aggregate([
      { $match: { invoice: { $exists: true, $ne: null } } },
      { $sort: { createdAt: 1, _id: 1 } },
      {
        $group: {
          _id: "$invoice",
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
  const invoiceConflicts = [];
  const operations = [];

  const invoiceConflictMap = await buildInvoiceConflictMap();
  if (invoiceConflictMap.size > 0) {
    console.log("Invoice conflicts detected:");
    invoiceConflictMap.forEach(({ keepId, dropIds }, invoiceId) => {
      console.log(
        `Invoice ${invoiceId}: keeping ${keepId.toString()} and clearing ${dropIds
          .map((id) => id.toString())
          .join(", ")}`
      );
    });
  }

  const productsCollection = mongoose.connection.collection("products");
  const skuCache = new Map();

  const cursor = mongoose.connection
    .collection("orders")
    .find({}, { batchSize: BATCH_SIZE });

  for await (const order of cursor) {
    counts.scanned += 1;

    const { update, errors, hasChanges, itemFailures } =
      await buildUpdatesForOrder(
        order,
        productsCollection,
        skuCache,
        invoiceConflictMap,
        invoiceConflicts
      );

    if (errors) {
      const combinedErrors = [...(itemFailures ?? []), ...errors];
      counts.failed += 1;
      failures.push({ _id: order._id, errors: combinedErrors });
      combinedErrors.forEach((error) => {
        console.error(`Order ${order._id}: ${error}`);
      });
      continue;
    }

    if (itemFailures?.length) {
      failures.push({ _id: order._id, errors: itemFailures });
      itemFailures.forEach((error) => {
        console.error(`Order ${order._id}: ${error}`);
      });
    }

    if (!hasChanges) {
      counts.skipped += 1;
      continue;
    }

    operations.push({
      _id: order._id,
      operation: {
        updateOne: {
          filter: { _id: order._id },
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

  if (invoiceConflicts.length > 0) {
    failures.push({
      _id: "invoice_conflicts",
      orders: invoiceConflicts,
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
