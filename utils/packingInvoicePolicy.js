export const packingInvoiceLockReason = order => order.packingSentAt && !order.packedAt
  ? 'Finish worker packing before creating the invoice. Resolve shortages and mark the order Packed first.' : '';

export const packingPublicationLockReason = (order, hasInvoice) => !order.packingSentAt && hasInvoice
  ? 'This order already has an invoice. Live packing must start before invoicing. Resolve its billing first, or continue its existing preparation process.' : '';

export const packingReopenLockReason = hasInvoice => hasInvoice
  ? 'This order has an invoice. Resolve its billing before reopening packing.' : '';
