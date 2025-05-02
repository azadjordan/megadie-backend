import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import connectDB from "./config/db.js";
import Product from "./models/productModel.js";
import Category from "./models/categoryModel.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const colors = ["Red", "Blue", "Black", "White", "Transparent", "Green"];
const origins = ["China", "Germany", "UAE", "India"];
const getRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

const seedDatabase = async () => {
  try {
    await connectDB();
    await Product.deleteMany({});
    console.log("🧹 Cleared existing products");

    const categories = await Category.find({});
    if (!categories.length) throw new Error("No categories found!");

    const products = [];

    for (let i = 0; i < 50; i++) {
      const category = getRandom(categories);
      const filters = category.filters || [];
      const sizeFilter = filters.find((f) => f.Key === "size");
      const codeFilter = filters.find((f) => f.Key === "code");

      const size = sizeFilter ? getRandom(sizeFilter.values) : "N/A";
      const color = getRandom(colors);
      const code = codeFilter ? getRandom(codeFilter.values) : null;

      products.push({
        name: `${category.name} Product ${i + 1}`,
        productType: category.productType,
        category: category._id,
        size,
        color,
        code: code ? parseInt(code) : undefined,
        displaySpecs: `${color} | ${size}`,
        stock: Math.floor(Math.random() * 100) + 10,
        moq: Math.floor(Math.random() * 10) + 1,
        isAvailable: Math.random() < 0.9,
        origin: getRandom(origins),
        storageLocation: `Warehouse ${getRandom(["A", "B", "C"])} - Shelf ${Math.ceil(Math.random() * 10)}`,
        price: +(Math.random() * (20 - 2) + 2).toFixed(2),
        unit: "roll",
        images: [
          `https://picsum.photos/200/300?random=${Math.floor(Math.random() * 1000)}`,
          `https://picsum.photos/200/300?random=${Math.floor(Math.random() * 1000) + 1}`,
        ],
        description: `High-quality ${category.name} product.`,
      });
    }

    await Product.insertMany(products);
    console.log("✅ Seeded 50 products");
    process.exit();
  } catch (err) {
    console.error("❌ Failed to seed:", err);
    process.exit(1);
  }
};

seedDatabase();
