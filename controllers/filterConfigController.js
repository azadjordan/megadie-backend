// controllers/filterConfigController.js
import asyncHandler from "../middleware/asyncHandler.js";
import FilterConfig from "../models/filterConfigModel.js";

/* =========================
   Helpers (sanitize/validate)
   ========================= */

const toStringTrim = (v) => (typeof v === "string" ? v.trim() : v);

/** Normalize one field entry */
function normalizeField(raw) {
  const key = toStringTrim(raw.key);
  const label = toStringTrim(raw.label);
  const type = toStringTrim(raw.type);
  const ui = toStringTrim(raw.ui);

  const allowedValues = Array.isArray(raw.allowedValues)
    ? Array.from(
        new Set(
          raw.allowedValues
            .map((x) => String(x))
            .map((s) => s.trim())
            .filter(Boolean)
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
  if (!Array.isArray(fields)) return [];

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
      const msg = `Each field requires: ${missing}`;
      const err = new Error(msg);
      err.statusCode = 400;
      throw err;
    }
  }

  // Ensure unique keys
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
   Controllers
   ========================= */

/**
 * @desc    Get all filter configurations
 * @route   GET /api/filter-configs
 * @access  Public
 */
export const getFilterConfigs = asyncHandler(async (req, res) => {
  const configs = await FilterConfig.find({}).sort({ productType: 1 });
  res.status(200).json(configs);
});

/**
 * @desc    Get filter configuration by product type
 * @route   GET /api/filter-configs/:productType
 * @access  Public
 */
export const getFilterConfig = asyncHandler(async (req, res) => {
  const { productType } = req.params;

  const config = await FilterConfig.findOne({ productType });

  if (!config) {
    res.status(404);
    throw new Error(`Filter configuration not found for "${productType}"`);
  }

  res.status(200).json(config);
});

/**
 * @desc    Create new filter configuration
 * @route   POST /api/filter-configs/:productType
 * @access  Admin
 * @body    { fields: Array<FilterField> }
 */
export const createFilterConfig = asyncHandler(async (req, res) => {
  const { productType } = req.params;
  const { fields = [] } = req.body;

  const existing = await FilterConfig.findOne({ productType });
  if (existing) {
    res.status(409);
    throw new Error(`Filter configuration for "${productType}" already exists`);
  }

  const normalizedFields = normalizeAndValidateFields(fields);

  const doc = await FilterConfig.create({
    productType,
    fields: normalizedFields,
  });

  res.status(201).json(doc);
});

/**
 * @desc    Update existing filter configuration (replace fields array)
 * @route   PUT /api/filter-configs/:productType
 * @access  Admin
 * @body    { fields: Array<FilterField> }
 */
export const updateFilterConfig = asyncHandler(async (req, res) => {
  const { productType } = req.params;
  const { fields } = req.body;

  const config = await FilterConfig.findOne({ productType });
  if (!config) {
    res.status(404);
    throw new Error(`Filter configuration not found for "${productType}"`);
  }

  if (typeof fields !== "undefined") {
    const normalizedFields = normalizeAndValidateFields(fields);
    config.fields = normalizedFields;
  }

  const updated = await config.save();
  res.status(200).json(updated);
});

/**
 * @desc    Delete filter configuration
 * @route   DELETE /api/filter-configs/:productType
 * @access  Admin
 */
export const deleteFilterConfig = asyncHandler(async (req, res) => {
  const { productType } = req.params;

  const config = await FilterConfig.findOne({ productType });
  if (!config) {
    res.status(404);
    throw new Error(`Filter configuration not found for "${productType}"`);
  }

  await config.deleteOne();

  res.status(200).json({
    message: `Filter configuration for "${productType}" deleted successfully`,
  });
});
