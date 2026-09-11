import asyncHandler from "../middleware/asyncHandler.js";
import Order from "../models/orderModel.js";
import Invoice from "../models/invoiceModel.js";
import Payment from "../models/paymentModel.js";
import {
  ANALYTICS_MONGO_TIME_ZONE,
  buildAnalyticsDateRange,
  enumerateDateKeys,
} from "../utils/analyticsDateRange.js";

const DEFAULT_CURRENCY = "AED";
const DEFAULT_MINOR_UNIT_FACTOR = 100;

function roundMajor(value) {
  const n = Number(value) || 0;
  return Math.round(n * 100) / 100;
}

function roundPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function changePercent(current, previous) {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (prev <= 0) return null;
  return roundPercent(((cur - prev) / prev) * 100);
}

function dateMatch(field, start, endExclusive) {
  return {
    [field]: {
      $gte: start,
      $lt: endExclusive,
    },
  };
}

async function aggregateBookedOrders(start, endExclusive) {
  const [row] = await Order.aggregate([
    {
      $match: {
        status: { $ne: "Cancelled" },
        ...dateMatch("createdAt", start, endExclusive),
      },
    },
    {
      $group: {
        _id: null,
        bookedSales: { $sum: "$totalPrice" },
        orderCount: { $sum: 1 },
      },
    },
  ]);

  return {
    bookedSales: roundMajor(row?.bookedSales),
    orderCount: Number(row?.orderCount || 0),
  };
}

async function aggregateDeliveredValue(start, endExclusive) {
  const [row] = await Order.aggregate([
    {
      $match: {
        status: "Delivered",
        ...dateMatch("deliveredAt", start, endExclusive),
      },
    },
    {
      $group: {
        _id: null,
        deliveredValue: { $sum: "$totalPrice" },
        deliveredCount: { $sum: 1 },
      },
    },
  ]);

  return {
    deliveredValue: roundMajor(row?.deliveredValue),
    deliveredCount: Number(row?.deliveredCount || 0),
  };
}

async function aggregateInvoicedMinor(start, endExclusive) {
  const [row] = await Invoice.aggregate([
    {
      $match: {
        status: "Issued",
        ...dateMatch("invoiceDate", start, endExclusive),
      },
    },
    {
      $group: {
        _id: null,
        amountMinor: { $sum: "$amountMinor" },
        count: { $sum: 1 },
      },
    },
  ]);

  return {
    amountMinor: Number(row?.amountMinor || 0),
    count: Number(row?.count || 0),
  };
}

async function aggregateCollectedMinor(start, endExclusive) {
  const [row] = await Payment.aggregate([
    {
      $match: dateMatch("paymentDate", start, endExclusive),
    },
    {
      $group: {
        _id: null,
        amountMinor: { $sum: "$amountMinor" },
        count: { $sum: 1 },
      },
    },
  ]);

  return {
    amountMinor: Number(row?.amountMinor || 0),
    count: Number(row?.count || 0),
  };
}

async function aggregateCurrentOutstandingMinor() {
  const [row] = await Invoice.aggregate([
    {
      $match: {
        status: "Issued",
        balanceDueMinor: { $gt: 0 },
      },
    },
    {
      $group: {
        _id: null,
        amountMinor: { $sum: "$balanceDueMinor" },
        count: { $sum: 1 },
      },
    },
  ]);

  return {
    amountMinor: Number(row?.amountMinor || 0),
    count: Number(row?.count || 0),
  };
}

async function aggregateBookedSalesTrend(range) {
  const rows = await Order.aggregate([
    {
      $match: {
        status: { $ne: "Cancelled" },
        ...dateMatch("createdAt", range.start, range.endExclusive),
      },
    },
    {
      $group: {
        _id: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$createdAt",
            timezone: ANALYTICS_MONGO_TIME_ZONE,
          },
        },
        bookedSales: { $sum: "$totalPrice" },
        orderCount: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const byDate = new Map(rows.map((row) => [row._id, row]));

  return enumerateDateKeys(range.from, range.to).map((date) => {
    const row = byDate.get(date);
    return {
      date,
      bookedSales: roundMajor(row?.bookedSales),
      orderCount: Number(row?.orderCount || 0),
    };
  });
}

function majorMetric(current, previous) {
  return {
    current,
    previous,
    changePercent: changePercent(current, previous),
  };
}

function minorMetric(currentMinor, previousMinor, extra = {}) {
  return {
    currentMinor,
    previousMinor,
    changePercent: changePercent(currentMinor, previousMinor),
    currency: DEFAULT_CURRENCY,
    minorUnitFactor: DEFAULT_MINOR_UNIT_FACTOR,
    ...extra,
  };
}

export const getAnalyticsOverview = asyncHandler(async (req, res) => {
  let range;
  try {
    range = buildAnalyticsDateRange(req.query);
  } catch (err) {
    res.status(400);
    throw err;
  }

  const [
    currentBooked,
    previousBooked,
    currentDelivered,
    previousDelivered,
    currentInvoiced,
    previousInvoiced,
    currentCollected,
    previousCollected,
    currentOutstanding,
    trend,
  ] = await Promise.all([
    aggregateBookedOrders(range.start, range.endExclusive),
    aggregateBookedOrders(range.previousStart, range.previousEndExclusive),
    aggregateDeliveredValue(range.start, range.endExclusive),
    aggregateDeliveredValue(range.previousStart, range.previousEndExclusive),
    aggregateInvoicedMinor(range.start, range.endExclusive),
    aggregateInvoicedMinor(range.previousStart, range.previousEndExclusive),
    aggregateCollectedMinor(range.start, range.endExclusive),
    aggregateCollectedMinor(range.previousStart, range.previousEndExclusive),
    aggregateCurrentOutstandingMinor(),
    aggregateBookedSalesTrend(range),
  ]);

  res.status(200).json({
    success: true,
    message: "Analytics overview retrieved successfully.",
    data: {
      range: {
        from: range.from,
        to: range.to,
        previousFrom: range.previousFrom,
        previousTo: range.previousTo,
        timezone: range.timezone,
        boundary: range.boundary,
      },
      metrics: {
        bookedSales: majorMetric(
          currentBooked.bookedSales,
          previousBooked.bookedSales
        ),
        orders: majorMetric(currentBooked.orderCount, previousBooked.orderCount),
        deliveredValue: {
          ...majorMetric(
            currentDelivered.deliveredValue,
            previousDelivered.deliveredValue
          ),
          currentCount: currentDelivered.deliveredCount,
          previousCount: previousDelivered.deliveredCount,
        },
        invoiced: minorMetric(
          currentInvoiced.amountMinor,
          previousInvoiced.amountMinor,
          {
            currentCount: currentInvoiced.count,
            previousCount: previousInvoiced.count,
          }
        ),
        collected: minorMetric(
          currentCollected.amountMinor,
          previousCollected.amountMinor,
          {
            currentCount: currentCollected.count,
            previousCount: previousCollected.count,
          }
        ),
        currentOutstanding: {
          amountMinor: currentOutstanding.amountMinor,
          count: currentOutstanding.count,
          currency: DEFAULT_CURRENCY,
          minorUnitFactor: DEFAULT_MINOR_UNIT_FACTOR,
          snapshotAt: new Date().toISOString(),
        },
      },
      trend,
    },
  });
});
