import { reservationId as id } from './orderReservationPlan.js';

// Do not apply a schema default: missing and explicitly unassigned are distinct.
export const deliveryWorkerId = order => id(order.deliveryWorker === undefined
  ? (order.packingSentAt && order.preparationMode === 'prepare_deliver' ? order.packingWorker : null)
  : order.deliveryWorker);

export const deliveryWorkerFilter = workerId => ({ $or: [
  { deliveryWorker: workerId },
  { deliveryWorker: { $exists: false }, packingWorker: workerId, packingSentAt: { $ne: null }, preparationMode: 'prepare_deliver' },
] });

// Used by both explicit assignments and the initial pack-and-deliver shortcut.
export function setDeliveryWorker(order, worker, actor) {
  const previous = deliveryWorkerId(order), next = worker ? id(worker) : '';
  order.deliveryWorker = worker?._id || null;
  if (previous === next) return;
  order.deliveryHistory ||= [];
  order.deliveryHistory.push({ action: 'assigned', worker: worker?._id, previousWorker: previous || undefined,
    handler: worker?.name || '', actor: actor._id, actorName: actor.name,
    note: worker ? `Delivery assigned to ${worker.name}.` : 'Delivery assignment removed.' });
}

export const canReadDelivery = (order, actor) => Boolean(actor?.isAdmin || (actor?.isWorker &&
  (deliveryWorkerId(order) === id(actor) || (order.packingSentAt && id(order.packingWorker) === id(actor)))));
