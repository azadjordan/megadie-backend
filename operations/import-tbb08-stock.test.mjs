import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import {buildPlan, movementId, parseCsv} from './import-tbb08-stock.mjs';

// The real shipment CSV stays outside Git; pure checks also run on clean checkouts.
const shipmentCsv = new URL('../../TBB08_Codex_Import_97_Rows.csv', import.meta.url);
test('the fixed CSV has 97 A+ rows, 3,667 rolls, and preserves leading zeroes', { skip: !fs.existsSync(shipmentCsv) }, () => {
  const raw = fs.readFileSync(shipmentCsv);
  const rows = parseCsv(raw);
  assert.equal(rows.length, 97);
  assert.equal(rows.reduce((sum, row) => sum + row.qty, 0), 3667);
  assert.equal(rows[0].code, '028');
  assert.ok(rows.some(row => row.code === '000'));
  assert.ok(rows.every(row => row.quality === 'A+'));
  assert.throws(() => parseCsv(Buffer.from(raw.toString().replace('028,84,A+', '028,84,'))), /Invalid CSV row/);
});

test('CSV parsing validates quantities, quality, duplicate rows and leading zeroes without shipment data', () => {
  const codes = ['028', ...Array.from({length: 97}, (_, i) => String(i).padStart(3, '0')).filter(code => code !== '028')];
  const lines = codes.map((code, i) => `K,1,grosgrain,1 inch,${code},${i === 0 ? 19 : 38},A+`);
  const csv = Buffer.from(['shelf,slot,category,size,code,qty,quality', ...lines].join('\n'));
  const rows = parseCsv(csv);
  assert.equal(rows.length, 97);
  assert.equal(rows.reduce((sum, row) => sum + row.qty, 0), 3667);
  assert.equal(rows[0].code, '028');
  assert.ok(rows.some(row => row.code === '000'));
  assert.throws(() => parseCsv(Buffer.from(csv.toString().replace('028,19,A+', '028,19,'))), /Invalid CSV row/);
  assert.throws(() => parseCsv(Buffer.from(csv.toString().replace('028,19,A+', '028,18,A+'))), /3,667/);
  assert.throws(() => parseCsv(Buffer.from(csv.toString() + '\n' + lines[0])), /Repeated product/);
});

test('preview adds to existing stock and creates only missing product-slot rows', () => {
  const rows = [
    {sourceLine: 2, shelf: 'K', slot: 1, category: 'grosgrain', size: '1 inch', code: '000', qty: 10, quality: 'A+'},
    {sourceLine: 3, shelf: 'K', slot: 1, category: 'grosgrain', size: '1 inch', code: '007', qty: 8, quality: 'A+'},
  ];
  const state = {
    existingShipmentMovements: 0, uniqueSlotItemIndex: true,
    categories: [{_id: 'category', productType: 'Ribbon', key: 'grosgrain', isActive: true}],
    products: [
      {_id: 'p000', productType: 'Ribbon', category: 'category', catalogCode: '000', size: '1 inch', grade: 'A+', packingUnit: '100yd Roll', cbm: 0.0001, sku: 'RIB-000'},
      {_id: 'p007', productType: 'Ribbon', category: 'category', catalogCode: '007', size: '1 inch', grade: 'A+', packingUnit: '100yd Roll', cbm: 0.0001, sku: 'RIB-007'},
    ],
    slots: [{_id: 'slot', store: 'AE1', unit: 'K', position: 1, label: 'K1-AE1', cbm: 0.01, occupiedCbm: 0.0005}],
    slotItems: [{_id: 'item', product: 'p000', slot: 'slot', qty: 5, cbm: 0.0005}],
    allocations: [],
  };
  const plan = buildPlan(rows, 'csv-hash', state);
  assert.deepEqual(plan.entries.map(e => [e.code, e.action, e.currentQty, e.addQty, e.resultQty]), [
    ['000', 'increase', 5, 10, 15], ['007', 'create', 0, 8, 8],
  ]);
  assert.equal(plan.addQty, 18);
  assert.equal(plan.createSlotItems, 1);
  assert.equal(plan.increaseSlotItems, 1);
  assert.equal(plan.slotPlans[0].resultCbm, 0.0023);
  assert.throws(() => buildPlan(rows, 'csv-hash', {...state, existingShipmentMovements: 1}), /already has inventory movements/);
  assert.throws(() => buildPlan(rows, 'csv-hash', {...state, allocations: [{product: 'p000', slot: 'slot'}]}), /unresolved reservation/);
});

test('movement IDs are fixed for the shipment and source line', () => {
  assert.equal(String(movementId(2)), String(movementId(2)));
  assert.notEqual(String(movementId(2)), String(movementId(3)));
});
