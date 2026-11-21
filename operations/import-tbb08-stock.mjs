// TBB08 receipt. Default is a read-only preview; --apply is deliberately explicit.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

const SHIPMENT = 'TBB08';
const CSV = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../TBB08_Codex_Import_97_Rows.csv');
const HEADERS = 'shelf,slot,category,size,code,qty,quality';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const id = value => String(value);
const fail = message => { throw Error(message); };

export function parseCsv(raw) {
  const lines = raw.toString('utf8').replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
  if (lines.shift() !== HEADERS) fail('Unexpected CSV headers');
  const seen = new Set();
  const rows = lines.map((line, index) => {
    const [shelf, slotText, category, size, code, qtyText, quality, extra] = line.split(',');
    const slot = Number(slotText), qty = Number(qtyText), sourceLine = index + 2;
    if (extra !== undefined || !/^[A-R]$/.test(shelf) || !/^(?:[1-9]|1[0-6])$/.test(slotText) ||
        !['grosgrain', 'satin'].includes(category) || !['1/2 inch', '3/4 inch', '1 inch'].includes(size) ||
        !/^\d{3}$/.test(code) || !/^[1-9]\d*$/.test(qtyText) || !Number.isSafeInteger(qty) || quality !== 'A+') {
      fail(`Invalid CSV row at line ${sourceLine}`);
    }
    const key = [shelf, slot, category, size, code, quality].join('|');
    if (seen.has(key)) fail(`Repeated product and slot at line ${sourceLine}`);
    seen.add(key);
    return {sourceLine, shelf, slot, category, size, code, qty, quality};
  });
  if (rows.length !== 97 || rows.reduce((sum, row) => sum + row.qty, 0) !== 3667) {
    fail('TBB08 must contain exactly 97 rows and 3,667 rolls');
  }
  return rows;
}

export function movementId(sourceLine) {
  // Stable across CSV edits and retries; MongoDB's unique _id rejects a second receipt.
  return new mongoose.Types.ObjectId(hash(`${SHIPMENT}:movement:${sourceLine}`).slice(0, 24));
}

