import mongoose from 'mongoose';
import Catalog from '../models/catalogModel.js';
import CatalogEntry from '../models/catalogEntryModel.js';
import Category from '../models/categoryModel.js';
import Product from '../models/productModel.js';
import {performance} from 'node:perf_hooks';
import {getAvailabilityTotalsByProduct, hasSellableStock} from '../utils/quoteAvailability.js';
import { PRODUCT_TYPES } from '../constants.js';
import asyncHandler from '../middleware/asyncHandler.js';

const ENTRY_FIELDS = '_id category code label imageUrl page position';
const fail = (res, status, message) => { res.status(status); throw new Error(message); };
const scalar = (value, res, name, fallback = '') => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') fail(res, 400, `${name} must be a single string.`);
  return value.trim();
};
const id = (value, res) => {
  if (!mongoose.isObjectIdOrHexString(value)) fail(res, 400, 'Invalid catalog or entry ID.');
  return value;
};
const exposeCatalog = catalog => ({
  _id: catalog._id, name: catalog.name, productType: catalog.productType, layout: catalog.layout,
});
const selectionFilters = (catalog, category, entry) =>
  catalog.productType === 'Ribbon' && catalog.layout === 'color-grid'
    ? {productType:'Ribbon', categoryKeys:category.key, catalogCode:entry.code}
    : null;

async function loadCatalog(req, res) {
  const catalog = await Catalog.findOne({ _id: id(req.params.catalogId, res), isActive:true }).lean();
  if (!catalog) fail(res, 404, 'Catalog not found.');
  return catalog;
}

async function materialsFor(catalog) {
  const categoryIds = await CatalogEntry.distinct('category', { catalog: catalog._id, isActive:true });
  return Category.find({ _id: { $in: categoryIds }, productType: catalog.productType, isActive: true })
    .select('_id key label').sort({ sort: 1, key: 1 }).lean();
}

export const getCatalog = asyncHandler(async (req, res) => {
  const productType = scalar(req.query.productType, res, 'productType');
  if (!PRODUCT_TYPES.includes(productType)) fail(res, 400, 'A valid productType is required.');
  const catalog = await Catalog.findOne({ productType, isActive:true }).lean();
  // Absence is a normal shop state: this product type opens product results.
  if (!catalog) return res.json({ success: true, data: null });
  res.json({ success: true, data: { ...exposeCatalog(catalog), materials: await materialsFor(catalog) } });
});

export const getCatalogEntries = asyncHandler(async (req, res) => {
  const material = scalar(req.query.material, res, 'material');
  const q = scalar(req.query.q, res, 'q');
  const pageValue = scalar(req.query.page, res, 'page', '1');
  if (!/^[1-9]\d*$/.test(pageValue) || !Number.isSafeInteger(Number(pageValue)) || !Number.isSafeInteger((Number(pageValue)-1)*49)) fail(res, 400, 'page must be a positive integer.');
  if (q.length > 100) fail(res, 400, 'Search must be at most 100 characters.');
  const page = Number(pageValue);
  const catalog = await loadCatalog(req, res);
  const materials = await materialsFor(catalog);
  const category = materials.find(c => c.key === material);
  if (!category) fail(res, 400, 'Choose a valid catalog material.');
  const filter = { catalog: catalog._id, category: category._id, isActive:true };
  const mode = q ? 'search' : 'browse';
  if (q) {
    // Treat user input literally, never as executable regex syntax.
    const literal = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [{code: {$regex: literal, $options: 'i'}}, {label: {$regex: literal, $options: 'i'}}];
  }
  const [total, savedPages] = await Promise.all([
    CatalogEntry.countDocuments(filter),
    q ? Promise.resolve([]) : CatalogEntry.distinct('page', filter),
  ]);
  savedPages.sort((a,b) => a-b);
  // Browse honors saved physical pages, including gaps caused by hidden entries.
  // Search combines matches from all saved pages and paginates those results.
  const limit = 49;
  const pages = q ? Array.from({length: Math.ceil(total/limit)}, (_,i) => i+1) : savedPages;
  const query = CatalogEntry.find(q ? filter : {...filter, page})
    .select(ENTRY_FIELDS).sort({page:1, position:1, _id:1});
  const data = await (q ? query.skip((page-1)*limit).limit(limit) : query).lean();
  res.json({success:true, mode, material:category, pagination:{page, limit:q?limit:null, total, pages, totalPages:pages.length,
    hasPrev:pages.some(p=>p<page), hasNext:pages.some(p=>p>page)},
    data:data.map(entry => ({...entry, filters:selectionFilters(catalog, category, entry)}))});
});

