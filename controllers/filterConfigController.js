// controllers/filterConfigController.js
import asyncHandler from "../middleware/asyncHandler.js";
import FilterConfig from "../models/filterConfigModel.js";

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
 */
export const createFilterConfig = asyncHandler(async (req, res) => {
  const { productType } = req.params;
  const { fields = [] } = req.body;

  const existingConfig = await FilterConfig.findOne({ productType });

  if (existingConfig) {
    res.status(409);
    throw new Error(`Filter configuration for "${productType}" already exists`);
  }

  const newConfig = await FilterConfig.create({ productType, fields });
  res.status(201).json(newConfig);
});

/**
 * @desc    Update existing filter configuration
 * @route   PUT /api/filter-configs/:productType
 * @access  Admin
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
    config.fields = Array.isArray(fields) ? fields : [];
  }

  const updatedConfig = await config.save();
  res.status(200).json(updatedConfig);
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