export function buildPlan(rows, csvHash, state) {
  if (state.existingShipmentMovements) fail(`${SHIPMENT} already has inventory movements; refusing to import again`);
  if (!state.uniqueSlotItemIndex) fail('Unique product/slot index is missing');
  const entries = [], perSlot = new Map();
  const seen = new Set();
  for (const row of rows) {
    const categories = state.categories.filter(c => c.productType === 'Ribbon' && c.key === row.category && c.isActive !== false);
    if (categories.length !== 1) fail(`Line ${row.sourceLine}: missing or ambiguous Ribbon category`);
    const products = state.products.filter(p => p.productType === 'Ribbon' && id(p.category) === id(categories[0]._id) &&
      p.catalogCode === row.code && p.size === row.size && p.grade === 'A+' && p.packingUnit === '100yd Roll' &&
      !p.variant && (row.category === 'satin' ? p.finish === 'Single Face' : !p.finish));
    if (products.length !== 1) fail(`Line ${row.sourceLine}: expected one existing product, found ${products.length}`);
    const product = products[0];
    if (product.isActive === false || product.isAvailable === false || !Number.isFinite(product.cbm) || product.cbm <= 0) {
      fail(`Line ${row.sourceLine}: product inactive, unavailable, or has invalid CBM`);
    }
    const slots = state.slots.filter(s => s.store === 'AE1' && s.unit === row.shelf && s.position === row.slot);
    if (slots.length !== 1 || slots[0].isActive === false) fail(`Line ${row.sourceLine}: missing, ambiguous, or inactive AE1 slot`);
    const slot = slots[0], key = `${id(product._id)}|${id(slot._id)}`;
    if (seen.has(key)) fail(`Line ${row.sourceLine}: repeated product and slot`);
    seen.add(key);
    if (state.allocations.some(a => id(a.product) === id(product._id) && id(a.slot) === id(slot._id))) {
      fail(`Line ${row.sourceLine}: unresolved reservation in ${slot.label}`);
    }
    const matches = state.slotItems.filter(i => id(i.product) === id(product._id) && id(i.slot) === id(slot._id));
    if (matches.length > 1) fail(`Line ${row.sourceLine}: duplicate stock records`);
    const current = matches[0], currentQty = current?.qty ?? 0;
    if (!Number.isSafeInteger(currentQty) || currentQty < 0 || !Number.isSafeInteger(currentQty + row.qty) ||
        current && Math.abs(current.cbm - currentQty * product.cbm) > 1e-8) {
      fail(`Line ${row.sourceLine}: invalid existing stock quantity or CBM`);
    }
    const entry = {sourceLine: row.sourceLine, category: row.category, code: row.code, size: row.size,
      sku: product.sku, slot: slot.label, addQty: row.qty, currentQty, resultQty: currentQty + row.qty,
      action: current ? 'increase' : 'create', productId: id(product._id), slotId: id(slot._id),
      itemId: current ? id(current._id) : null, currentCbm: current?.cbm ?? 0, unitCbm: product.cbm};
    entries.push(entry);
    if (!perSlot.has(entry.slotId)) perSlot.set(entry.slotId, {slot, addCbm: 0, addQty: 0});
    perSlot.get(entry.slotId).addCbm += row.qty * product.cbm;
    perSlot.get(entry.slotId).addQty += row.qty;
  }
  const slotPlans = [...perSlot.values()].map(({slot, addCbm, addQty}) => {
    const items = state.slotItems.filter(i => id(i.slot) === id(slot._id));
    if (items.some(i => !Number.isFinite(i.cbm) || i.cbm < 0 || !Number.isSafeInteger(i.qty) || i.qty < 0)) {
      fail(`Invalid stock in ${slot.label}`);
    }
    const calculated = items.reduce((sum, i) => sum + i.cbm, 0);
    if (!Number.isFinite(slot.cbm) || slot.cbm <= 0 || !Number.isFinite(slot.occupiedCbm) ||
        Math.abs(calculated - slot.occupiedCbm) > 1e-8) fail(`Stored occupancy differs from stock in ${slot.label}`);
    const resultCbm = slot.occupiedCbm + addCbm;
    return {slotId: id(slot._id), slot: slot.label, capacityCbm: slot.cbm,
      currentCbm: slot.occupiedCbm, addCbm, resultCbm, addQty,
      fillPercent: resultCbm / slot.cbm * 100};
  }).sort((a, b) => a.slot.localeCompare(b.slot, undefined, {numeric: true}));
  const previewHash = hash(JSON.stringify({shipment: SHIPMENT, csvHash, entries, slotPlans}));
  return {shipment: SHIPMENT, mode: 'dry-run', readOnly: true, csvHash, previewHash, rows: entries.length,
    addQty: entries.reduce((sum, e) => sum + e.addQty, 0), affectedSlots: slotPlans.length,
    createSlotItems: entries.filter(e => e.action === 'create').length,
    increaseSlotItems: entries.filter(e => e.action === 'increase').length,
    overCapacity: slotPlans.filter(s => s.fillPercent > 100 + 1e-7).map(s => ({slot: s.slot, fillPercent: Number(s.fillPercent.toFixed(1))})),
    entries, slotPlans};
}

async function readState(db, session, uniqueSlotItemIndex, rows) {
  const categories = await db.collection('categories').find({productType: 'Ribbon'}, {session}).toArray();
  const products = await db.collection('products').find({productType: 'Ribbon'}, {session}).toArray();
  const slots = await db.collection('slots').find({store: 'AE1'}, {session}).toArray();
  const affected = slots.filter(s => s.store === 'AE1');
  const slotIds = affected.map(s => s._id);
  const slotItems = await db.collection('slotitems').find({slot: {$in: slotIds}}, {session}).toArray();
  const allocations = await db.collection('orderallocations').find({slot: {$in: slotIds}, $or: [{status: 'Reserved'}, {status: null}]}, {session}).toArray();
  const existingShipmentMovements = await db.collection('inventorymovements').countDocuments({$or: [
    {'meta.shipmentId': SHIPMENT}, {'meta.batchId': SHIPMENT},
    {_id: {$in: rows.map(row => movementId(row.sourceLine))}},
  ]}, {session});
  return {categories, products, slots, slotItems, allocations, existingShipmentMovements, uniqueSlotItemIndex};
}

