// Read-only list facts. This pipeline also drives shortcut counts before pagination.
export const ADMIN_LIST_WORK = ['needsAdmin', 'preparation', 'toInvoice', 'toDeliver', 'toFinalize'];
const value = (field, fallback = null) => ({ $ifNull: [field, fallback] });
const exists = field => ({ $ne: [value(field), null] });
const shipping = { $eq: ['$status', 'Shipping'] };
const delivered = { $eq: ['$status', 'Delivered'] };
const published = exists('$packingSentAt');
const packed = exists('$packedAt');
const finalized = exists('$stockFinalizedAt');
const allocated = { $eq: ['$allocationStatus', 'Allocated'] };
const invoice = exists('$invoice');
const and = (...conditions) => ({ $and: conditions });
const not = condition => ({ $not: [condition] });

export const adminListWorkExpression = work => {
  if (work === 'needsAdmin') return { $gt: ['$helpRequestedItems', 0] };
  if (work === 'preparation') return and(not(finalized), { $or: [
    { $eq: ['$status', 'Processing'] }, and(shipping, not(packed)),
  ] });
  return { $eq: ['$listAction', { toInvoice: 'create-invoice', toDeliver: 'mark-delivered', toFinalize: 'finalize-stock' }[work]] };
};

export function adminOrderListPipeline(filter = {}) {
  return [
    { $match: filter },
    { $project: { _id: 1, createdAt: 1, status: 1, allocationStatus: 1, invoice: 1, packingSentAt: 1, packedAt: 1, stockFinalizedAt: 1, 'orderItems.product': 1, 'orderItems.qty': 1, 'packingHelp.product': 1, 'packingHelp.resolvedAt': 1 } },
    { $set: { _listHelpProducts: { $cond: [and(shipping, published, not(finalized)), { $setUnion: [
      { $map: { input: { $filter: { input: value('$packingHelp', []), as: 'request', cond: { $eq: [value('$$request.resolvedAt'), null] } } }, as: 'request', in: '$$request.product' } }, [],
    ] }, []] } } },
    { $lookup: {
      from: 'orderallocations', let: { orderId: '$_id', products: '$_listHelpProducts' },
      pipeline: [
        { $match: { $expr: and({ $eq: ['$order', '$$orderId'] }, { $in: ['$product', '$$products'] }, { $or: [
          { $eq: ['$status', 'Reserved'] }, { $eq: [{ $type: '$status' }, 'missing'] },
        ] }) } },
        { $group: { _id: '$product', reserved: { $sum: '$qty' }, short: { $max: { $cond: [and(
          { $eq: ['$pickProblem', true] }, { $gt: ['$qty', value('$pickedQty', 0)] },
        ), 1, 0] } } } },
      ], as: '_listHelpAllocations',
    } },
    { $lookup: { from: 'invoices', localField: 'invoice', foreignField: '_id', pipeline: [{ $project: { status: 1 } }], as: '_listInvoice' } },
    { $set: {
      invoiceLinkMissing: and(invoice, { $eq: [{ $size: '$_listInvoice' }, 0] }),
      helpRequestedItems: { $size: { $filter: { input: '$_listHelpProducts', as: 'product', cond: {
        $let: { vars: {
          ordered: { $sum: { $map: { input: { $filter: { input: value('$orderItems', []), as: 'item', cond: { $eq: ['$$item.product', '$$product'] } } }, as: 'item', in: '$$item.qty' } } },
          stock: { $arrayElemAt: [{ $filter: { input: '$_listHelpAllocations', as: 'row', cond: { $eq: ['$$row._id', '$$product'] } } }, 0] },
        }, in: and({ $gt: ['$$ordered', 0] }, { $or: [
          { $eq: ['$$stock.short', 1] }, { $lt: [value('$$stock.reserved', 0), '$$ordered'] },
        ] }) },
      } } } },
    } },
    { $set: { listReviewReason: { $switch: { branches: [
      { case: and(finalized, not(delivered), { $ne: ['$status', 'Cancelled'] }), then: 'Review this finalized order before changing preparation.' },
      { case: and(shipping, packed, not(allocated)), then: 'This Packed order has incomplete reservations. Review packing.' },
      { case: '$invoiceLinkMissing', then: 'The linked invoice is unavailable. Review billing.' },
      { case: { $eq: [{ $arrayElemAt: ['$_listInvoice.status', 0] }, 'Cancelled'] }, then: 'The invoice is cancelled. Review billing.' },
      { case: and(delivered, published, not(packed)), then: 'This delivered worker task has no Packed confirmation.' },
    ], default: '' } } } },
    { $set: { listAction: { $switch: { branches: [
      { case: { $eq: ['$status', 'Cancelled'] }, then: null },
      { case: and(delivered, finalized), then: null },
      { case: { $ne: ['$listReviewReason', ''] }, then: 'open-order' },
      { case: { $eq: ['$status', 'Processing'] }, then: 'mark-shipping' },
      { case: and(shipping, { $gt: ['$helpRequestedItems', 0] }), then: 'review-help' },
      { case: and(shipping, not(allocated)), then: 'reserve-stock' },
      { case: and(shipping, not(published), not(invoice)), then: 'send-worker' },
      { case: and(shipping, published, not(packed)), then: 'view-packing' },
      { case: and(shipping, not(invoice)), then: 'create-invoice' },
      { case: shipping, then: 'mark-delivered' },
      { case: and(delivered, not(invoice)), then: 'create-invoice' },
      { case: and(delivered, allocated), then: 'finalize-stock' },
    ], default: 'open-order' } } } },
  ];
}

export const strictPaymentDueInvoiceFilter = {
  status: 'Issued', paymentStatus: { $in: ['Unpaid', 'PartiallyPaid'] },
  $or: [
    { balanceDueMinor: { $gt: 0 } },
    { balanceDueMinor: { $exists: false }, amountMinor: { $type: 'number' }, paidTotalMinor: { $type: 'number' }, $expr: { $gt: ['$amountMinor', '$paidTotalMinor'] } },
  ],
};
