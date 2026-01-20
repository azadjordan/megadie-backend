import dotenv from "dotenv";
import mongoose from "mongoose";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "path";
import { fileURLToPath } from "url";
import User from "../models/userModel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env.development") });

const BATCH_SIZE = 200;
const DEFAULT_PHONE_NUMBER = "Unknown";
const DEFAULT_APPROVAL_STATUS = "Pending";

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

const buildUpdatesForUser = (user) => {
  const updates = {};

  if (user.approvalStatus == null || user.approvalStatus === "") {
    updates.approvalStatus = DEFAULT_APPROVAL_STATUS;
  }

  if (user.phoneNumber == null || user.phoneNumber === "") {
    updates.phoneNumber = DEFAULT_PHONE_NUMBER;
  }

  return updates;
};

const flushBatch = async (operations, counts) => {
  if (operations.length === 0) return;

  const pending = operations.length;

  try {
    const result = await User.bulkWrite(operations, { ordered: false });
    counts.updated += result.modifiedCount;

    const failures = pending - result.modifiedCount;
    if (failures > 0) {
      counts.failed += failures;
    }
  } catch (error) {
    console.error("Batch update failed:", error.message || error);
    counts.failed += pending;
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

  const operations = [];
  const cursor = User.find().cursor({ batchSize: BATCH_SIZE });

  for await (const user of cursor) {
    counts.scanned += 1;

    const updates = buildUpdatesForUser(user);
    if (Object.keys(updates).length === 0) {
      counts.skipped += 1;
      continue;
    }

    operations.push({
      updateOne: {
        filter: { _id: user._id },
        update: { $set: updates },
      },
    });

    if (operations.length >= BATCH_SIZE) {
      await flushBatch(operations, counts);
    }
  }

  await flushBatch(operations, counts);

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
