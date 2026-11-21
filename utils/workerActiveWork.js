import Order from '../models/orderModel.js';
import OrderAllocation from '../models/orderAllocationModel.js';
import SlotItem from '../models/slotItemModel.js';
import { ReservationError } from './orderReservations.js';
import { reservationId as id, isReserved } from './orderReservationPlan.js';
import { activeWorkerOrderFilter, hasActiveWorkerWork } from './deliveryAssignmentState.js';
import { deliveryIsOut, deliveryStockLockReason } from './deliveryMovementState.js';
import { buildCartonLabel } from './orderDelivery.js';
import { getPackingView } from './orderPacking.js';
import { deliveryTaskView } from './workerDelivery.js';
import { movementReadyReason } from './orderMovement.js';

// Presentation only: never stored as an additional order status.
export function activeWorkCard(order, actor, packing, delivery) {
  const ownsPacking = Boolean(order.packingSentAt && id(order.packingWorker) === id(actor));
  if (!hasActiveWorkerWork(order, actor._id)) return null;
  const card = {
    orderId: id(order), orderNumber: order.orderNumber, createdAt: order.createdAt || null,
    customerName: order.user?.name || 'Unknown client',
    label: buildCartonLabel(order.user?.name, order.orderNumber, id(order)),
    version: order.reservationRevision || 0, packedAt: order.packedAt || null,
    totalItems: new Set(order.orderItems.map(item => id(item.product))).size, totalUnits: order.orderItems.reduce((sum, item) => sum + item.qty, 0),
    group: 'waiting', kind: ownsPacking && !order.packedAt && !deliveryIsOut(order) ? 'packing' : 'delivery',
    nextAction: null, message: '', needsHelp: false,
  };
  if (card.kind === 'packing') {
    if (!packing || packing.scope) return null;
    card.summary = packing.summary;
    card.needsHelp = Boolean(packing.summary.needsHelp || packing.helpRequestedItems || packing.problems.length);
    const canPick = packing.items.some(product => product.allocations.some(row => row.canPick && row.qty > row.pickedQty && !row.problemQty));
    const canReplace = !order.stockFinalizedAt && !deliveryStockLockReason(order) && packing.items.some(product => product.allocations.some(row => isReserved(row) && row.problemQty > 0 && product.alternatives.some(slot => slot.slotId !== row.slotId && slot.availableQty > 0)));
    if (packing.canPack || canPick || canReplace) {
      card.group = 'todo';
      card.nextAction = packing.canPack ? 'packed' : packing.summary.pickedUnits > 0 || card.needsHelp ? 'continue_packing' : 'start_packing';
      card.message = packing.canPack ? 'All items collected. Pack and label the carton.' : packing.helpRequestedItems ? 'Admin help requested. You can continue other picking work.' : card.needsHelp ? 'Some items need attention. You can continue picking.' : 'Collect the reserved items, then pack the carton.';
    } else {
      card.message = packing.helpRequestedItems ? 'Waiting for admin help.' : 'Packing needs admin review.';
    }
    return card;
  }
  if (card.kind === 'delivery') {
    if (!delivery || delivery.scope) return null;
    // An allowlist keeps list cards free of prices, history and item records.
    for (const key of ['status', 'deliveryState', 'worker', 'delivery', 'canDepart', 'canDeliver', 'canReturn', 'readyReason', 'manualPreparation']) card[key] = delivery[key];
    if (delivery.canDepart || delivery.canDeliver) {
      card.group = 'todo';
      card.nextAction = delivery.canDeliver ? 'delivered' : 'departed';
      card.message = delivery.canDeliver ? 'Out for delivery. Confirm after the customer receives the complete order.' : delivery.deliveryState === 'returned' ? 'Back in store. Ready for another delivery.' : 'Ready for delivery.';
    } else {
      card.message = delivery.readyReason || 'Waiting for delivery preparation.';
      card.needsHelp = Boolean(delivery.readyReason && delivery.readyReason !== 'Waiting for packing.');
    }
    return card;
  }
  return null;
}

export async function listActiveWorkerWork(actor, query = {}) {
  if (!actor?.isWorker && !actor?.isAdmin) throw new ReservationError('Worker access is required.', 403);
  if (Object.keys(query).some(key => !['todoPage', 'waitingPage'].includes(key)) || Object.values(query).some(value => typeof value !== 'string' || !/^[1-9]\d{0,4}$/.test(value))) {
    throw new ReservationError('Invalid active-work page.', 400);
  }
  // One order query deduplicates combined assignments before grouping/paging.
  const orders = await Order.find(activeWorkerOrderFilter(actor._id)).select('orderNumber user packingWorker deliveryWorker preparationMode packingSentAt packedAt deliveryMovement orderItems status stockFinalizedAt allocationStatus deliveryDetails createdAt +packingHelp +packingReports +reservationRevision')
    .populate('user', 'name deliveryContactName deliveryPhoneNumber phoneNumber secondaryPhoneNumber address deliveryGoogleMapsUrl deliveryNotes')
    .populate('packingWorker', 'name isWorker').populate('deliveryWorker', 'name isWorker')
    .sort({ createdAt: 1, _id: 1 }).lean();
  const rows = orders.length ? await OrderAllocation.find({ order: { $in: orders.map(order => order._id) }, status: { $ne: 'Cancelled' } })
    .populate('product', 'name sku packingUnit').populate('slot', 'label store isActive').sort({ createdAt: 1, _id: 1 }).lean() : [];
  const products = [...new Set(orders.flatMap(order => order.orderItems.map(item => id(item.product))))];
  const [stock, reservations] = products.length ? await Promise.all([
    SlotItem.find({ product: { $in: products } }).populate('slot', 'label store isActive').sort({ qty: 1, createdAt: -1, _id: 1 }).lean(),
    OrderAllocation.find({ product: { $in: products }, $or: [{ status: 'Reserved' }, { status: { $exists: false } }] }).select('order product slot qty').lean(),
  ]) : [[], []];
  const cards = await Promise.all(orders.map(async order => {
    const productIds = new Set(order.orderItems.map(item => id(item.product)));
    const snapshot = { order, rows: rows.filter(row => id(row.order) === id(order)), stock: stock.filter(row => productIds.has(id(row.product))), reservations: reservations.filter(row => productIds.has(id(row.product))) };
    const packing = order.packingSentAt && id(order.packingWorker) === id(actor) && !order.packedAt && !deliveryIsOut(order)
      ? await getPackingView(id(order), actor, null, snapshot) : null;
    const delivery = !packing ? await deliveryTaskView(order, actor, () => movementReadyReason(order, snapshot.rows, null, {
      stock: snapshot.stock, others: snapshot.reservations.filter(row => id(row.order) !== id(order)),
    })) : null;
    return activeWorkCard(order, actor, packing, delivery);
  }));
  const groups = Object.fromEntries(['todo', 'waiting'].map(key => {
    const matching = cards.filter(card => card?.group === key), limit = 12;
    const page = Math.min(Number(query[`${key}Page`]) || 1, Math.max(1, Math.ceil(matching.length / limit)));
    return [key, { data: matching.slice((page - 1) * limit, page * limit), pagination: { page, total: matching.length, hasNext: page * limit < matching.length } }];
  }));
  return { groups };
}
