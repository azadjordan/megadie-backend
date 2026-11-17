import { reservationId as id } from './orderReservationPlan.js';

// Do not apply a schema default: missing and explicitly unassigned are distinct.
export const deliveryWorkerId = order => id(order.deliveryWorker === undefined
  ? (order.packingSentAt && order.preparationMode === 'prepare_deliver' ? order.packingWorker : null)
  : order.deliveryWorker);

export const deliveryWorkerFilter = workerId => ({ $or: [
  { deliveryWorker: workerId },
  { deliveryWorker: { $exists: false }, packingWorker: workerId, packingSentAt: { $ne: null }, preparationMode: 'prepare_deliver' },
] });

export const canReadDelivery = (order, actor) => Boolean(actor?.isAdmin || (actor?.isWorker &&
  (deliveryWorkerId(order) === id(actor) || (order.packingSentAt && id(order.packingWorker) === id(actor)))));
