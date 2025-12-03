// seedSlotsDevelopment.js
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import Slot from "./models/slotModel.js";
import {
  SLOT_STORES,
  SLOT_UNITS,
  SLOT_POSITIONS,
} from "./constants.js";

// -------------------- ENV & PATH SETUP --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env if needed
dotenv.config({ path: path.resolve(__dirname, "./.env.development") });

// -------------------- CONSTANTS --------------------

// We'll seed slots only for the first store in the enum for now
const STORE_ID = SLOT_STORES[0]; // "ALAIN-MWJ"

// Default CBM per slot (you can change this later if needed)
const DEFAULT_CBM = 0;

// -------------------- SEED LOGIC --------------------

const seedSlots = async () => {
  try {
    await mongoose.connect(
      "mongodb+srv://azadkkurdi:Kurdi1995%24@cluster0.rmtrm.mongodb.net/megadie-development?retryWrites=true&w=majority&appName=Cluster0"
    );
    console.log("✅ Connected to DB");

    // Clear existing slots for this store
    const deleted = await Slot.deleteMany({ store: STORE_ID });
    console.log(`🧹 Cleared ${deleted.deletedCount} existing slots for store '${STORE_ID}'`);

    const totalExpected = SLOT_UNITS.length * SLOT_POSITIONS.length;
    console.log(`ℹ️ Preparing to insert ${totalExpected} slots for store '${STORE_ID}'...`);

    let createdCount = 0;

    for (const unit of SLOT_UNITS) {
      for (const position of SLOT_POSITIONS) {
        const slot = new Slot({
          store: STORE_ID,
          unit,
          position,
          cbm: DEFAULT_CBM,
          isActive: true,
          // label will be auto-generated as `${unit}${position}` by pre("validate")
        });

        await slot.save();
        createdCount += 1;
      }
    }

    console.log(`🎉 Inserted ${createdCount} slots for store '${STORE_ID}'.`);
    process.exit(0);
  } catch (error) {
    console.error("❌ Failed to seed slots:", error);
    process.exit(1);
  }
};

seedSlots();
