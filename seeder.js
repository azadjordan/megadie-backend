import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import connectDB from "./config/db.js";
import Product from "./models/productModel.js";
import User from "./models/userModel.js";

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

console.log(`MONGO_URI from .env in seeder.js: ${process.env.MONGO_URI}`);

connectDB();

// Define categories and their dynamic specifications
const categories = {
    "Ribbons": {
        "Color": ["Red", "Blue", "Green", "Yellow", "Black", "White"],
        "Material": ["Polyester", "Satin", "Grosgrain"],
        "Width": ["0.5-inch", "1-inch", "2-inch"],
        "Length Per Roll": ["25 meters", "50 meters", "100 meters"]
    },
    "Tapes": {
        "Adhesive Type": ["Acrylic", "Rubber-Based", "Silicone"],
        "Thickness": ["0.5mm", "1mm", "2mm"],
        "Length Per Roll": ["10 meters", "20 meters", "30 meters"]
    },
    "Creasing Channel": {
        "Thickness": ["2mm", "3mm", "4mm"],
        "Material": ["Plastic", "Steel", "Aluminum"],
        "Hardness": ["Soft", "Medium", "Hard"]
    },
    "Die Ejection Rubber": {
        "Color": ["Red", "Blue", "Black"],
        "Thickness": ["3mm", "5mm", "8mm"],
        "Hardness": ["60 Shore A", "70 Shore A", "80 Shore A"]
    },
    "Magnets": {
        "Magnet Strength": ["N35", "N45", "N52"],
        "Shape": ["Disc", "Block", "Cylinder"],
        "Diameter": ["5mm", "10mm", "15mm"],
        "Thickness": ["1mm", "2mm", "5mm"]
    },
    "Other": {
        "Feature": ["Customizable", "Durable", "Weatherproof"]
    }
};

// Function to generate random products with a random Picsum image
const generateRandomProduct = () => {
    const category = Object.keys(categories)[Math.floor(Math.random() * Object.keys(categories).length)];
    const specs = Object.fromEntries(
        Object.entries(categories[category]).map(([key, values]) => [key, values[Math.floor(Math.random() * values.length)]])
    );

    return {
        name: `Sample ${category} ${Math.floor(100 + Math.random() * 900)}`,
        source: "China",
        category,
        description: `This is a high-quality ${category.toLowerCase()} product.`,
        price: (Math.random() * (100 - 5) + 5).toFixed(2),
        qty: Math.floor(Math.random() * 50) + 1,
        image: `https://picsum.photos/200/300?random=${Math.floor(Math.random() * 1000)}`, // ✅ Random Picsum image
        inStock: true,
        specifications: specs
    };
};

const seedData = async () => {
    try {
        await connectDB();  // ✅ Ensure connection is established first
        await Product.deleteMany();
        console.log("Products deleted!");

        await User.deleteMany();
        console.log("Users deleted!");

        const users = [
            { name: "Admin User", email: "admin@example.com", password: "123456", isAdmin: true },
            { name: "Test User", email: "user@example.com", password: "123456", isAdmin: false }
        ];
        const createdUsers = await User.insertMany(users);
        const adminUser = createdUsers.find(user => user.isAdmin)._id;

        const sampleProducts = Array.from({ length: 30 }, generateRandomProduct).map(product => ({
            ...product,
            user: adminUser
        }));

        await Product.insertMany(sampleProducts);
        console.log("30 Random Products Seeded Successfully!");
        process.exit();
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
};

const destroyData = async () => {
    try {
        await connectDB();  // ✅ Ensure connection is established first
        await Product.deleteMany();
        await User.deleteMany();
        console.log("All data destroyed successfully!");
        process.exit();
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
};


if (process.argv[2] === "-d") {
    destroyData();
} else {
    seedData();
}
