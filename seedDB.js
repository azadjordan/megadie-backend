import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import connectDB from "./config/db.js";
import Product from "./models/productModel.js";
import Subcategory from "./models/categoryModel.js";

// Load env variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const categories = ["Ribbon", "Creasing Matrix", "Double Face Tape"];

const subcategoriesData = {
  Ribbon: ["Satin", "Grosgrain"],
  "Creasing Matrix": ["PVC", "PET", "Fiber", "Pressboard"],
  "Double Face Tape": ["Acrylic", "Paper"],
};

const sizeOptions = {
  Ribbon: ["1-inch", "0.5-inch"],
  "Creasing Matrix": ["0.4x1.5", "0.5x1.6"],
  "Double Face Tape": ["6mm", "9mm", "10mm", "12mm"],
};

const colors = ["Red", "Blue", "Black", "White", "Transparent", "Green"];

const generateRandomPrice = () => +(Math.random() * (20 - 2) + 2).toFixed(2);

const generateImages = () => [
  `https://picsum.photos/200/300?random=${Math.floor(Math.random() * 1000)}`,
  `https://picsum.photos/200/300?random=${Math.floor(Math.random() * 1000) + 1}`,
];

const getRandomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];

const seedDatabase = async () => {
  try {
    await connectDB();

    // ❌ Only delete products, not subcategories or anything else
    await Product.deleteMany({});
    console.log("🧹 Cleared existing products");

    // 🧠 Fetch existing subcategories so we don't recreate or delete them
    const subcategories = await Subcategory.find({});
    const subcategoryMap = {};

    for (const sub of subcategories) {
      const { category } = sub;
      if (!subcategoryMap[category]) {
        subcategoryMap[category] = [];
      }
      subcategoryMap[category].push(sub._id);
    }

    const products = [];

    for (let i = 0; i < 50; i++) {
      const category = getRandomItem(categories);
      const subcategoryList = subcategoryMap[category];
      if (!subcategoryList || subcategoryList.length === 0) continue; // Skip if no subcategories available

      const subcategory = getRandomItem(subcategoryList);
      const size = getRandomItem(sizeOptions[category]);
      const color = getRandomItem(colors);

      const product = {
        name: `${category} Product ${i + 1}`,
        category,
        subcategory,
        size,
        color,
        code: 1000 + i,
        displaySpecs: `${color} | ${size}`,
        stock: Math.floor(Math.random() * 100) + 10,
        moq: Math.floor(Math.random() * 10) + 1,
        isAvailable: Math.random() < 0.9,
        origin: getRandomItem(["China", "Germany", "UAE", "India"]),
        storageLocation: `Warehouse ${getRandomItem(["A", "B", "C"])} - Shelf ${Math.ceil(Math.random() * 10)}`,
        price: generateRandomPrice(),
        unit: "roll",
        images: generateImages(),
        description: `High-quality ${category} product.`,
        sku: `SKU-${category.substring(0, 3).toUpperCase()}-${i + 1}`,
      };

      products.push(product);
    }

    await Product.insertMany(products);
    console.log(`✅ Inserted ${products.length} new products.`);
    process.exit();
  } catch (err) {
    console.error("❌ Error seeding products:", err);
    process.exit(1);
  }
};

seedDatabase();
