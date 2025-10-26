// models/productModel.js
import mongoose from "mongoose";
import {
  PRODUCT_TYPES,
  PARENT_COLORS,
  SIZES,
  GRADES,
  VARIANTS,
} from "../constants.js";

/** Uppercase, trim, and normalize tokens. Keep A–Z, 0–9, dot, and slash. */
function sanitizeToken(value) {
  if (!value) return "";
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9./]+/g, "-") // spaces & others → dash temporarily
    .replace(/-+/g, "-")           // collapse multiple dashes
    .replace(/^-+|-+$/g, "");      // trim edge dashes
}

/** Pretty helpers for human-facing strings */
const titleCase = (s) =>
  !s ? "" : String(s).toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());

const prettySize = (size) => {
  if (!size) return "";
  // "25-mm" -> "25 mm", "0.5x1.5-mm" -> "0.5 × 1.5 mm"
  const mm = size.replace(/-mm$/i, " mm");
  return mm.replace(/x/gi, " × ");
};

const VARIANT_PRETTY = {
  "100-yd": "100 Yards",
  "150-yd": "150 Yards",
  "35-yd": "35 Yards",
  "50-m": "50 Meters",
  "50-pcs": "50 Pieces",
};
const prettyVariant = (v) => (v ? VARIANT_PRETTY[v] || v : "");

/** Build deterministic SKU using Category.key and product fields (skip empty parts). */
async function buildSkuForDoc(doc) {
  const Category = doc.model("Category");
  const cat = await Category.findById(doc.category)
    .select("key productType displayName name")
    .lean();
  if (!cat) throw new Error("Invalid category");

  // Ensure productType mirrors category (ignore client input)
  doc.productType = cat.productType;

  const parts = [
    sanitizeToken(doc.productType), // productType (from category)
    sanitizeToken(cat.key),         // category key
    sanitizeToken(doc.size),
    sanitizeToken(doc.color),
    sanitizeToken(doc.catalogCode),
    sanitizeToken(doc.variant),
    sanitizeToken(doc.grade),
    sanitizeToken(doc.source),      // included in SKU but NOT in displaySpecs/name
    sanitizeToken(doc.packingUnit),
  ].filter(Boolean);

  // Use '|' instead of '-' between parts
  const sku = parts.length ? parts.join("|") : "SKU";

  // --------- Build human-facing strings (displaySpecs & name) ----------
  const categoryName = titleCase(cat.displayName || cat.name || cat.key);

  const productTypePretty = doc.productType; // enums already Title Cased
  const sizePretty = prettySize(doc.size);

  // IMPORTANT: show ONLY the actual product color; never include parentColor in display strings.
  const colorPretty = doc.color ? String(doc.color) : "";

  const variantPretty = prettyVariant(doc.variant);
  const gradePretty = doc.grade ? titleCase(doc.grade) : "";
  const unitPretty = doc.packingUnit ? titleCase(doc.packingUnit) : "";
  const catalogPretty = doc.catalogCode || "";

  // displaySpecs: includes everything except source
  const displaySpecsParts = [
    productTypePretty,
    categoryName,
    sizePretty,
    colorPretty,
    variantPretty,
    gradePretty && `Grade: ${gradePretty}`,
    unitPretty && `Unit: ${unitPretty}`,
    catalogPretty && `Catalog: ${catalogPretty}`,
  ].filter(Boolean);

  // name: same as displaySpecs but without packingUnit & catalogCode (and source already excluded)
  const nameParts = [
    productTypePretty,
    categoryName,
    sizePretty,
    colorPretty,
    variantPretty,
    gradePretty, // no "Grade:" label in name; just the value
  ].filter(Boolean);

  // Assign
  doc.displaySpecs = displaySpecsParts.join(" · ");
  doc.name = nameParts.join(" · ");

  return sku;
}

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },        // auto-generated
    displaySpecs: { type: String, trim: true },                // auto-generated

    // Always mirrored from Category in pre('validate')
    productType: { type: String, enum: PRODUCT_TYPES, required: true },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    size: { type: String, enum: SIZES, required: true },

    color: { type: String, trim: true },
    catalogCode: { type: String, trim: true },
    parentColor: {
      type: String,
      enum: PARENT_COLORS,
      required: true,
      index: true, // keep single-field index via field option
    },

    variant: { type: String, enum: VARIANTS },

    // Numbers can be integers or decimals
    cbm: { type: Number, min: 0, default: 0 },
    grade: { type: String, enum: GRADES },
    source: { type: String, trim: true },
    packingUnit: { type: String, trim: true },

    sku: { type: String, required: true, unique: true, trim: true }, // unique index via field option

    moq: { type: Number, default: 1, min: 1 },
    isAvailable: { type: Boolean, default: true },
    price: { type: Number, default: 0, min: 0 },

    // Basic URL guard on images (length + simple scheme/path check)
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
 * Auto-sync productType from Category and build/rebuild SKU, displaySpecs, and name on create/update.
 * No duplicate handling here — unique index on `sku` will surface conflicts.
 */
productSchema.pre("validate", async function (next) {
  try {
    if (!this.category) return next(new Error("Category is required"));

    // Fields that affect SKU / generated texts
    const contributing = [
      "category",
      "productType", // will mirror category
      "size",
      "color",       // display uses only `color`
      "catalogCode",
      "variant",
      "grade",
      "source",
      "packingUnit",
      // NOTE: parentColor is intentionally NOT included; it's for filtering only
    ];

    const changed = contributing.some((f) => this.isModified(f));
    if (!this.sku || changed) {
      this.sku = await buildSkuForDoc(this); // also regenerates name/displaySpecs
    }

    next();
  } catch (err) {
    next(err);
  }
});

/** Stable, clean JSON output for APIs */
productSchema.set("toJSON", {
  versionKey: false, // hide __v
  virtuals: true, // include future virtuals
  transform: (_doc, ret) => {
    ret.id = ret._id; // frontend-friendly id
    delete ret._id;
  },
});

/** Helpful indexes (match real queries) */
// NOTE: removed duplicates:
//  - sku: unique index already created by field option (unique: true)
//  - parentColor: single-field index already created by field option (index: true)
productSchema.index({ productType: 1, category: 1, isActive: 1 });
productSchema.index({
  productType: 1,
  category: 1,
  size: 1,
  parentColor: 1,
  isActive: 1,
});
productSchema.index({ sort: 1, productType: 1 }); // curated Ribbon ordering
productSchema.index({ createdAt: -1, _id: 1 });   // stable default sort
productSchema.index({ size: 1 });
productSchema.index({ catalogCode: 1 });

const Product = mongoose.model("Product", productSchema);
export default Product;

// Optional bundle
export const ENUMS = {
  PRODUCT_TYPES,
  PARENT_COLORS,
  SIZES,
  GRADES,
  VARIANTS,
};
