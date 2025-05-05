// seed.js
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Category from "./models/categoryModel.js";

import mongoose from "mongoose";
import connectDB from "./config/db.js";
import Product from "./models/productModel.js";

// Load env variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "./.env.development") });

const categoryData = [
  {
    _id: "68185c40f741188e53b71509",
    displayName: "Grosgrain Ribbon",
    productType: "Ribbon",
    sizes: ["1-inch", "0.5-inch"],
    codes: ["028", "117", "030", "260", "009", "012", "370", "860"],
  },
  {
    _id: "68185ce8f741188e53b71526",
    displayName: "Satin Ribbon",
    productType: "Ribbon",
    sizes: ["1-inch", "0.5-inch"],
    codes: ["333", "222", "111", "028", "030", "009", "029", "444", "860"],
  },
  {
    _id: "68185da9edb5f397aaeb7019",
    displayName: "Acrylic (Red)",
    productType: "Double Face Tape",
    sizes: ["6mm", "9mm", "10mm", "12mm"],
    codes: [],
  },
  {
    _id: "68185e54edb5f397aaeb7037",
    displayName: "Paper (White)",
    productType: "Double Face Tape",
    sizes: ["6mm", "9mm", "10mm", "12mm"],
    codes: [],
  },
  {
    _id: "68185eaaedb5f397aaeb7067",
    displayName: "PVC",
    productType: "Creasing Matrix",
    sizes: ["0.4x1.5", "0.5x1.5", "0.5x1.6"],
    codes: [],
  },
];

const codeToColor = {
  "028": "Red",
  "117": "Blue",
  "030": "Green",
  "260": "Yellow",
  "009": "Black",
  "012": "White",
  "370": "Pink",
  "860": "Beige",
  "333": "Navy",
  "222": "Silver",
  "111": "Gold",
  "029": "Orange",
  "444": "Teal",
};

const random = (arr) => arr[Math.floor(Math.random() * arr.length)];
const getPrice = (type) => {
  if (type === "Ribbon") return +(Math.random() * 8 + 8).toFixed(2);
  if (type === "Double Face Tape") return +(Math.random() * 5 + 5).toFixed(2);
  return +(Math.random() * 8 + 12).toFixed(2);
};

const descriptions = [
  "High quality product for industrial use.",
  "Reliable and durable, suitable for professionals.",
  "Premium quality, competitively priced.",
  "Ideal for packaging and craft applications.",
  "Tested for strength and performance."
];

const seedDatabase = async () => {
  try {
    await connectDB();
    await Product.deleteMany();
    console.log("🧹 Cleared existing products");

    let totalInserted = 0;

    for (const category of categoryData) {
      for (const size of category.sizes) {
        const codes = category.codes.length > 0 ? category.codes : [null];

        for (const code of codes) {
          const moq = Math.random() < 0.35 ? 1 : random([3, 5, 10]);
          const quality = random(["A++", "A+", "B"]);
          const color = code ? codeToColor[code] || `Color ${code}` : null;
          const description = random(descriptions);
          const price = getPrice(category.productType);
          const origin = random(["China", "UAE", "Korea"]);
          const unit = category.productType === "Ribbon" ? "roll" : random(["box", "piece"]);
          const isAvailable = Math.random() < 0.9;
          const isActive = Math.random() < 0.95;

          const product = new Product({
            productType: category.productType,
            category: category._id,
            size,
            code,
            color,
            displaySpecs: code
              ? `100-yd, ${quality}, Code ${code}`
              : `100-yd, ${quality}`,
            stock: Math.floor(Math.random() * 291 + 10),
            moq,
            isAvailable,
            isActive,
            origin,
            unit,
            price,
            quality,
            images: [
              `https://picsum.photos/200/300?random=${Date.now() + totalInserted}`,
              `https://picsum.photos/200/300?random=${Date.now() + totalInserted + 1}`
            ],
            description
          });

          try {
            await product.save();
            totalInserted++;
          } catch (err) {
            console.error("❌ Failed to insert:", err.message);
          }
        }
      }
    }

    console.log(`✅ Seeded ${totalInserted} products.`);
    process.exit();
  } catch (err) {
    console.error("❌ Error seeding database:", err);
    process.exit(1);
  }
};

seedDatabase();
