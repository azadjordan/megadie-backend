import mongoose from "mongoose";
import {
  PRODUCT_TYPES,
  TAGS,            // ??.?,? global tag enum
  SIZES,
  GRADES,
  VARIANTS,
  FINISHES,
} from "../constants.js";

/** Normalize for SKU */
function sanitizeToken(value) {
  if (!value) return "";
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9./]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Mapping from verbose values ?+' short SKU codes
 * Only affects the `sku` field, NOT the human-facing `name`.
 */
const SKU_MAP = {
  productType: {
    Ribbon: "RIB",
    "Creasing Matrix": "CRM",
    "Double Face Tape": "DFT",
  },
  categoryKey: {
    grosgrain: "GRO",
    satin: "SAT",
    // add more if you add categories
  },
  grade: {
    Premium: "PREM",
    Standard: "STD",
    Economy: "ECO",
  },
  variant: {
    "100 Yards": "100-YD",
    "150 Yards": "150-YD",
    "35 Yards": "35-YD",
    "50 Meters": "50-M",
    "50 Pieces": "50-PC",
  },
  finish: {
    "Single Face": "SF",
    "Double Face": "DF",
  },
  // optional: packing units if you ever want them shorter
  packingUnit: {
    Roll: "ROLL",
    // "Box": "BOX",
    // ...
  },
};

/** Helper: get a short code for a field, then sanitize it for SKU */
function skuToken(field, value) {
  if (!value) return "";
  const map = SKU_MAP[field];
  const raw = map?.[value] || value;
  return sanitizeToken(raw);
}

/** Build SKU + Name */
async function buildSkuForDoc(doc) {
  const Category = doc.model("Category");
  const cat = await Category.findById(doc.category)
    .select("key label productType")
    .lean();

  if (!cat) throw new Error("Invalid category");

  // mirror productType from Category
  doc.productType = cat.productType;

  // ---------- SKU PARTS (short codes) ----------
  const parts = [
    skuToken("productType", doc.productType), // RIB
    skuToken("categoryKey", cat.key),         // SAT / GRO
    sanitizeToken(doc.size),                  // 25-MM
    sanitizeToken(doc.color),                 // OFFWHITE
    sanitizeToken(doc.catalogCode),           // 000
    skuToken("variant", doc.variant),         // 100-YD
    skuToken("grade", doc.grade),             // PREM
    skuToken("finish", doc.finish),           // SF / DF
    skuToken("packingUnit", doc.packingUnit), // ROLL
  ].filter(Boolean);

  const sku = parts.join("|") || "SKU";

  // ---------- Human-facing name (full words) ----------
  const nameParts = [
    doc.productType,           // Ribbon
    cat.label || cat.key,      // Satin / Grosgrain
    doc.size,                  // 25 mm
    doc.color,                 // OffWhite
    doc.finish,                // Single Face
    doc.variant,               // 100 Yards
    doc.grade,                 // Premium
  ].filter(Boolean);

  doc.name = nameParts.join(" ");
  return sku;
}

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    productType: { type: String, enum: PRODUCT_TYPES, required: true },

    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },

    size: { type: String, enum: SIZES, required: true },

    priceRule: {
      type: String,
      required: true,
      index: true,
    },

    color: { type: String, trim: true },
    catalogCode: { type: String, trim: true },

    // dY"? Universal global tags
    tags: {
      type: [String],
      default: [],
      validate: {
        validator: (arr) => arr.every((t) => TAGS.includes(t)),
        message: (props) =>
          `Invalid tag(s): ${props.value
            .filter((t) => !TAGS.includes(t))
            .join(", ")}`,
      },
      index: true,
    },

    variant: { type: String, enum: VARIANTS },
    cbm: { type: Number, min: 0, default: 0 },

    grade: { type: String, enum: GRADES },

    finish: { type: String, enum: FINISHES, trim: true },

    packingUnit: { type: String, trim: true },

    sku: { type: String, required: true, unique: true, trim: true },

    moq: { type: Number, default: 1, min: 1 },
    isAvailable: { type: Boolean, default: true },
    isFeatured: { type: Boolean, default: false },
    featuredRank: { type: Number, default: 0 },

    images: {
      type: [String],
      default: [],
      validate: {
        validator: (arr) =>
          Array.isArray(arr) &&
          arr.every(
            (s) =>
              typeof s === "string" &&
              s.length <= 2048 &&
              (/^https?:\/\//i.test(s) ||
                s.startsWith("/") ||
                s.startsWith("data:"))
          ),
        message: "Each image must be a valid URL or path.",
      },
    },

    description: { type: String, trim: true },
    sort: { type: Number },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

productSchema.pre("validate", async function (next) {
  try {
    if (!this.category) return next(new Error("Category is required"));

    const contributing = [
      "category",
      "productType",
      "size",
      "color",
      "catalogCode",
      "variant",
      "grade",
      "finish",
      "packingUnit",
    ];

    const changed = contributing.some((f) => this.isModified(f));

    if (!this.sku || changed) {
      this.sku = await buildSkuForDoc(this);
    }

    next();
  } catch (err) {
    next(err);
  }
});

productSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
  },
});

productSchema.index({ productType: 1, category: 1, isActive: 1 });
productSchema.index({
  productType: 1,
  category: 1,
  size: 1,
  tags: 1,
  isActive: 1,
});
productSchema.index({ finish: 1 });
productSchema.index({ sort: 1, productType: 1 });
productSchema.index({ createdAt: -1, _id: 1 });
productSchema.index({ size: 1 });
productSchema.index({ catalogCode: 1 });
productSchema.index({ productType: 1, isFeatured: 1, featuredRank: 1, createdAt: -1 });

const Product = mongoose.model("Product", productSchema);
export default Product;

export const ENUMS = {
  PRODUCT_TYPES,
  TAGS,
  SIZES,
  GRADES,
  VARIANTS,
  FINISHES,
};
