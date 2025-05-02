import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// ✅ Ensure the script finds the `.env` file in the root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import mongoose from "mongoose";
import Product from "../backend/models/productModel.js"; // Adjusted path
import connectDB from "../backend/config/db.js"; // Adjusted path

console.log("🔍 Debug: MONGO_URI =", process.env.MONGO_URI); // Check if MONGO_URI is loaded

connectDB(); // Connect to MongoDB

const getRandomImage = () => `https://picsum.photos/400/300?random=${Math.floor(Math.random() * 1000)}`;

const updateProductImages = async () => {
  try {
    const products = await Product.find();
    if (products.length === 0) {
      console.log("No products found.");
      process.exit();
    }

    for (let product of products) {
      product.image = getRandomImage();
      await product.save();
      console.log(`Updated: ${product.name} → ${product.image}`);
    }

    console.log("✅ All products updated with random images!");
    process.exit();
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
};

updateProductImages();
