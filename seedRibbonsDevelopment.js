// seedRibbonsDevelopment.js
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import Product from "./models/productModel.js";
import "./models/categoryModel.js"; // ✅ ensure Category schema is registered

// -------------------- ENV & PATH SETUP --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env (if needed for other config)
dotenv.config({ path: path.resolve(__dirname, "./.env.development") });

// -------------------- CONSTANTS --------------------

// Hardcoded category IDs (development DB)
// Must match your actual Category docs
const CATEGORY_IDS = {
  Grosgrain: "68f9cf826e4f854692135fb4",
  Satin:     "68fa1c15d4e18658149e77bc",
};

// We only seed these two sizes (must match SIZES in constants.js)
const SIZES_FOR_SEED = ["25 mm", "13 mm"];

// Color code → color name
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

/**
 * Map each specific ribbon color name → high-level parentGroup
 * Allowed parent groups (RIBBON_PARENT_GROUPS):
 *  "Red", "Pink", "Orange", "Yellow", "Green",
 *  "Blue", "Purple", "Brown", "Grey", "Black", "White", "Beige"
 */
const COLOR_PARENT_GROUPS = {
  // Whites / off-whites / neutrals
  OffWhite:      "White",
  AntiqueWhite:  "Beige",
  White:         "White",
  Natural:       "Beige",
  Vanilla:       "Beige",
  Cream:         "Beige",
  Buttermilk:    "Beige",
  Tan:           "Brown",
  Ermine:        "Brown",

  // Greys / silvers / charcoals
  ShellGrey:     "Grey",
  LightSilver:   "Grey",
  Silver:        "Grey",
  MetalGrey:     "Grey",
  Charcoal:      "Grey",
  Fossil:        "Grey",

  // Blacks
  Black:         "Black",

  // Pinks / roses / corals
  SideshowRose:  "Pink",
  LightPink:     "Pink",
  PearlPink:     "Pink",
  Tulip:         "Pink",
  Peony:         "Pink",
  HotPink:       "Pink",
  CamelliaRose:  "Pink",
  Quartz:        "Pink",
  ColonialRose:  "Pink",
  Rosewood:      "Pink",
  RoseWine:      "Pink",
  RoseBloom:     "Pink",
  LightCoral:    "Pink",

  // Reds
  Cinnabar:      "Red",
  Red:           "Red",
  Scarlet:       "Red",
  Wine:          "Red",

  // Purples
  Plum:          "Purple",
  LilacMist:     "Purple",
  Fresco:        "Purple",
  Grape:         "Purple",
  UltraViolet:   "Purple",

  // Blues / teals leaning blue
  LightBlue:     "Blue",
  BlueMist:      "Blue",
  Aqua:          "Blue",
  Tropic:        "Blue",
  MethylBlue:    "Blue",
  FrenchBlue:    "Blue",
  AntiqueBlue:   "Blue",
  Royal:         "Blue",
  LightNavy:     "Blue",
  Navy:          "Blue",

  // Greens
  IceMint:       "Green",
  KeyLime:       "Green",
  Kiwi:          "Green",
  AppleGreen:    "Green",
  Willow:        "Green",
  SoftPine:      "Green",
  Moss:          "Green",
  SageGreen:     "Green",
  ClassicalGreen:"Green",
  ForestGreen:   "Green",
  Hunter:        "Green",
  Spruce:        "Green",
  Jade:          "Green",
  GoldenOlive:   "Green",

  // Yellows / gold-ish
  Lemon:         "Yellow",
  Dandelion:     "Yellow",
  Gold:          "Yellow",
  Dijon:         "Yellow",
  OldGold:       "Yellow",
  PaleGold:      "Yellow",

  // Oranges
  NeonOrange:    "Orange",
  Peach:         "Orange",
  RussetOrange:  "Orange",
  AutumnOrange:  "Orange",
  MandarinOrange:"Orange",
  Chutney:       "Orange",

  // Browns
  Nude:          "Beige",
  PecanBrown:    "Brown",
  Rust:          "Brown",
  Taupe:         "Brown",
  ChocolateChip: "Brown",
  GoldenBrown:   "Brown",
  BlackCoffee:   "Brown",
  Cappuccino:    "Brown",
  RootBeer:      "Brown",
  FriarBrown:    "Brown",
};

