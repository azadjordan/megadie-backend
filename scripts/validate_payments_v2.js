import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile =
  process.env.NODE_ENV === "production"
    ? ".env.production"
    : ".env.development";
dotenv.config({ path: path.resolve(__dirname, "..", envFile) });

const BATCH_SIZE = 200;
const RECEIVED_BY_OPTIONS = [
  "Azad",
  "Momani",
  "Company Account",
  "Ahmad Emad",
  "Unknown",
];
const LEGACY_FIELDS = ["amount", "paidTo", "status"];

const ensureMongoUri = () => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is not set in the environment.");
  }
};

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const isValidInteger = (value) =>
  Number.isInteger(value) && Number.isFinite(value);

const getInvoiceData = async (invoiceId, invoicesCollection, cache) => {
  if (!invoiceId) return null;

  const key = invoiceId.toString();
  if (cache.has(key)) return cache.get(key);

  const invoice = await invoicesCollection.findOne(
    { _id: new mongoose.Types.ObjectId(key) },
    { projection: { user: 1, status: 1 } }
  );

  cache.set(key, invoice || null);
  return invoice || null;
};

const validatePayment = (payment, invoice) => {
  const errors = [];

  if (!isValidObjectId(payment.invoice)) {
    errors.push("invoice is required.");
  }

  if (!isValidObjectId(payment.user)) {
    errors.push("user is required.");
  }

  if (!isValidInteger(payment.amountMinor) || payment.amountMinor < 1) {
    errors.push("amountMinor must be an integer >= 1.");
  }

  if (!RECEIVED_BY_OPTIONS.includes(payment.receivedBy)) {
    errors.push(
      `receivedBy must be one of ${RECEIVED_BY_OPTIONS.join(", ")}.`
    );
  }

  if (!invoice) {
    errors.push("invoice not found.");
  } else {
    if (invoice.status === "Cancelled") {
      errors.push("Invoice is Cancelled");
    }
    if (invoice.status !== "Issued") {
      errors.push("invoice status must be Issued.");
    }
    if (invoice.user && payment.user) {
      if (invoice.user.toString() !== payment.user.toString()) {
        errors.push("payment user must match invoice user.");
      }
    }
  }

  LEGACY_FIELDS.forEach((field) => {
    if (payment[field] != null) {
      errors.push(`${field} must be removed from payments.`);
    }
  });

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

    const errors = validatePayment(payment, invoice);
    if (errors.length > 0) {
      counts.failed += 1;
      errors.forEach((error) => {
        console.error(`Payment ${payment._id}: ${error}`);
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