async function main() {
  const args = process.argv.slice(2), apply = args.includes('--apply');
  const expectedCsv = args.find(a => a.startsWith('--expect-csv='))?.slice(13);
  const expectedPreview = args.find(a => a.startsWith('--expect-preview='))?.slice(17);
  if (args.some(a => !['--apply'].includes(a) && !/^--expect-(csv|preview)=[a-f0-9]{64}$/.test(a)) ||
      (apply && (args.length !== 3 || args.filter(a => a.startsWith('--expect-csv=')).length !== 1 ||
        args.filter(a => a.startsWith('--expect-preview=')).length !== 1)) ||
      (apply && (!expectedCsv || !expectedPreview)) || (!apply && args.length)) {
    fail('Usage: node operations/import-tbb08-stock.mjs [--apply --expect-csv=SHA256 --expect-preview=SHA256]');
  }
  const raw = await fs.readFile(CSV), rows = parseCsv(raw), csvHash = hash(raw);
  if (apply && expectedCsv !== csvHash) fail('CSV changed since approval');
  dotenv.config({path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env'), quiet: true});
  await mongoose.connect(process.env.MONGO_URI, {autoIndex: false, autoCreate: false});
  try {
    const db = mongoose.connection.db;
    if (db.databaseName !== 'production-db') fail('Unexpected database');
    const indexes = await db.collection('slotitems').indexes();
    const uniqueSlotItemIndex = indexes.some(i => i.unique === true && JSON.stringify(i.key) === JSON.stringify({product: 1, slot: 1}));
    if (!apply) {
      const session = await mongoose.startSession({snapshot: true});
      try { console.log(JSON.stringify(buildPlan(rows, csvHash, await readState(db, session, uniqueSlotItemIndex, rows)), null, 2)); }
      finally { await session.endSession(); }
      return;
    }
    const session = await mongoose.startSession();
    let applied;
    try {
      await session.withTransaction(async () => {
        const plan = buildPlan(rows, csvHash, await readState(db, session, uniqueSlotItemIndex, rows));
        if (plan.previewHash !== expectedPreview) fail('Inventory changed since preview; run dry-run again');
        const now = new Date();
        const movements = plan.entries.map(e => ({_id: movementId(e.sourceLine), type: 'ADJUST_IN',
          product: new mongoose.Types.ObjectId(e.productId), slot: new mongoose.Types.ObjectId(e.slotId),
          qty: e.addQty, unitCbm: e.unitCbm, cbm: e.addQty * e.unitCbm,
          note: `${SHIPMENT} ribbon shipment`, meta: {shipmentId: SHIPMENT, csvHash, sourceLine: e.sourceLine},
          eventAt: now, createdAt: now, updatedAt: now, __v: 0}));
        await db.collection('inventorymovements').insertMany(movements, {session, ordered: true});
        for (const e of plan.entries) {
          if (e.itemId) {
            const update = await db.collection('slotitems').updateOne({_id: new mongoose.Types.ObjectId(e.itemId),
              qty: e.currentQty, cbm: e.currentCbm}, {$set: {qty: e.resultQty, cbm: e.resultQty * e.unitCbm, updatedAt: now}}, {session});
            if (update.matchedCount !== 1) fail(`Stock changed in ${e.slot}`);
          } else {
            await db.collection('slotitems').insertOne({product: new mongoose.Types.ObjectId(e.productId),
              slot: new mongoose.Types.ObjectId(e.slotId), qty: e.addQty, cbm: e.addQty * e.unitCbm,
              createdAt: now, updatedAt: now, __v: 0}, {session});
          }
        }
        for (const s of plan.slotPlans) {
          const update = await db.collection('slots').updateOne({_id: new mongoose.Types.ObjectId(s.slotId), occupiedCbm: s.currentCbm},
            {$set: {occupiedCbm: s.resultCbm, fillPercent: s.fillPercent, updatedAt: now}}, {session});
          if (update.matchedCount !== 1) fail(`Occupancy changed in ${s.slot}`);
        }
        applied = {shipment: SHIPMENT, mode: 'applied', csvHash, previewHash: plan.previewHash,
          rows: plan.rows, addedRolls: plan.addQty, affectedSlots: plan.affectedSlots,
          created: plan.createSlotItems, increased: plan.increaseSlotItems};
      }, {readConcern: {level: 'snapshot'}, writeConcern: {w: 'majority'}, readPreference: 'primary'});
    } finally { await session.endSession(); }
    console.log(JSON.stringify(applied, null, 2));
  } finally { await mongoose.disconnect(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
