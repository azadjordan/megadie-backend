// seed.js
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import connectDB from "./config/db.js";
import Product from "./models/productModel.js";
import Category from "./models/categoryModel.js";

// Load env variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const colors = ["Red", "Blue", "Black", "White", "Transparent", "Green"];
const origins = ["China", "Germany", "UAE", "India"];
const generateRandomPrice = () => +(Math.random() * (20 - 2) + 2).toFixed(2);
const generateImages = () => [
  `https://picsum.photos/200/300?random=${Math.floor(Math.random() * 1000)}`,
  `https://picsum.photos/200/300?random=${Math.floor(Math.random() * 1000) + 1}`,
];
const getRandomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];

const seedDatabase = async () => {
  try {
    await connectDB();
    await Product.deleteMany();
    console.log("🧹 Cleared existing products");

    const categories = await Category.find();
    if (categories.length === 0) throw new Error("No categories found");

    const products = [];

    for (let i = 0; i < 50; i++) {
      const category = getRandomItem(categories);

      const filterMap = {};
      for (const filter of category.filters) {
        filterMap[filter.Key] = filter.values;
      }

      const size = getRandomItem(filterMap.size || []);
      const colorCode = getRandomItem(filterMap.code || []);

      const product = new Product({
        name: `${category.name} Product ${i + 1}`,
        productType: category.productType,
        category: category._id,
        size: size || "Unknown",
        color: getRandomItem(colors),
        code: colorCode || 1000 + i,
        displaySpecs: `${colorCode || "N/A"} | ${size || "N/A"}`,
        stock: Math.floor(Math.random() * 100) + 10,
        moq: Math.floor(Math.random() * 10) + 1,
        isAvailable: Math.random() < 0.9,
        origin: getRandomItem(origins),
        storageLocation: `Warehouse ${getRandomItem(["A", "B", "C"])} - Shelf ${Math.ceil(
          Math.random() * 10
        )}`,
        price: generateRandomPrice(),
        unit: "roll",
        images: generateImages(),
        description: `High-quality ${category.name} product.`,
        sku: `SKU-${category.name.substring(0, 3).toUpperCase()}-${i + 1}`,
      });

      products.push(product);
    }

    await Product.insertMany(products);
    console.log(`✅ Inserted ${products.length} products.`);
    process.exit();
  } catch (err) {
    console.error("❌ Error:", err);
    process.exit(1);
  }
};

seedDatabase();
