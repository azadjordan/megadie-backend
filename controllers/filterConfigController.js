// controllers/filterConfigController.js
import asyncHandler from "../middleware/asyncHandler.js";
import FilterConfig from "../models/filterConfigModel.js";
import {
  PRODUCT_TYPES,
  FILTER_FIELD_TYPES,
  FILTER_UI_TYPES,
} from "../constants.js";

/* =========================
   Helpers
   ========================= */

const normalizeProductType = (raw) => String(raw || "").trim();

/**
 * Validate that a given productType is one of the allowed PRODUCT_TYPES
 */
const assertValidProductType = (productType) => {
  if (!PRODUCT_TYPES.includes(productType)) {
    throw new Error(
      `Invalid productType "${productType}". Allowed: ${PRODUCT_TYPES.join(", ")}`
    );
  }
};

/**
 * Normalize sort (supports numbers or numeric strings)
 */
const normalizeSort = (raw, fallback = 0) => {
  if (typeof raw === "undefined" || raw === null) return fallback;
  const num = Number(raw);
  return Number.isFinite(num) ? num : fallback;
};

/**
 * Validate fields array (optional but keeps data clean)
 */
const validateFields = (fields) => {
  if (!Array.isArray(fields)) {
    throw new Error("fields must be an array.");
  }

  for (const field of fields) {
    if (!field.key || !field.label) {
      throw new Error("Each field must have 'key' and 'label'.");
    }

    if (!FILTER_FIELD_TYPES.includes(field.type)) {
      throw new Error(
        `Invalid field.type "${field.type}" for key "${field.key}". Allowed types: ${FILTER_FIELD_TYPES.join(
          ", "
        )}`
      );
    }

    if (field.ui && !FILTER_UI_TYPES.includes(field.ui)) {
      throw new Error(
        `Invalid field.ui "${field.ui}" for key "${field.key}". Allowed ui: ${FILTER_UI_TYPES.join(
          ", "
        )}`
      );
    }

    if (
      field.type === "enum" &&
      field.allowedValues &&
      !Array.isArray(field.allowedValues)
    ) {
      throw new Error(
        `Field "${field.key}" is enum, so allowedValues must be an array.`
      );
    }
  }
};

/* =========================
   GET /api/filter-configs
   Public
   List all filter configs
   ========================= */
export const getFilterConfigs = asyncHandler(async (_req, res) => {
  const configs = await FilterConfig.find({})
    // ✅ NEW: sort order controlled by config.sort; fallback by productType
    .sort({ sort: 1, productType: 1 })
    .lean();

  res.status(200).json({
    success: true,
    message: "Filter configurations retrieved successfully.",
    data: configs,
  });
});

/* =========================
   GET /api/filter-configs/:productType
   Public
   Get filter config for a single productType
   ========================= */
export const getFilterConfig = asyncHandler(async (req, res) => {
  const productType = normalizeProductType(req.params.productType);

  if (!productType) {
    res.status(400);
    throw new Error("productType is required.");
  }

  // Optional: enforce known product types
  if (!PRODUCT_TYPES.includes(productType)) {
    res.status(400);
    throw new Error(
      `Invalid productType "${productType}". Allowed: ${PRODUCT_TYPES.join(", ")}`
    );
  }

  const config = await FilterConfig.findOne({ productType }).lean();

  res.status(200).json({
    success: true,
    message: "Filter configuration retrieved successfully.",
    data: config || { productType, sort: 0, fields: [] },
  });
});

/* =========================
   POST /api/filter-configs/:productType
   Private/Admin
   Create filter config for a productType
   (409 if already exists)
   Body: { fields?: [...], sort?: number }
   ========================= */
export const createFilterConfig = asyncHandler(async (req, res) => {
  const productType = normalizeProductType(req.params.productType);

  if (!productType) {
    res.status(400);
    throw new Error("productType is required.");
  }

  // Validate productType
  assertValidProductType(productType);

  const existing = await FilterConfig.findOne({ productType }).lean();
  if (existing) {
    res.status(409);
    throw new Error(
      `Filter configuration already exists for productType "${productType}".`
    );
  }

  const { fields = [], sort } = req.body || {};

  // Validate fields if provided (on create we default fields to [])
  validateFields(fields);

  const created = await FilterConfig.create({
    productType,
    sort: normalizeSort(sort, 0),
    fields,
  });

  res.status(201).json({
    success: true,
    message: "Filter configuration created successfully.",
    data: created,
  });
});

/* =========================
   PUT /api/filter-configs/:productType
   Private/Admin
   Update filter config for a productType
   (404 if missing)
   Body: { fields?: [...], sort?: number }
   Notes:
   - Supports partial updates (you can update sort without sending fields)
   ========================= */
export const updateFilterConfig = asyncHandler(async (req, res) => {
  const productType = normalizeProductType(req.params.productType);

  if (!productType) {
    res.status(400);
    throw new Error("productType is required.");
  }

  assertValidProductType(productType);

  const { fields, sort } = req.body || {};

  const existing = await FilterConfig.findOne({ productType });
  if (!existing) {
    res.status(404);
    throw new Error(
      `Filter configuration not found for productType "${productType}".`
    );
  }

  const changes = [];

  // ✅ Only update fields if provided
  if (typeof fields !== "undefined") {
    validateFields(fields);
    existing.fields = fields;
    changes.push("fields");
  }

  // ✅ Only update sort if provided
  if (typeof sort !== "undefined") {
    existing.sort = normalizeSort(sort, existing.sort ?? 0);
    changes.push("sort");
  }

  if (changes.length === 0) {
    res.status(400);
    throw new Error("No updates provided. Send 'fields' and/or 'sort'.");
  }

  const updated = await existing.save();

  res.status(200).json({
    success: true,
    message: `Filter configuration updated successfully (${changes.join(", ")}).`,
    data: updated,
  });
});

/* =========================
   DELETE /api/filter-configs/:productType
   Private/Admin
   Delete filter config for a productType
   ========================= */
export const deleteFilterConfig = asyncHandler(async (req, res) => {
  const productType = normalizeProductType(req.params.productType);

  if (!productType) {
    res.status(400);
    throw new Error("productType is required.");
  }

  assertValidProductType(productType);

  const deleted = await FilterConfig.findOneAndDelete({ productType }).lean();

  if (!deleted) {
    res.status(404);
    throw new Error(
      `Filter configuration not found for productType "${productType}".`
    );
  }

  res.status(200).json({
    success: true,
    message: "Filter configuration deleted successfully.",
    data: deleted,
  });
});
