import dotenv from "dotenv";
import mongoose from "mongoose";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env.development") });

const BATCH_SIZE = 200;
const FAILURE_PATH = path.resolve(
  "scripts",
  "_validation_failures_orders_v2.json"
);
const STATUS_VALUES = ["Processing", "Shipping", "Delivered", "Cancelled"];
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

const isValidNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

const isValidDateValue = (value) => {
  if (value == null) return true;
  const date = value instanceof Date ? value : new Date(value);
  return !Number.isNaN(date.getTime());
};

const validateOrderItem = (item, index) => {
  const errors = [];

  if (!item || !isValidObjectId(item.product)) {
    errors.push(`orderItems[${index}].product is required.`);
  }

  if (typeof item.sku !== "string" || item.sku.trim() === "") {
    errors.push(`orderItems[${index}].sku is required.`);
  }

  if (!isValidNumber(item.qty) || item.qty < 1) {
    errors.push(`orderItems[${index}].qty must be a number >= 1.`);
  }

  if (!isValidNumber(item.unitPrice) || item.unitPrice < 0) {
    errors.push(`orderItems[${index}].unitPrice must be a number >= 0.`);
  }

  if (!isValidNumber(item.lineTotal) || item.lineTotal < 0) {
    errors.push(`orderItems[${index}].lineTotal must be a number >= 0.`);
  }

  if (item.productName != null && typeof item.productName !== "string") {
    errors.push(`orderItems[${index}].productName must be a string if set.`);
  }

  return errors;
};

const validateOrder = (order) => {
  const errors = [];

  if (!isValidObjectId(order.user)) {
    errors.push("user is required.");
  }

  if (typeof order.orderNumber !== "string" || order.orderNumber.trim() === "") {
    errors.push("orderNumber is required.");
  }

  if (!Array.isArray(order.orderItems) || order.orderItems.length === 0) {
    errors.push("orderItems must be a non-empty array.");
  } else {
    order.orderItems.forEach((item, index) => {
      errors.push(...validateOrderItem(item, index));
    });
  }

  if (!isValidNumber(order.totalPrice) || order.totalPrice < 0) {
    errors.push("totalPrice must be a number >= 0.");
  }

  if (!isValidNumber(order.deliveryCharge) || order.deliveryCharge < 0) {
    errors.push("deliveryCharge must be a number >= 0.");
  }

  if (!isValidNumber(order.extraFee) || order.extraFee < 0) {
    errors.push("extraFee must be a number >= 0.");
  }

  if (!STATUS_VALUES.includes(order.status)) {
    errors.push(`status must be one of ${STATUS_VALUES.join(", ")}.`);
  }

  if (!ALLOCATION_VALUES.includes(order.allocationStatus)) {
    errors.push(
      `allocationStatus must be one of ${ALLOCATION_VALUES.join(", ")}.`
    );
  }

  if (!isValidDateValue(order.deliveredAt)) {
    errors.push("deliveredAt must be a valid date or null.");
  }

  if (order.status === "Delivered" && !order.deliveredAt) {
    errors.push("deliveredAt is required when status is Delivered.");
  }

  if (!isValidDateValue(order.allocatedAt)) {
    errors.push("allocatedAt must be a valid date or null.");
  }

  if (!isValidDateValue(order.stockFinalizedAt)) {
    errors.push("stockFinalizedAt must be a valid date or null.");
  }

  if (order.quote != null && !isValidObjectId(order.quote)) {
    errors.push("quote must be a valid ObjectId if set.");
  }

  if (order.invoice != null && !isValidObjectId(order.invoice)) {
    errors.push("invoice must be a valid ObjectId if set.");
  }

  if (
    order.isDelivered != null ||
    order.stockUpdated != null ||
    order.invoiceGenerated != null
  ) {
    errors.push(
      "legacy fields (isDelivered/stockUpdated/invoiceGenerated) must be removed."
    );
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
  const cursor = mongoose.connection
    .collection("orders")
    .find({}, { batchSize: BATCH_SIZE });

  for await (const order of cursor) {
    counts.scanned += 1;
    const errors = validateOrder(order);

    if (errors.length > 0) {
      counts.failed += 1;
      failures.push({ _id: order._id, errors });
      errors.forEach((error) => {
        console.error(`Order ${order._id}: ${error}`);
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
