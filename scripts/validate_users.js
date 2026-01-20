import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import User from "../models/userModel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env.development") });

const BATCH_SIZE = 200;

const ensureMongoUri = () => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is not set in the environment.");
  }
};

const formatValidationErrors = (error) => {
  if (!error || error.name !== "ValidationError") {
    return [error?.message || String(error)];
  }

  return Object.values(error.errors).map(
    (err) => `${err.path}: ${err.message}`
  );
};

const runValidation = async () => {
  ensureMongoUri();
  await mongoose.connect(process.env.MONGO_URI);

  console.log(`Connected to database: ${mongoose.connection.name}`);

  let scanned = 0;
  let failed = 0;

  const cursor = User.find().cursor({ batchSize: BATCH_SIZE });

  for await (const user of cursor) {
    scanned += 1;
    try {
      await user.validate();
    } catch (error) {
      failed += 1;
      const reasons = formatValidationErrors(error);
      reasons.forEach((reason) => {
        console.error(`User ${user._id}: ${reason}`);
      });
    }
  }

  console.log("Validation complete.");
  console.log(`Scanned: ${scanned}`);
  console.log(`Failed: ${failed}`);

  await mongoose.disconnect();
};

runValidation().catch((error) => {
  console.error("Validation failed:", error.message || error);
  mongoose.disconnect();
  process.exitCode = 1;
});
