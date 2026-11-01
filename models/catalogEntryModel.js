import mongoose from "mongoose";

const positiveInteger = {
  validator: Number.isSafeInteger,
  message: "{PATH} must be a positive integer.",
};

const catalogEntrySchema = new mongoose.Schema(
  {
    catalog: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Catalog",
      required: true,
    },
    // For ribbons, Category identifies the material (Grosgrain or Satin).
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    // A string preserves leading zeros and codes such as 028B.
    code: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    imageUrl: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2048,
      validate: {
        validator(value) {
          try {
            const url = new URL(value);
            return ["http:", "https:"].includes(url.protocol) &&
              !url.username && !url.password;
          } catch {
            return false;
          }
        },
        message: "imageUrl must be an absolute HTTP or HTTPS image URL.",
      },
    },
    // Explicit placement preserves physical catalog pages, even when entries
    // are hidden. Ribbon data will use pages 1–4; other catalogs may differ.
    page: { type: Number, required: true, min: 1, validate: positiveInteger },
    position: { type: Number, required: true, min: 1, validate: positiveInteger },
    isActive: { type: Boolean, default: false },
  },
  { timestamps: true, strict: "throw", autoCreate: false, autoIndex: false }
);

catalogEntrySchema.index(
  { catalog: 1, category: 1, code: 1 },
  { unique: true }
);
catalogEntrySchema.index(
  { catalog: 1, category: 1, page: 1, position: 1 },
  { unique: true }
);

// References are not foreign-key constraints. Before publishing/importing,
// the write service must verify that Catalog and Category exist and have the
// same productType. Ribbon products match category + catalogCode === code.
// Stock and reservation totals are calculated at read time, never stored here.
const CatalogEntry = mongoose.model("CatalogEntry", catalogEntrySchema);
export default CatalogEntry;
