import mongoose from 'mongoose';
import WorkerWork from '../models/workerWorkModel.js';
import Order from '../models/orderModel.js';
import User from '../models/userModel.js';
import Product from '../models/productModel.js';
import { ReservationError } from './orderReservations.js';
import { reservationId as id } from './orderReservationPlan.js';
import { buildCartonLabel } from './orderDelivery.js';
import { dubaiDayStart, dubaiMonthStart, workWindow, workerWorkExpiresAt } from './workerWorkWindow.js';

const reject = (message, status = 400) => { throw new ReservationError(message, status); };
const historySelection = '+packingActivity +deliveryHistory +reservationRevision';

async function snapshot(order, session, historical = false) {
  const customer = order.user?.name ? order.user : await User.findById(id(order.user)).select('name').session(session).lean();
  const products = historical ? [] : await Product.find({ _id: { $in: order.orderItems.map(item => item.product) } }).select('name packingUnit').session(session).lean();
  const customerName = customer?.name || 'Unknown client';
  return {
    order: order._id, orderRevision: order.reservationRevision || 0,
    orderNumber: order.orderNumber, customerName,
    label: buildCartonLabel(customerName, order.orderNumber, id(order)),
    items: order.orderItems.map(item => {
      const product = products.find(product => id(product) === id(item.product));
      return { sku: item.sku, name: item.productName || product?.name || item.sku, qty: item.qty, unit: product?.packingUnit || 'units' };
    }),
  };
}

export async function recordWorkerWork({ order, type, worker, actor, event, session }) {
  if (!worker) return; // Manual preparation/customer collection is not worker credit.
  const sourceKey = `${id(order)}:${type}:${id(event)}`;
  await WorkerWork.updateOne({ sourceKey }, { $setOnInsert: {
    ...await snapshot(order, session), type, worker: id(worker), actor: id(actor),
    completedAt: event.at, sourceKey, active: true,
  } }, { upsert: true, session });
}

// Older packing logs did not capture the responsible worker separately from the
// admin who clicked Packed. Only an exact, self-confirmed match is creditable.
// Delivery logs already capture the responsible driver, including admin receipts.
async function legacyRecords(order, session = null) {
  const events = [];
  const packed = (order.packingActivity || []).filter(e => e.action === 'PACKED').at(-1);
  if (order.packedAt && packed && Math.abs(+new Date(packed.at) - +new Date(order.packedAt)) < 1000
    && id(packed.actor) === id(order.packedBy) && id(packed.actor) === id(order.packingWorker)
    && (!order.packingHandoverAt || +new Date(order.packingHandoverAt) <= +new Date(packed.at))) {
    events.push({ type: 'packed', worker: id(packed.actor), actor: id(packed.actor), event: packed });
  }
  // Completion time comes from the audit event. Older stock-finalization saves
  // could overwrite order.deliveredAt. A later custody event invalidates it.
  const delivered = (order.deliveryHistory || []).filter(e => ['delivered', 'collected', 'departed', 'returned', 'reshelved', 'corrected'].includes(e.action)).at(-1);
  if (order.status === 'Delivered' && delivered?.action === 'delivered' && delivered.worker && delivered.actor && delivered.method === 'company' && Number.isFinite(+new Date(delivered.at))) {
    events.push({ type: 'delivered', worker: id(delivered.worker), actor: id(delivered.actor), event: delivered });
  }
  if (!events.length) return [];
  const facts = await snapshot(order, session, true);
  return events.map(({ event, ...receipt }) => ({ ...facts, ...receipt, completedAt: event.at, sourceKey: `${id(order)}:${receipt.type}:${id(event)}`, active: true, legacy: true }));
}

// Preserve verifiable legacy facts before destructive changes. Never infer credit
// from a display name, and never resurrect a receipt that was explicitly voided.
export async function preserveWorkerWork(order, session) {
  const existing = await WorkerWork.find({ order: order._id }).select('type').session(session).lean();
  for (const receipt of await legacyRecords(order, session)) {
    if (!existing.some(row => row.type === receipt.type)) {
      await WorkerWork.updateOne({ sourceKey: receipt.sourceKey }, { $setOnInsert: receipt }, { upsert: true, session });
    }
  }
  await WorkerWork.updateMany({ order: order._id }, { $max: { orderRevision: order.reservationRevision || 0 } }, { session });
}

export async function voidWorkerWork(order, type, reason, session) {
  await preserveWorkerWork(order, session);
  await WorkerWork.updateMany({ order: order._id, type, active: true }, { $set: { active: false, voidedAt: new Date(), voidReason: reason } }, { session });
}

