import mongoose from "mongoose";
import {
  PRODUCT_TYPES,
  TAGS,            // ??.?,? global tag enum
  SIZES,
  GRADES,
  VARIANTS,
  FINISHES,
  PACKING_UNITS,
  ribbonCatalogCodes,
  SKU_TOKENS,
} from "../constants.js";
import { buildName, buildSku } from "../utils/productNaming.js";

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
  const sku = buildSku(
    {
      productType: doc.productType,
      categoryKey: cat.key,
      size: doc.size,
      color: doc.color,
      catalogCode: doc.catalogCode,
      variant: doc.variant,
      grade: doc.grade,
      finish: doc.finish,
      packingUnit: doc.packingUnit,
    },
    SKU_TOKENS
  );

  // ---------- Human-facing name (full words) ----------
  doc.name = buildName({
    productType: doc.productType,
    categoryLabel: cat.label || cat.key,
    size: doc.size,
    color: doc.color,
    finish: doc.finish,
    packingUnit: doc.packingUnit,
    grade: doc.grade,
  });

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
    catalogCode: {
      type: String,
      trim: true,
      validate: {
        validator: function (value) {
          if (!value) return true;
          if (this.productType !== "Ribbon") return false;
          return ribbonCatalogCodes.includes(String(value));
        },
        message:
          "Catalog code must be a valid Ribbon catalog code from the approved list.",
      },
    },

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
    cbm: { type: Number, min: 0, required: true },

    grade: { type: String, enum: GRADES },

    finish: { type: String, enum: FINISHES, trim: true },

    packingUnit: { type: String, enum: PACKING_UNITS, required: true, trim: true },

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
  PACKING_UNITS,
};
