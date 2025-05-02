import mongoose from "mongoose";

const productSchema = new mongoose.Schema(
  {
    // === PRIMARY FIELDS === 
    name: { type: String, required: true },
    productType: { 
      type: String, 
      enum: ["Ribbon", "Creasing Matrix", "Double Face Tape"], 
      required: true 
    },
    category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },
    size: { 
      type: String, 
      enum: ["1-inch", "0.5-inch", "0.4x1.5", "0.5x1.5", "0.5x1.6", "6mm", "9mm", "10mm", "12mm"], 
      required: true 
    },
    color: String,
    code: String,

    displaySpecs: String,
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

    // === NEW FIELDS ===
    quality: {
      type: String,
      enum: ["A++", "A+", "B"],
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
  if (this.isNew && !this.sku) {
    const typeMap = {
      Ribbon: "RIB",
      "Creasing Matrix": "CRM",
      "Double Face Tape": "TAP",
    };
    const typeCode = typeMap[this.productType] || "OTH";
    const count = await mongoose.model("Product").countDocuments({ productType: this.productType });
    const counter = String(count + 1).padStart(4, "0");
    this.sku = `${typeCode}-${counter}`;
  }

  const categoryModel = mongoose.model("Category");
  const categoryDoc = await categoryModel.findById(this.category).lean();
  const categoryName = categoryDoc ? categoryDoc.displayName : "";

  const parts = [
    this.productType,
    this.color,
    this.size,
    categoryName,
  ].filter(Boolean);
  this.name = parts.join(" ");

  next();
});

const Product = mongoose.model("Product", productSchema);
export default Product;