export const getCatalogEntry = asyncHandler(async (req, res) => {
  const entryId = id(req.params.entryId, res);
  const catalog = await loadCatalog(req, res);
  const entry = await CatalogEntry.findOne({_id:entryId, catalog:catalog._id, isActive:true}).select(ENTRY_FIELDS).lean();
  if (!entry) fail(res, 404, 'Catalog entry not found.');
  const category = await Category.findOne({_id:entry.category, productType:catalog.productType, isActive:true}).select('_id key label').lean();
  if (!category) fail(res, 404, 'Catalog entry not found.');
  // Explicit mapping for the initial Ribbon catalog. No arbitrary stored query.
  const filters = selectionFilters(catalog, category, entry);
  if (!filters) fail(res, 422, 'Catalog product selection is not supported yet.');
  res.json({success:true, data:{...entry, material:category, filters}});
});

export const getCatalogAvailability = asyncHandler(async (req, res) => {
  const startedAt = performance.now();
  const requested = req.body?.entryIds;
  if (!Array.isArray(requested) || requested.length > 49 ||
      requested.some(value => typeof value !== 'string' || !mongoose.isObjectIdOrHexString(value))) {
    fail(res, 400, 'entryIds must contain at most 49 valid catalog entry IDs.');
  }
  const catalog = await loadCatalog(req, res);
  if (catalog.productType !== 'Ribbon' || catalog.layout !== 'color-grid') {
    fail(res, 422, 'Catalog availability is not supported for this layout.');
  }
  const entryIds = [...new Set(requested)];
  const entries = entryIds.length ? await CatalogEntry.find({
    _id:{$in:entryIds}, catalog:catalog._id, isActive:true,
  }).select('_id category code').lean() : [];
  const categories = entries.length ? await Category.find({
    _id:{$in:[...new Set(entries.map(entry => String(entry.category)))]},
    productType:catalog.productType, isActive:true,
  }).select('_id').lean() : [];
  const categoryIds = new Set(categories.map(category => String(category._id)));
  // Omit hidden/missing entries alike. One hidden entry does not prevent the
  // rest of a visible page from receiving stock indicators.
  const visible = entries.filter(entry => categoryIds.has(String(entry.category)));
  const products = visible.length ? await Product.find({
    productType:catalog.productType, isActive:true, isAvailable:{$ne:false},
    $or:visible.map(entry => ({category:entry.category, catalogCode:entry.code})),
  }).select('_id category catalogCode moq isActive isAvailable').lean() : [];
  const totals = await getAvailabilityTotalsByProduct(products.map(product => product._id));
  const stocked = new Set();
  const withStock = new Set();
  for (const product of products) {
    const available = totals.get(String(product._id)) || 0;
    const key = `${product.category}:${product.catalogCode}`;
    if (available > 0) withStock.add(key);
    if (hasSellableStock(product, available)) stocked.add(key);
  }
  res.set('Server-Timing', `availability;dur=${(performance.now() - startedAt).toFixed(1)}`);
  res.json({success:true, checkedAt:new Date(), data:visible.map(entry => ({
    entryId:entry._id, inStock:stocked.has(`${entry.category}:${entry.code}`),
    noStock:!withStock.has(`${entry.category}:${entry.code}`),
  }))});
});
