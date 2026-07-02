import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";

import Invoice from "../models/invoiceModel.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(backendRoot, ".env.development") });
dotenv.config({ path: path.join(backendRoot, ".env") });
dotenv.config({ path: path.join(backendRoot, ".env.production") });

const missingInvoiceDateFilter = {
  $or: [{ invoiceDate: { $exists: false } }, { invoiceDate: null }],
};

const run = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is missing. Add it to the backend env file.");
  }

  await mongoose.connect(process.env.MONGO_URI);

  const before = await Invoice.countDocuments(missingInvoiceDateFilter);
  const result = await Invoice.updateMany(missingInvoiceDateFilter, [
    { $set: { invoiceDate: "$createdAt" } },
  ]);
  const after = await Invoice.countDocuments(missingInvoiceDateFilter);

  console.log(
    `Backfilled invoiceDate for ${result.modifiedCount || 0} invoice(s). ` +
      `Missing before: ${before}. Missing after: ${after}.`
  );
};

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
