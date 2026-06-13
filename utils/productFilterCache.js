import Category from "../models/categoryModel.js";
import FilterConfig from "../models/filterConfigModel.js";

const CACHE_TTL_MS = 5 * 60 * 1000;

const filterConfigCache = new Map();
const categoryIdsCache = new Map();

const isFresh = (entry) => entry && entry.expiresAt > Date.now();

const setCacheEntry = (cache, key, value) => {
  cache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return value;
};

const normalizeProductType = (productType) => String(productType || "").trim();

const normalizeKeys = (keys) =>
  Array.from(
    new Set(
      (Array.isArray(keys) ? keys : [])
        .map((key) => String(key || "").trim())
        .filter(Boolean)
    )
  ).sort();

export const getCachedFilterConfig = async (productType) => {
  const key = normalizeProductType(productType);
  if (!key) return null;

  const cached = filterConfigCache.get(key);
  if (isFresh(cached)) return cached.value;

  const config = await FilterConfig.findOne({ productType: key }).lean();
  return setCacheEntry(filterConfigCache, key, config);
};

export const getCachedCategoryIdsByKeys = async ({ productType, keys }) => {
  const cleanKeys = normalizeKeys(keys);
  if (!cleanKeys.length) return [];

  const cleanProductType = normalizeProductType(productType);
  const cacheKey = `${cleanProductType || "*"}:${cleanKeys.join("|")}`;

  const cached = categoryIdsCache.get(cacheKey);
  if (isFresh(cached)) return cached.value;

  const categories = await Category.find({
    key: { $in: cleanKeys },
    ...(cleanProductType ? { productType: cleanProductType } : {}),
  })
    .select("_id")
    .lean();

  const ids = categories.map((category) => category._id);
  return setCacheEntry(categoryIdsCache, cacheKey, ids);
};

export const clearProductFilterCache = () => {
  filterConfigCache.clear();
  categoryIdsCache.clear();
};