async function receiptsFor({ worker, start, end, orderId, session = null }) {
  const filter = { worker, completedAt: { $gte: start, $lt: end }, ...(orderId ? { order: orderId } : {}) };
  const stored = await WorkerWork.find(filter).sort({ completedAt: -1, _id: -1 }).limit(10001).session(session).lean();
  // Legacy fallback is deliberately bounded to records with verifiable audit
  // events. It does not write on reads or copy customer contact information.
  const orders = await Order.find({ ...(orderId ? { _id: orderId } : {}), $or: [
    { packedAt: { $gte: start, $lt: end }, packedBy: worker, packingWorker: worker },
    { status: 'Delivered', deliveryHistory: { $elemMatch: { action: 'delivered', worker, at: { $gte: start, $lt: end } } } },
  ] }).select(historySelection).populate('user', 'name').limit(10001).session(session).lean();
  if (stored.length > 10000 || orders.length > 10000) reject('Too many records in this period. Choose a shorter period.', 422);
  const covered = await WorkerWork.find({ order: { $in: orders.map(order => order._id) } }).select('order type').session(session).lean();
  const records = [...stored];
  for (const order of orders) {
    for (const row of await legacyRecords(order, session)) {
      if (row.worker === id(worker) && +new Date(row.completedAt) >= +start && +new Date(row.completedAt) < +end
        && !covered.some(r => id(r.order) === id(order) && r.type === row.type)) records.push(row);
    }
  }
  return records;
}

function groupRecords(records, admin = false, now = new Date()) {
  const groups = new Map();
  for (const row of [...records].sort((a, b) => +new Date(b.completedAt) - +new Date(a.completedAt))) {
    const key = id(row.order);
    if (!groups.has(key)) groups.set(key, {
      orderId: key, orderNumber: row.orderNumber, customerName: row.customerName, label: row.label,
      items: row.items.map(item => ({ sku: item.sku, name: item.name, qty: item.qty, unit: item.unit || 'units' })),
      work: [], version: row.orderRevision || 0,
    });
    const card = groups.get(key);
    card.version = Math.max(card.version, row.orderRevision || 0);
    if (card.work.some(work => work.type === row.type)) continue;
    card.work.push({ type: row.type, completedAt: row.completedAt, active: row.active,
      ...(row.voidReason ? { voidReason: row.voidReason } : {}),
      ...(admin ? { confirmedBy: id(row.actor), legacy: Boolean(row.legacy) } : { expiresAt: workerWorkExpiresAt(row.completedAt) }),
    });
  }
  return [...groups.values()].map(card => {
    const cartonReference = card.orderNumber.split('-').at(-1);
    const showName = admin || +new Date(card.work[0].completedAt) >= +dubaiDayStart(now);
    const { customerName, label, ...safe } = card;
    return { ...safe, cartonReference, ...(showName ? { customerName, label } : {}),
      totalItems: card.items.length, totalUnits: card.items.reduce((sum, item) => sum + item.qty, 0),
      ...(admin ? {} : { expiresAt: new Date(Math.min(...card.work.map(work => +new Date(work.expiresAt)))), privacyRefreshAt: new Date(+dubaiDayStart(now) + 86400000) }),
    };
  });
}

