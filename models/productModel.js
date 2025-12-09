import mongoose from "mongoose";
import {
  PRODUCT_TYPES,
  TAGS,            // ⬅️ global tag enum
  SIZES,
  GRADES,
  VARIANTS,
  PRICE_RULES,
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

/** Build SKU + Name */
async function buildSkuForDoc(doc) {
  const Category = doc.model("Category");
  const cat = await Category.findById(doc.category)
    .select("key label productType")
    .lean();

  if (!cat) throw new Error("Invalid category");

  doc.productType = cat.productType;

  const parts = [
    sanitizeToken(doc.productType),
    sanitizeToken(cat.key),
    sanitizeToken(doc.size),
    sanitizeToken(doc.color),
    sanitizeToken(doc.catalogCode),
    sanitizeToken(doc.variant),
    sanitizeToken(doc.grade),
    sanitizeToken(doc.finish),
    sanitizeToken(doc.packingUnit),
  ].filter(Boolean);

  const sku = parts.join("|") || "SKU";

  const nameParts = [
    doc.productType,
    cat.label || cat.key,
    doc.size,
    doc.color,
    doc.finish,
    doc.variant,
    doc.grade,
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
      enum: PRICE_RULES,
      required: true,
      index: true,
    },

    color: { type: String, trim: true },
    catalogCode: { type: String, trim: true },

    // 🔥 Universal global tags
    tags: {
      type: [String],
      default: [],
      validate: {
        validator: (arr) => arr.every(t => TAGS.includes(t)),
        message: (props) =>
          `Invalid tag(s): ${props.value.filter(t => !TAGS.includes(t)).join(", ")}`,
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