// Category + size → priceRule (Premium only)
const PRICE_RULE_BY_CATEGORY_AND_SIZE = {
  Grosgrain: {
    "25 mm": "RIB-GRO-25MM-100YD-PREM",
    "13 mm": "RIB-GRO-13MM-100YD-PREM",
  },
  Satin: {
    "25 mm": "RIB-SAT-25MM-100YD-PREM",
    "13 mm": "RIB-SAT-13MM-100YD-PREM",
  },
};

function getPriceRule(catName, size) {
  const bySize = PRICE_RULE_BY_CATEGORY_AND_SIZE[catName];
  if (!bySize) {
    throw new Error(`No priceRule mapping for category "${catName}"`);
  }
  const rule = bySize[size];
  if (!rule) {
    throw new Error(`No priceRule mapping for category "${catName}" and size "${size}"`);
  }
  return rule;
}

// -------------------- SEED LOGIC --------------------

const seedRibbons = async () => {
  try {
    await mongoose.connect(
      "mongodb+srv://azadkkurdi:Kurdi1995%24@cluster0.rmtrm.mongodb.net/megadie-development?retryWrites=true&w=majority&appName=Cluster0"
    );
    console.log("✅ Connected to DB");

    // Clear existing ribbon products
    await Product.deleteMany({ productType: "Ribbon" });
    console.log("🧹 Cleared existing ribbon products");

    const totalExpected =
      Object.keys(ribbonColors).length *
      Object.keys(CATEGORY_IDS).length *
      SIZES_FOR_SEED.length;

    console.log(`ℹ️ Preparing to insert ~${totalExpected} Ribbon products...`);

    let createdCount = 0;

    // For each color code + name
    for (const [rawCode, colorName] of Object.entries(ribbonColors)) {
      const code = String(rawCode);  // keep original string form like "000" or "105"
      const sort = Number(code);     // "007" -> 7

      // Derive parent group for this color (if mapping missing, will be undefined)
      const parentGroup = COLOR_PARENT_GROUPS[colorName];

      // For each category (Grosgrain, Satin)
      for (const [catName, catId] of Object.entries(CATEGORY_IDS)) {
        // For each size (25 mm, 13 mm)
        for (const size of SIZES_FOR_SEED) {
          const priceRule = getPriceRule(catName, size);

          const imageUrl =
            `https://megadie.s3.eu-central-1.amazonaws.com/Plain+${catName}+Ribbons/` +
            `${code}${colorName}${catName}.jpg`;

          const productDoc = {
            // Explicitly set productType (even though the hook mirrors it from Category)
            productType: "Ribbon",

            category: catId,          // Category _id
            size,                     // "25 mm" / "13 mm"
            priceRule,                // one of the 4 PREM rules

            color: colorName,         // "ShellGrey", "Red", etc.
            parentGroup,              // high-level color family for filters
            catalogCode: code,        // numeric color code as catalog code

            variant: "100 Yards",     // common across all products
            grade: "Premium",         // common across all products
            packingUnit: "Roll",      // as requested

            sort,                     // for ordering by color code
            images: [imageUrl],

            // cbm, moq, isAvailable, isActive left as defaults in the schema
          };

          const product = new Product(productDoc);
          await product.save();       // runs validation + pre('validate') hook (builds sku + name)

          createdCount += 1;
        }
      }
    }

    console.log(`🎉 Inserted ${createdCount} ribbon products.`);
    process.exit(0);
  } catch (error) {
    console.error("❌ Failed to seed ribbons:", error);
    process.exit(1);
  }
};

seedRibbons();