export async function listWorkerWork(actor, query = {}, now = new Date()) {
  const allowed = actor.isAdmin ? ['workerId', 'period', 'from', 'to', 'page'] : ['period', 'page'];
  if (Object.keys(query).some(key => !allowed.includes(key)) || Object.values(query).some(value => typeof value !== 'string')) reject('Unsupported work-history filter.');
  const worker = actor.isAdmin ? query.workerId : id(actor);
  if (!mongoose.isValidObjectId(worker)) reject('Choose a worker account.');
  if (!actor.isAdmin && !['today', 'yesterday', 'dayBeforeYesterday'].includes(query.period || 'today')) reject('Choose Today, Yesterday or Day before yesterday.');
  let window = workWindow(query.period || 'today', now);
  if (actor.isAdmin && (query.from || query.to)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(query.to || '')) reject('Choose both report dates.');
    const start = new Date(`${query.from}T00:00:00+04:00`), end = new Date(+new Date(`${query.to}T00:00:00+04:00`) + 86400000);
    if (!Number.isFinite(+start) || !Number.isFinite(+end) || new Date(+start + 14400000).toISOString().slice(0, 10) !== query.from
      || new Date(+end - 86400000 + 14400000).toISOString().slice(0, 10) !== query.to
      || +end <= +start || +end - +start > 366 * 86400000) reject('Choose a valid date range of up to one year.');
    window = { start, end };
  }
  if (!window) reject('Choose Today, Yesterday or Last 7 days.');
  if (query.page && !/^[1-9]\d{0,4}$/.test(query.page)) reject('Invalid work page.');
  const records = await receiptsFor({ worker, ...window });
  const cards = groupRecords(records, actor.isAdmin, now);
  // Monthly aggregates never extend the worker's detailed-history access.
  const monthStart = dubaiMonthStart(now);
  const monthlyRecords = await receiptsFor({ worker, start: monthStart, end: new Date(+now + 1) });
  const monthlyDelivered = new Set(monthlyRecords.filter(row => row.active && row.type === 'delivered').map(row => id(row.order))).size;
  const page = Math.min(Number(query.page) || 1, Math.max(1, Math.ceil(cards.length / 12)));
  const counts = { packed: records.filter(r => r.active && r.type === 'packed').length, delivered: records.filter(r => r.active && r.type === 'delivered').length };
  return { data: cards.slice((page - 1) * 12, page * 12), counts, period: query.period || 'today',
    monthly: { month: new Date(+monthStart + 14400000).toISOString().slice(0, 7), delivered: monthlyDelivered },
    window: { ...window, timezone: 'Asia/Dubai' }, checkedAt: now, refreshAt: new Date(+dubaiDayStart(now) + 86400000),
    pagination: { page, total: cards.length, hasNext: page * 12 < cards.length },
    ...(actor.isAdmin ? { notice: 'Only verified completions are counted. Older jobs without a reliable worker record are excluded.' } : {}),
  };
}

// Keep older open packing pages renderable during a backend-first release.
// These counts describe the completion snapshot, never live stock locations.
function readOnlyPackingFields(items, complete = true) {
  const totalUnits = items.reduce((sum, item) => sum + item.qty, 0);
  return {
    canPack: false, problems: [],
    summary: { totalItems: items.length, collectedItems: complete ? items.length : 0, inProgressItems: 0, needsHelp: false,
      totalUnits, pickedUnits: complete ? totalUnits : 0, remainingUnits: complete ? 0 : totalUnits },
    items: items.map((item, index) => ({ sku: item.sku, name: item.name, qty: item.qty, unit: item.unit || 'units',
      productId: `completed-${index}`, pickedQty: complete ? item.qty : 0, reservedQty: complete ? item.qty : 0,
      allocations: [], alternatives: [] })),
  };
}

export async function getWorkerWorkOrder(orderId, actor, { session = null, version = 0, status } = {}, now = new Date()) {
  const records = await receiptsFor({ worker: actor._id, orderId, ...workWindow('last3', now), session });
  const card = groupRecords(records, false, now)[0];
  if (!card) reject('This completed task is no longer available to your account.', 403);
  return { ...card, scope: 'recent-work', version: Math.max(version, card.version), status: status || 'Completed',
    worker: null, canAssign: false, canDepart: false, canDeliver: false, canReturn: false, canCorrect: false, readyReason: '',
    // Safe compatibility fields for consumers transitioning from an active task.
    delivery: null, deliveryState: records.some(row => row.active && row.type === 'delivered') ? 'delivered' : null,
    packedAt: records.find(row => row.active && row.type === 'packed')?.completedAt || null,
    deliveredAt: records.find(row => row.active && row.type === 'delivered')?.completedAt || null,
    ...readOnlyPackingFields(card.items, records.some(row => row.active)),
  };
}

export async function packingHandoffSummary(order, session, delivery = null) {
  const receipt = await WorkerWork.findOne({ order: order._id, type: 'packed', active: true }).session(session).lean();
  const facts = receipt || await snapshot(order, session);
  return { scope: 'packed-handoff', orderId: id(order), orderNumber: facts.orderNumber, createdAt: order.createdAt || null, customerName: facts.customerName, label: facts.label,
    version: order.reservationRevision || 0, status: order.status, packedAt: order.packedAt, delivery,
    deliveryState: order.deliveryMovement?.departedAt && !order.deliveryMovement?.slotsReturnedAt ? (order.deliveryMovement.returnedAt ? 'returned' : order.deliveryMovement.method) : null,
    ...readOnlyPackingFields(facts.items),
    totalItems: facts.items.length, totalUnits: facts.items.reduce((sum, item) => sum + item.qty, 0),
    work: [{ type: 'packed', active: true, completedAt: order.packedAt }],
  };
}
