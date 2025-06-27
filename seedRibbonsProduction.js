import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Product from "./models/productModel.js";
import mongoose from "mongoose";
import Category from "./models/categoryModel.js";

// Load .env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "./.env.development") });

// Hardcoded category IDs
const CATEGORY_IDS = {
  Grosgrain: "6818eb8ac41080fe6475cb11",
  Satin: "681988fdc41080fe6475cb6c",
};

const ribbonColors = {
  "000": "OffWhite",
  "007": "ShellGrey",
  "009": "LightSilver",
  "012": "Silver",
  "017": "MetalGrey",
  "028": "AntiqueWhite",
  "029": "White",
  "030": "Black",
  "077": "Charcoal",
  105: "SideshowRose",
  112: "Nude",
  117: "LightPink",
  123: "PearlPink",
  141: "Cinnabar",
  148: "Tulip",
  151: "Peony",
  156: "HotPink",
  157: "CamelliaRose",
  158: "Quartz",
  168: "ColonialRose",
  169: "Rosewood",
  177: "RoseWine",
  182: "RoseBloom",
  238: "LightCoral",
  250: "Red",
  260: "Scarlet",
  275: "Wine",
  285: "Plum",
  305: "LightBlue",
  311: "BlueMist",
  314: "Aqua",
  323: "Tropic",
  326: "MethylBlue",
  332: "FrenchBlue",
  338: "AntiqueBlue",
  346: "Jade",
  350: "Royal",
  365: "LightNavy",
  370: "Navy",
  420: "LilacMist",
  434: "Fresco",
  463: "Grape",
  467: "UltraViolet",
  510: "IceMint",
  544: "KeyLime",
  548: "Kiwi",
  550: "AppleGreen",
  563: "Willow",
  566: "SoftPine",
  570: "Moss",
  577: "SageGreen",
  579: "ClassicalGreen",
  587: "ForestGreen",
  589: "Hunter",
  593: "Spruce",
  600: "NeonOrange",
  640: "Lemon",
  662: "Dandelion",
  675: "Gold",
  686: "GoldenOlive",
  687: "Dijon",
  690: "OldGold",
  693: "PaleGold",
  720: "Peach",
  751: "RussetOrange",
  761: "AutumnOrange",
  765: "MandarinOrange",
  777: "Chutney",
  779: "PecanBrown",
  780: "Rust",
  812: "Natural",
  813: "Vanilla",
  815: "Cream",
  823: "Taupe",
  824: "Buttermilk",
  835: "Tan",
  838: "Fossil",
  839: "ChocolateChip",
  840: "Ermine",
  846: "GoldenBrown",
  855: "BlackCoffee",
  868: "Cappuccino",
  869: "RootBeer",
  870: "FriarBrown",
};

const sizes = ["1-inch", "1/2-inch"];

const seedRibbons = async () => {
  try {
await mongoose.connect("mongodb+srv://azadkkurdi:Kurdi1995%24@cluster0.rmtrm.mongodb.net/megadie-production?retryWrites=true&w=majority&appName=Cluster0");
    console.log("✅ Connected to DB");

    await Product.deleteMany({ productType: "Ribbon" });
    console.log("🧹 Cleared existing ribbon products");

    const products = [];

    for (const [code, color] of Object.entries(ribbonColors)) {
      for (const [catName, catId] of Object.entries(CATEGORY_IDS)) {
        for (const size of sizes) {
          const imageUrl = `https://megadie.s3.eu-central-1.amazonaws.com/Plain+${catName}+Ribbons/${code}${color}${catName}.jpg`;

          const variant = "100-yd"; // or use random: VARIANT_OPTIONS[Math.floor(Math.random() * 3)];
          const quality = "A++"; // or use random: QUALITY_OPTIONS[Math.floor(Math.random() * 3)];

          const sort = Number(code); // Converts "007" to 7, "117" to 117

          products.push({
            productType: "Ribbon",
            category: catId,
            size,
            variant,
            color,
            code,
            sort, // ✅ add this
            quality,
            unit: 'One Roll',
            images: [imageUrl],
          });
        }
      }
    }

    for (let i = 0; i < products.length; i += 100) {
      const batch = products.slice(i, i + 100);
      await Product.insertMany(batch);
    }

    console.log(`🎉 Inserted ${products.length} ribbon products.`);
    process.exit(0);
  } catch (error) {
    console.error("❌ Failed to seed ribbons:", error);
    process.exit(1);
  }
};

seedRibbons();
