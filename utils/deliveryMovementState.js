// A returned carton is still collected stock until its actual return to shelves.
export const deliveryIsOut = order => Boolean(order.status === 'Shipping' && order.deliveryMovement?.departedAt && !order.deliveryMovement?.returnedAt && !order.deliveryMovement?.slotsReturnedAt);
export const deliveryHoldsGoods = order => Boolean(order.status === 'Shipping' && order.deliveryMovement?.departedAt && !order.deliveryMovement?.slotsReturnedAt);
export function deliveryStockLockReason(order) {
  if (deliveryIsOut(order)) return 'Goods are out for delivery. Record their return to the store before changing stock or preparation.';
  if (deliveryHoldsGoods(order)) return 'Goods are back in the store but still packed. Confirm their return to the original slots when changing stock or preparation.';
  return '';
}
