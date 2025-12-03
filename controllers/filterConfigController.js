// controllers/filterConfigController.js
import asyncHandler from "../middleware/asyncHandler.js";
import FilterConfig from "../models/filterConfigModel.js";

/* =========================
   Helpers (sanitize/validate)
   ========================= */

const toStringTrim = (v) => (typeof v === "string" ? v.trim() : v);

/** Normalize one field entry */
function normalizeField(raw = {}) {
  // normalize key as lowercase for consistent uniqueness & lookups
  const keyRaw = toStringTrim(raw.key);
  const key = typeof keyRaw === "string" ? keyRaw.toLowerCase() : keyRaw;

  const label = toStringTrim(raw.label);
  const type = toStringTrim(raw.type);
  const ui = toStringTrim(raw.ui);

  // stricter allowedValues handling:
  // - drop null/undefined
  // - trim
  // - drop empty strings
  // - keep first occurrence order (via Set)
  const allowedValues = Array.isArray(raw.allowedValues)
    ? Array.from(
        new Set(
          raw.allowedValues
            .filter((v) => v !== null && v !== undefined)
            .map((x) => String(x).trim())
            .filter((s) => s.length > 0)
        )
      )
    : [];

  return {
    key,
    label,
    type,
    allowedValues,
    multi: typeof raw.multi === "boolean" ? raw.multi : true,
    ui: ui || "chips",
    sort:
      typeof raw.sort === "number" && Number.isFinite(raw.sort)
        ? raw.sort
        : 0,
  };
}

/** Normalize the whole fields array and ensure unique keys */
function normalizeAndValidateFields(fields) {
  if (!Array.isArray(fields)) {
    const err = new Error("`fields` must be an array.");
    err.statusCode = 400;
    throw err;
  }

  const normalized = fields.map(normalizeField);

  // Validate required properties
  for (const f of normalized) {
    if (!f.key || !f.label || !f.type) {
      const missing = [
        !f.key ? "key" : null,
        !f.label ? "label" : null,
        !f.type ? "type" : null,
      ]
        .filter(Boolean)
        .join(", ");
      const err = new Error(`Each field requires: ${missing}`);
      err.statusCode = 400;
      throw err;
    }
  }

  // Ensure unique keys (now case-insensitive because we lowered them)
  const keyCounts = normalized.reduce((acc, f) => {
    acc[f.key] = (acc[f.key] || 0) + 1;
    return acc;
  }, {});
  const dupKeys = Object.keys(keyCounts).filter((k) => keyCounts[k] > 1);
  if (dupKeys.length) {
    const err = new Error(
      `Duplicate field keys not allowed: ${dupKeys.join(", ")}`
    );
    err.statusCode = 400;
    throw err;
  }

  // Optional: sort fields by "sort" then "label" for consistency
  normalized.sort((a, b) => {
    if (a.sort !== b.sort) return a.sort - b.sort;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });

  return normalized;
}

/* =========================
   GET /api/filter-configs
   Public
   Returns all filter configurations (sorted)
   ========================= */
export const getFilterConfigs = asyncHandler(async (_req, res) => {
  const configs = await FilterConfig.find({}).sort({ productType: 1 }).lean();

  res.status(200).json({
    success: true,
    message: "Filter configurations retrieved successfully.",
    total: configs.length,
    data: configs,
  });
});

/* =========================
   GET /api/filter-configs/:productType
   Public
   Returns a single filter configuration by product type
   ========================= */
export const getFilterConfig = asyncHandler(async (req, res) => {
  const { productType } = req.params;

  const config = await FilterConfig.findOne({ productType }).lean();

  if (!config) {
    res.status(404);
    throw new Error(`Filter configuration not found for "${productType}".`);
  }

  res.status(200).json({
    success: true,
    message: "Filter configuration retrieved successfully.",
    data: config,
  });
});

/* =========================
   POST /api/filter-configs/:productType
   Private/Admin
   Body: { fields: Array<FilterField> }
   Creates a new filter configuration for a product type
   ========================= */
export const createFilterConfig = asyncHandler(async (req, res) => {
  const { productType } = req.params;
  const { fields = [] } = req.body || {};

  const existing = await FilterConfig.findOne({ productType });
  if (existing) {
    res.status(409);
    throw new Error(
      `Filter configuration for "${productType}" already exists.`
    );
  }

  const normalizedFields = normalizeAndValidateFields(fields);

  const doc = await FilterConfig.create({
    productType,
    fields: normalizedFields,
  });

  // Nice REST touch
  res.setHeader(
    "Location",
    `/api/filter-configs/${encodeURIComponent(productType)}`
  );

  res.status(201).json({
    success: true,
    message: `Filter configuration for "${productType}" created successfully.`,
    data: doc,
  });
});

/* =========================
   PUT /api/filter-configs/:productType
   Private/Admin
   Body: { fields: Array<FilterField> }
   Replaces the fields array for an existing configuration
   ========================= */
export const updateFilterConfig = asyncHandler(async (req, res) => {
  const { productType } = req.params;
  const { fields } = req.body || {};

  const config = await FilterConfig.findOne({ productType });
  if (!config) {
    res.status(404);
    throw new Error(`Filter configuration not found for "${productType}".`);
  }

  const changes = {};
  if (typeof fields !== "undefined") {
    const normalizedFields = normalizeAndValidateFields(fields);

    // produce a tiny diff summary (length + keys changed) to keep payload small
    const beforeKeys = new Set((config.fields || []).map((f) => f.key));
    const afterKeys = new Set(normalizedFields.map((f) => f.key));

    const added = [...afterKeys].filter((k) => !beforeKeys.has(k));
    const removed = [...beforeKeys].filter((k) => !afterKeys.has(k));

    if (
      added.length ||
      removed.length ||
      (config.fields?.length || 0) !== normalizedFields.length
    ) {
      changes.fields = {
        fromLength: config.fields?.length || 0,
        toLength: normalizedFields.length,
        addedKeys: added,
        removedKeys: removed,
      };
    }

    config.fields = normalizedFields;
  }

  const updated = await config.save();

  const changedKeys = Object.keys(changes);
  const message = changedKeys.length
    ? `Filter configuration updated successfully (${changedKeys.join(", ")}).`
    : "Filter configuration saved (no changes detected).";

  res.status(200).json({
    success: true,
    message,
    changed: changes,
    data: updated,
  });
});

/* =========================
   DELETE /api/filter-configs/:productType
   Private/Admin
   Deletes a specific filter configuration
   ========================= */
export const deleteFilterConfig = asyncHandler(async (req, res) => {
  const { productType } = req.params;

  const config = await FilterConfig.findOne({ productType });
  if (!config) {
    res.status(404);
    throw new Error(`Filter configuration not found for "${productType}".`);
  }

  await config.deleteOne();

  res.status(200).json({
    success: true,
    message: `Filter configuration for "${productType}" deleted successfully.`,
    productType,
    configId: config._id,
  });
});
