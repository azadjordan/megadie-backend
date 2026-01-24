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

const toObjectMap = (value) => {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value);
  if (typeof value === "object" && !Array.isArray(value)) return value;
  return {};
};

const buildAllowedValueMeta = (field) => {
  const metaByValue = new Map();

  const upsert = (value, label, explanation) => {
    const safeValue = String(value || "").trim();
    if (!safeValue) return;
    const current = metaByValue.get(safeValue) || { value: safeValue };
    if (label) current.label = String(label);
    if (explanation) current.explanation = String(explanation);
    metaByValue.set(safeValue, current);
  };

  if (Array.isArray(field.allowedValueMeta)) {
    field.allowedValueMeta.forEach((entry) => {
      if (!entry) return;
      upsert(entry.value, entry.label, entry.explanation);
    });
  }

  const labels = toObjectMap(field.allowedValueLabels);
  const explanations = toObjectMap(field.allowedValueExplanations);
  const values = new Set([
    ...Object.keys(labels || {}),
    ...Object.keys(explanations || {}),
  ]);
  values.forEach((value) =>
    upsert(value, labels?.[value], explanations?.[value])
  );

  return Array.from(metaByValue.values());
};

const normalizeFieldsForSave = (fields = []) =>
  fields.map((field) => {
    const next = { ...field };
    if (field?.type === "enum") {
      next.allowedValueMeta = buildAllowedValueMeta(field);
    } else {
      next.allowedValueMeta = [];
    }
    delete next.allowedValueLabels;
    delete next.allowedValueExplanations;
    return next;
  });

const attachAllowedValueMaps = (config) => {
  if (!config) return config;
  const fields = Array.isArray(config.fields) ? config.fields : [];
  const hydratedFields = fields.map((field) => {
    const labels = { ...toObjectMap(field.allowedValueLabels) };
    const explanations = { ...toObjectMap(field.allowedValueExplanations) };
    const meta = Array.isArray(field.allowedValueMeta)
      ? field.allowedValueMeta
      : [];
    meta.forEach((entry) => {
      if (!entry?.value) return;
      const value = String(entry.value);
      if (entry.label) labels[value] = String(entry.label);
      if (entry.explanation) explanations[value] = String(entry.explanation);
    });
    return {
      ...field,
      allowedValueLabels: labels,
      allowedValueExplanations: explanations,
    };
  });
  return { ...config, fields: hydratedFields };
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

    if (
      typeof field.allowedValueLabels !== "undefined" &&
      (field.allowedValueLabels === null ||
        Array.isArray(field.allowedValueLabels) ||
        typeof field.allowedValueLabels !== "object")
    ) {
      throw new Error(
        `Field "${field.key}" allowedValueLabels must be an object map.`
      );
    }

    if (
      typeof field.allowedValueExplanations !== "undefined" &&
      (field.allowedValueExplanations === null ||
        Array.isArray(field.allowedValueExplanations) ||
        typeof field.allowedValueExplanations !== "object")
    ) {
      throw new Error(
        `Field "${field.key}" allowedValueExplanations must be an object map.`
      );
    }

    if (
      typeof field.allowedValueMeta !== "undefined" &&
      !Array.isArray(field.allowedValueMeta)
    ) {
      throw new Error(
        `Field "${field.key}" allowedValueMeta must be an array of { value, label, explanation }.`
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
    data: configs.map((config) => attachAllowedValueMaps(config)),
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
    data: attachAllowedValueMaps(config) || { productType, sort: 0, fields: [] },
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

  const normalizedFields = normalizeFieldsForSave(fields);

  const created = await FilterConfig.create({
    productType,
    sort: normalizeSort(sort, 0),
    fields: normalizedFields,
  });

  res.status(201).json({
    success: true,
    message: "Filter configuration created successfully.",
    data: attachAllowedValueMaps(created.toObject()),
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
    existing.fields = normalizeFieldsForSave(fields);
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
    data: attachAllowedValueMaps(updated.toObject()),
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
    data: attachAllowedValueMaps(deleted),
  });
});
