// Preview: node operations/clear-ae1-ribbon-stock.mjs
// Apply exactly that preview: node operations/clear-ae1-ribbon-stock.mjs --apply <fingerprint>
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

dotenv.config({ quiet: true });
const units = 'DEFGHIJKLMNOPQR'.split('');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--apply')) {
  throw new Error('Usage: clear-ae1-ribbon-stock.mjs [--apply preview-fingerprint]');
}
const apply = args[0] === '--apply';
const hash = value => crypto.createHash('sha256')
  .update(mongoose.mongo.BSON.serialize({ value })).digest('hex');
const key = value => String(value);
const requireCondition = (ok, message) => { if (!ok) throw new Error(message); };

async function readState(db, session) {
  const options = session ? { session } : {};
  const read = name => db.collection(name).find({}, options).sort({ _id: 1 }).toArray();
  // Sequential reads also support MongoDB transactions.
  const products = await read('products');
  const slots = await read('slots');
  const stock = await read('slotitems');
  const allocations = await read('orderallocations');
  const productIds = new Set(products.filter(p => p.productType === 'Ribbon').map(p => key(p._id)));
  const slotIds = new Set(slots.filter(s => s.store === 'AE1' && units.includes(s.unit)).map(s => key(s._id)));
  const targets = stock.filter(r => productIds.has(key(r.product)) && slotIds.has(key(r.slot)));
  const reserved = allocations.filter(r => productIds.has(key(r.product)) && slotIds.has(key(r.slot))
    && (r.status === 'Reserved' || r.status == null));
  const fingerprint = hash({ products, slots, stock, allocations });
  return { products, slots, stock, allocations, targets, reserved, fingerprint };
}

let connection;
try {
  connection = await mongoose.createConnection(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 }).asPromise();
  const db = connection.db;
  requireCondition(db.databaseName === 'production-db', 'Unexpected database; refusing operation.');
  const before = await readState(db);
  const summary = {
    database: db.databaseName, store: 'AE1', productType: 'Ribbon', shelves: units,
    preserved: ['A', 'B', 'C', 'FLOOR'], rows: before.targets.length,
    quantity: before.targets.reduce((n, r) => n + r.qty, 0),
    reservations: before.reserved.length, fingerprint: before.fingerprint,
  };
  console.log(JSON.stringify(summary, null, 2));
  requireCondition(before.reserved.length === 0, 'Reserved stock found; no changes applied.');
  for (const row of before.targets) {
    requireCondition(Number.isInteger(row.qty) && row.qty >= 0
      && Number.isFinite(row.cbm) && row.cbm >= 0, 'Invalid target quantity or CBM.');
  }
  if (!apply) {
    console.log('Preview only. No changes made.');
  } else {
    requireCondition(args[1] === before.fingerprint, 'Data changed since preview; generate a new preview.');
    requireCondition(before.targets.length > 0, 'Nothing to clear.');
    const operationId = 'ae1-ribbon-reset-' + new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(os.homedir(), 'Backups', 'megadie', operationId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const save = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2), { mode: 0o600 });
    save('before.json', { operationId, summary, ...before });
    const targetIds = new Set(before.targets.map(r => key(r._id)));
    const affectedSlotIds = new Set(before.targets.map(r => key(r.slot)));
    const protectedStock = before.stock.filter(r => !targetIds.has(key(r._id)));
    const protectedSlots = before.slots.filter(s => !affectedSlotIds.has(key(s._id)));
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        const current = await readState(db, session);
        requireCondition(current.fingerprint === before.fingerprint, 'Concurrent change detected; transaction aborted.');
        requireCondition(current.reserved.length === 0, 'Reservation detected; transaction aborted.');
        const now = new Date();
        const movements = before.targets.filter(r => r.qty > 0).map(r => ({
          _id: new mongoose.Types.ObjectId(), type: 'ADJUST_OUT', product: r.product,
          slot: r.slot, qty: r.qty, cbm: r.cbm, unitCbm: r.cbm / r.qty,
          actor: null, note: 'AE1 Ribbon stock reset before manual physical-count entry; preserve A/B/C/FLOOR.',
          meta: { operationId, correction: true, previousQty: r.qty, actualQty: 0, deltaQty: -r.qty, reservedQty: 0, source: 'maintenance-script' },
          eventAt: now, createdAt: now, updatedAt: now,
        }));
        if (movements.length) await db.collection('inventorymovements').insertMany(movements, { session });
        const result = await db.collection('slotitems').deleteMany({ _id: { $in: before.targets.map(r => r._id) } }, { session });
        requireCondition(result.deletedCount === before.targets.length, 'Unexpected cleared row count.');
        const updates = before.slots.filter(s => affectedSlotIds.has(key(s._id))).map(s => {
          const occupiedCbm = protectedStock.filter(r => key(r.slot) === key(s._id)).reduce((n, r) => n + r.cbm, 0);
          requireCondition(Number.isFinite(occupiedCbm) && occupiedCbm >= 0, 'Invalid remaining occupancy.');
          const fillPercent = s.cbm > 0 ? occupiedCbm / s.cbm * 100 : 0;
          return { updateOne: { filter: { _id: s._id }, update: { $set: { occupiedCbm, fillPercent, updatedAt: now } } } };
        });
        await db.collection('slots').bulkWrite(updates, { session });
        const after = await readState(db, session);
        requireCondition(after.targets.length === 0, 'Targeted ribbon stock remains.');
        requireCondition(hash(after.stock) === hash(protectedStock), 'Protected stock mismatch.');
        requireCondition(hash(after.products) === hash(before.products), 'Product definitions changed.');
        requireCondition(hash(after.allocations) === hash(before.allocations), 'Allocations changed.');
        requireCondition(hash(after.slots.filter(s => !affectedSlotIds.has(key(s._id)))) === hash(protectedSlots), 'Protected shelves changed.');
        for (const slot of after.slots.filter(s => affectedSlotIds.has(key(s._id)))) {
          const old = before.slots.find(s => key(s._id) === key(slot._id));
          const definition = s => Object.fromEntries(Object.entries(s).filter(([k]) => !['occupiedCbm', 'fillPercent', 'updatedAt'].includes(k)));
          requireCondition(hash(definition(slot)) === hash(definition(old)), 'Shelf definition changed.');
        }
        requireCondition(await db.collection('inventorymovements').countDocuments({ 'meta.operationId': operationId }, { session }) === movements.length, 'Audit count mismatch.');
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    } finally { await session.endSession(); }
    const after = await readState(db);
    const report = {
      operationId, committed: true, ...summary, affectedSlots: affectedSlotIds.size,
      remainingTargetRows: after.targets.length,
      protectedStockMatches: hash(after.stock) === hash(protectedStock),
      productsMatch: hash(after.products) === hash(before.products),
      allocationsMatch: hash(after.allocations) === hash(before.allocations),
      protectedSlotsMatch: hash(after.slots.filter(s => !affectedSlotIds.has(key(s._id)))) === hash(protectedSlots),
      auditRows: await db.collection('inventorymovements').countDocuments({ 'meta.operationId': operationId }),
    };
    save('result.json', report);
    console.log(JSON.stringify({ ...report, reportDirectory: dir }, null, 2));
  }
} catch (error) {
  console.error('Operation failed:', String(error.message).replaceAll(process.env.MONGO_URI || '__unset__', '[REDACTED]'));
  process.exitCode = 1;
} finally { if (connection) await connection.close(); }
