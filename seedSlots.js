import mongoose from "mongoose";
import dotenv from "dotenv";
import Slot from "./models/slotModel.js";

dotenv.config();

const MONGO_URI = ""

async function seedSlots() {
  if (!MONGO_URI || typeof MONGO_URI !== "string") {
    console.error("❌ No MONGO_URI found. Set it in .env (remember to URL-encode special chars).");
    process.exit(1);
  }

  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ MongoDB connected");

    const letters = "ABCDEFGHIJKLMN"; // A → N (14 shelves)
    const perShelf = 16;              // slots per shelf
    const storeName = "Mwj-1-Alain";

    const bulkOps = [];
    for (const unit of letters) {
      for (let num = 1; num <= perShelf; num++) {
        const code = `${unit}${num}`;
        bulkOps.push({
          updateOne: {
            filter: { code },
            update: {
              $setOnInsert: {
                store: storeName,
                unit,
                code,
                isActive: true,
              },
            },
            upsert: true,
          },
        });
      }
    }

    if (bulkOps.length) {
      const result = await Slot.bulkWrite(bulkOps, { ordered: false });
      const upserts = result.upsertedCount ?? 0;
      console.log(`✅ Seeding complete: ${letters.length * perShelf} total codes; ${upserts} inserted, rest already existed.`);
    }

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("❌ Error seeding slots:", err?.message || err);
    process.exit(1);
  }
}

seedSlots();
