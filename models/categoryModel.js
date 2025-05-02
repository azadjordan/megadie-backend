import mongoose from "mongoose";

const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true, // e.g., "Satin"
    },

    displayName: {
      type: String, // ✅ Removed default: "" for cleaner conditionals
    },

    productType: {
      type: String,
      enum: ["Ribbon", "Creasing Matrix", "Double Face Tape"],
      required: true,
    },

    filters: [
      {
        Key: { type: String, required: true },            // e.g., "Color"
        displayName: { type: String, required: true },    // e.g., "Color"
        values: { type: [String], required: true },       // e.g., ["Red", "Blue"]
        order: { type: Number, default: 0 },              // ✅ Used for filter display sorting
      },
    ],

    description: {
      type: String, // ✅ Removed default: ""
    },

    position: {
      type: Number,
      default: 0,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    image: {
      type: String, // ✅ Removed default: ""
    },
  },
  { timestamps: true }
);

categorySchema.index({ productType: 1 });

const Category = mongoose.model("Category", categorySchema);
export default Category;
