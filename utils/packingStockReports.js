import Order from '../models/orderModel.js';

export const stockChecksNeededFilter = { packingReports: { $elemMatch: { checkedAt: null } } };

// Compute from reports, including legacy orders, without a data backfill or
// exposing internal report details on the admin list or customer APIs.
export async function packingStockCheckCounts(orderIds) {
  if (!orderIds.length) return new Map();
  const rows = await Order.aggregate([
    { $match: { _id: { $in: orderIds } } },
    { $project: { stockChecksPending: { $size: { $filter: {
      input: { $ifNull: ['$packingReports', []] }, as: 'report',
      cond: { $eq: [{ $ifNull: ['$$report.checkedAt', null] }, null] },
    } } } } },
  ]);
  return new Map(rows.map(row => [String(row._id), row.stockChecksPending]));
}
