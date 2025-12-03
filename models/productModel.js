// models/productModel.js
import mongoose from "mongoose";
import {
  PRODUCT_TYPES,
  RIBBON_PARENT_GROUPS,
  SIZES,
  GRADES,
  VARIANTS,
  PRICE_RULES,
} from "../constants.js";

/** Uppercase, trim, and normalize tokens. Keep A–Z, 0–9, dot, and slash. */
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
 * Build deterministic SKU using Category.key and product fields (skip empty parts),
 * and derive a human-facing `name`.
 */
async function buildSkuForDoc(doc) {
  const Category = doc.model("Category");
  const cat = await Category.findById(doc.category)
    .select("key label productType")
    .lean();
  if (!cat) throw new Error("Invalid category");

  // Ensure productType mirrors category
  doc.productType = cat.productType;

  const parts = [
    sanitizeToken(doc.productType),
    sanitizeToken(cat.key),
    sanitizeToken(doc.size),
    sanitizeToken(doc.color),
    sanitizeToken(doc.catalogCode),
    sanitizeToken(doc.variant),
    sanitizeToken(doc.grade),
    sanitizeToken(doc.packingUnit),
  ].filter(Boolean);

  const sku = parts.length ? parts.join("|") : "SKU";

  // ---------- Human-facing name ----------
  const nameParts = [
    doc.productType,
    cat.label || cat.key,
    doc.size || "",
    doc.color || "",
    doc.variant || "",
    doc.grade || "",
  ].filter(Boolean);

  doc.name = nameParts.join(" ");
  return sku;
}

const productSchema = new mongoose.Schema(
  {
    // Human-facing title
    name: { type: String, required: true, trim: true },

    // Mirrors category
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
      required: [true, "priceRule is required"],
      index: true,
    },

    color: { type: String, trim: true },

    catalogCode: { type: String, trim: true },

    // 🔥 Universal tagging system
    tags: {
      type: [String],
      default: [],
      index: true,
    },

    variant: { type: String, enum: VARIANTS },

    cbm: { type: Number, min: 0, default: 0 },

    grade: { type: String, enum: GRADES },

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
              s.length > 0 &&
              s.length <= 2048 &&
              (/^https?:\/\//i.test(s) ||
                s.startsWith("/") ||
                s.startsWith("data:"))
          ),
        message: "Each image must be a reasonable URL or absolute path.",
      },
    },

    description: { type: String, trim: true },

    sort: { type: Number },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

/**
 * Auto-build SKU and name whenever contributing fields change.
 */
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
      "packingUnit",
      // tags intentionally excluded (filtering only)
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
  versionKey: false,
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
  },
});

/** Best-practice indexes */
productSchema.index({ productType: 1, category: 1, isActive: 1 });
productSchema.index({
  productType: 1,
  category: 1,
  size: 1,
  tags: 1,
  isActive: 1,
});
productSchema.index({ sort: 1, productType: 1 });
productSchema.index({ createdAt: -1, _id: 1 });
productSchema.index({ size: 1 });
productSchema.index({ catalogCode: 1 });

const Product = mongoose.model("Product", productSchema);
export default Product;

export const ENUMS = {
  PRODUCT_TYPES,
  RIBBON_PARENT_GROUPS, // still for Ribbon UI
  SIZES,
  GRADES,
  VARIANTS,
};
