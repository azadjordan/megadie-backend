import mongoose from "mongoose";
import Category from "./categoryModel.js";

const productSchema = new mongoose.Schema(
  {
    // === PRIMARY FIELDS ===
    name: { type: String, required: true },
    productType: {
      type: String,
      enum: ["Ribbon", "Creasing Matrix", "Double Face Tape"],
      required: true,
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    size: {
      type: String,
      enum: [
        "1-inch",
        "1/2-inch",
        "3/4-inch",
        "0.4x1.5-mm",
        "0.5x1.5-mm",
        "0.5x1.6-mm",
        "6-mm",
        "9-mm",
        "10-mm",
        "12-mm",
      ],
      required: true,
    },
    variant: {
      type: String,
      enum: ["100-yd", "150-yd", "35-yd"],
    },
    color: String,
    code: String,
    sort: { type: Number },

    displaySpecs: String, // Ex: "100-yd, A++, Code 117"
    sku: { type: String, required: true, unique: true },

    // === OTHER FIELDS ===
    stock: { type: Number, required: true, default: 0 },
    moq: { type: Number, required: true, default: 1 },
    isAvailable: { type: Boolean, default: true },
    origin: String,
    storageLocation: String,
    price: Number,
    unit: String,
    images: { type: [String], default: [] },
    description: String,
    quality: {
      type: String,
      enum: ["A++", "A", "B"],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Indexes for efficient queries
productSchema.index({ productType: 1 });
productSchema.index({ category: 1 });

// === AUTO-GENERATION HOOK ===
productSchema.pre("validate", async function (next) {
  const categoryModel = mongoose.model("Category");
  const categoryDoc = await categoryModel.findById(this.category).lean();
  const categoryNameRaw = categoryDoc?.name || "uncat";

  // First 2 capital letters of category name
  const categoryCode = categoryNameRaw.slice(0, 2).toUpperCase();

  if (
    this.isModified("category") ||
    this.isModified("size") ||
    this.isModified("code")
  ) {
    const sizeCode =
      this.size
        ?.toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .replace(/INCH/gi, "") || "NOSIZE";

    const productCode =
      this.code?.toUpperCase().replace(/\s+/g, "") || "NOCODE";
    const randomSuffix = Date.now().toString().slice(-4);

    this.sku = `${categoryCode}-${sizeCode}-${productCode}-${randomSuffix}`;
  }

  const splitCamelCase = (str) => str?.replace(/([a-z])([A-Z])/g, "$1-$2");

  const capitalize = (str) =>
    splitCamelCase(str)
      ?.split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join("-");

  // === Generate Name ===
  const nameParts = [
    categoryNameRaw && capitalize(categoryNameRaw),
    this.color && capitalize(this.color),
    this.size,
    this.variant, // ensure it comes right after size
    this.productType && capitalize(this.productType),
  ].filter(Boolean);

  this.name = nameParts.join(" ");

  // === Generate Display Specs ===
  // === Generate Display Specs ===
  if (
    this.productType === "Ribbon" &&
    (this.isModified("size") ||
      this.isModified("variant") ||
      this.isModified("code") ||
      this.isModified("quality") ||
      this.isModified("unit") || // also check for unit
      !this.displaySpecs)
  ) {
    const specParts = [];

    if (this.size) specParts.push(this.size);
    if (this.variant) specParts.push(this.variant);
    if (this.quality) specParts.push(this.quality);
    if (this.code) specParts.push(`#${this.code}`);
    if (this.unit) specParts.push(this.unit); // 🟣 use unit instead of "One Roll"

    this.displaySpecs = specParts.join(", ");
  }

  next();
});

const Product = mongoose.model("Product", productSchema);
export default Product;
