// models/productModel.js
import mongoose from "mongoose";
import {
  PRODUCT_TYPES, PARENT_COLORS, SIZES, GRADES, VARIANTS,
} from "../constants.js";

/** Uppercase, trim, and normalize tokens. Keep A–Z, 0–9, dot, and slash. */
function sanitizeToken(value) {
  if (!value) return "";
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9./]+/g, "-") // spaces & others -> dash
    .replace(/-+/g, "-")           // collapse multiple dashes
    .replace(/^-+|-+$/g, "");      // trim edge dashes
}

/** Build deterministic SKU using Category.key and product fields (skip empty parts). */
async function buildSkuForDoc(doc) {
  const Category = doc.model("Category");
  const cat = await Category.findById(doc.category).select("key productType").lean();
  if (!cat) throw new Error("Invalid category");

  // Ensure productType mirrors category (ignore client input)
  doc.productType = cat.productType;

  const parts = [
    sanitizeToken(doc.productType),  // productType (from category)
    sanitizeToken(cat.key),          // category key
    sanitizeToken(doc.size),
    sanitizeToken(doc.color),
    sanitizeToken(doc.catalogCode),
    sanitizeToken(doc.variant),
    sanitizeToken(doc.grade),
    sanitizeToken(doc.source),
    sanitizeToken(doc.packingUnit),
  ].filter(Boolean);

  return parts.length ? parts.join("-") : "SKU";
}

const productSchema = new mongoose.Schema(
  {
    name:         { type: String, required: true, trim: true },
    displaySpecs: { type: String, trim: true },

    // Always mirrored from Category in pre('validate')
    productType:  { type: String, enum: PRODUCT_TYPES, required: true },
    category:     { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },
    size:         { type: String, enum: SIZES, required: true },

    color:        { type: String, trim: true },
    catalogCode:  { type: String, trim: true },
    parentColor:  { type: String, enum: PARENT_COLORS, required: true, index: true },

    variant:      { type: String, enum: VARIANTS },

    // Numbers can be integers or decimals
    cbm:          { type: Number, min: 0, default: 0 },
    grade:        { type: String, enum: GRADES },
    source:       { type: String, trim: true },
    packingUnit:  { type: String, trim: true },

    sku:          { type: String, required: true, unique: true, trim: true },

    moq:          { type: Number, default: 1, min: 1 },
    isAvailable:  { type: Boolean, default: true },
    price:        { type: Number, default: 0, min: 0 },

    // Basic URL guard on images (length + simple scheme/path check)
    images: {
      type: [String],
      default: [],
      validate: {
        validator: (arr) =>
          Array.isArray(arr) &&
          arr.every((s) =>
            typeof s === "string" &&
            s.length > 0 &&
            s.length <= 2048 &&
            (/^https?:\/\//i.test(s) || s.startsWith("/") || s.startsWith("data:"))
          ),
        message: "Each image must be a reasonable URL or absolute path.",
      },
    },

    description:  { type: String, trim: true },
    sort:         { type: Number },
    isActive:     { type: Boolean, default: true },
  },
  { timestamps: true }
);

/**
 * Auto-sync productType from Category and build/rebuild SKU on create/update.
 * No duplicate handling here — unique index on `sku` will surface conflicts.
 */
productSchema.pre("validate", async function(next) {
  try {
    if (!this.category) return next(new Error("Category is required"));

    // Fields that affect the SKU
    const contributing = [
      "category",
      "productType", // will mirror category
      "size",
      "color",
      "catalogCode",
      "variant",
      "grade",
      "source",
      "packingUnit",
    ];

    const needsSku = !this.sku || contributing.some((f) => this.isModified(f));
    if (needsSku) {
      this.sku = await buildSkuForDoc(this);
    }

    next();
  } catch (err) {
    next(err);
  }
});

/** Stable, clean JSON output for APIs */
productSchema.set("toJSON", {
  versionKey: false,   // hide __v
  virtuals: true,      // include future virtuals
  transform: (_doc, ret) => {
    ret.id = ret._id;  // frontend-friendly id
    delete ret._id;
  },
});

/** Helpful indexes (match real queries) */
productSchema.index({ sku: 1 }, { unique: true }); // explicit
productSchema.index({ productType: 1, category: 1, isActive: 1 });
productSchema.index({ productType: 1, category: 1, size: 1, parentColor: 1, isActive: 1 });
productSchema.index({ sort: 1, productType: 1 });     // curated Ribbon ordering
productSchema.index({ createdAt: -1, _id: 1 });       // stable default sort
productSchema.index({ size: 1 });
productSchema.index({ parentColor: 1 });
productSchema.index({ catalogCode: 1 });

const Product = mongoose.model("Product", productSchema);
export default Product;

// Optional bundle
export const ENUMS = { PRODUCT_TYPES, PARENT_COLORS, SIZES, GRADES, VARIANTS };
