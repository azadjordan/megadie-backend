import asyncHandler from "../middleware/asyncHandler.js";
import mongoose from "mongoose";
import Order from "../models/orderModel.js";
import Invoice from "../models/invoiceModel.js";
import Payment from "../models/paymentModel.js";
import User from "../models/userModel.js";
import {
  ANALYTICS_MONGO_TIME_ZONE,
  buildAnalyticsDateRange,
  enumerateDateKeys,
} from "../utils/analyticsDateRange.js";

const DEFAULT_CURRENCY = "AED";
const DEFAULT_MINOR_UNIT_FACTOR = 100;
const DEFAULT_RANKING_LIMIT = 10;
const MAX_RANKING_LIMIT = 50;

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

function orderLineValueExpression() {
  return {
    $sum: {
      $map: {
        input: { $ifNull: ["$orderItems", []] },
        as: "item",
        in: {
          $let: {
            vars: {
              lineTotal: { $ifNull: ["$$item.lineTotal", null] },
              computedLineTotal: {
                $multiply: [
                  { $ifNull: ["$$item.qty", 0] },
                  { $ifNull: ["$$item.unitPrice", 0] },
                ],
              },
            },
            in: {
              $cond: [
                { $gt: ["$$lineTotal", 0] },
                "$$lineTotal",
                "$$computedLineTotal",
              ],
            },
          },
        },
      },
    },
  };
}

function orderValueExpression() {
  return {
    $let: {
      vars: {
        itemCount: { $size: { $ifNull: ["$orderItems", []] } },
        itemValue: orderLineValueExpression(),
        fees: {
          $add: [
            { $ifNull: ["$deliveryCharge", 0] },
            { $ifNull: ["$extraFee", 0] },
          ],
        },
      },
      in: {
        $cond: [
          { $gt: ["$$itemCount", 0] },
          { $add: ["$$itemValue", "$$fees"] },
          { $ifNull: ["$totalPrice", 0] },
        ],
      },
    },
  };
}

function addAnalyticsOrderValueStage() {
  return {
    $addFields: {
      analyticsOrderValue: orderValueExpression(),
    },
  };
}

function parseCustomerId(value) {
  if (!value) return null;
  const id = String(value).trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new Error("customerId must be a valid user id.");
  }
  return new mongoose.Types.ObjectId(id);
}

function parseLimit(value) {
  const n = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(n)) return DEFAULT_RANKING_LIMIT;
  return Math.min(Math.max(1, n), MAX_RANKING_LIMIT);
}

function customerFilter(customerId) {
  return customerId ? { user: customerId } : {};
}

function toUserKey(value) {
  return String(value || "");
}

function buildCustomerRow(userId, usersById, metricMaps) {
  const key = toUserKey(userId);
  const user = usersById.get(key) || {};
  const booked = metricMaps.booked.get(key) || {};
  const delivered = metricMaps.delivered.get(key) || {};
  const invoiced = metricMaps.invoiced.get(key) || {};
  const collected = metricMaps.collected.get(key) || {};
  const outstanding = metricMaps.outstanding.get(key) || {};

  return {
    customer: {
      _id: key,
      name: user.name || "Unknown customer",
      email: user.email || "",
    },
    bookedSales: roundMajor(booked.bookedSales),
    orderCount: Number(booked.orderCount || 0),
    deliveredValue: roundMajor(delivered.deliveredValue),
    deliveredCount: Number(delivered.deliveredCount || 0),
    invoicedMinor: Number(invoiced.amountMinor || 0),
    invoicedCount: Number(invoiced.count || 0),
    collectedMinor: Number(collected.amountMinor || 0),
    collectedCount: Number(collected.count || 0),
    currentOutstandingMinor: Number(outstanding.amountMinor || 0),
    outstandingInvoiceCount: Number(outstanding.count || 0),
    currency: DEFAULT_CURRENCY,
    minorUnitFactor: DEFAULT_MINOR_UNIT_FACTOR,
  };
}

async function aggregateBookedOrders(start, endExclusive, customerId = null) {
  const [row] = await Order.aggregate([
    {
      $match: {
        status: { $ne: "Cancelled" },
        ...customerFilter(customerId),
        ...dateMatch("createdAt", start, endExclusive),
      },
    },
    addAnalyticsOrderValueStage(),
    {
      $group: {
        _id: null,
        bookedSales: { $sum: "$analyticsOrderValue" },
        orderCount: { $sum: 1 },
      },
    },
  ]);

  return {
    bookedSales: roundMajor(row?.bookedSales),
    orderCount: Number(row?.orderCount || 0),
  };
}

async function aggregateDeliveredValue(start, endExclusive, customerId = null) {
  const [row] = await Order.aggregate([
    {
      $match: {
        status: "Delivered",
        ...customerFilter(customerId),
        ...dateMatch("deliveredAt", start, endExclusive),
      },
    },
    addAnalyticsOrderValueStage(),
    {
      $group: {
        _id: null,
        deliveredValue: { $sum: "$analyticsOrderValue" },
        deliveredCount: { $sum: 1 },
      },
    },
  ]);

  return {
    deliveredValue: roundMajor(row?.deliveredValue),
    deliveredCount: Number(row?.deliveredCount || 0),
  };
}

async function aggregateInvoicedMinor(start, endExclusive, customerId = null) {
  const [row] = await Invoice.aggregate([
    {
      $match: {
        status: "Issued",
        ...customerFilter(customerId),
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

async function aggregateCollectedMinor(start, endExclusive, customerId = null) {
  const [row] = await Payment.aggregate([
    {
      $match: {
        ...customerFilter(customerId),
        ...dateMatch("paymentDate", start, endExclusive),
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

async function aggregateCurrentOutstandingMinor(customerId = null) {
  const [row] = await Invoice.aggregate([
    {
      $match: {
        status: "Issued",
        ...customerFilter(customerId),
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

async function aggregateBookedSalesTrend(range, customerId = null) {
  const rows = await Order.aggregate([
    {
      $match: {
        status: { $ne: "Cancelled" },
        ...customerFilter(customerId),
        ...dateMatch("createdAt", range.start, range.endExclusive),
      },
    },
    addAnalyticsOrderValueStage(),
    {
      $group: {
        _id: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$createdAt",
            timezone: ANALYTICS_MONGO_TIME_ZONE,
          },
        },
        bookedSales: { $sum: "$analyticsOrderValue" },
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

async function aggregateSkuPerformance(start, endExclusive, customerId, limit) {
  const rows = await Order.aggregate([
    {
      $match: {
        status: { $ne: "Cancelled" },
        ...customerFilter(customerId),
        ...dateMatch("createdAt", start, endExclusive),
      },
    },
    { $unwind: "$orderItems" },
    {
      $match: {
        "orderItems.sku": { $type: "string", $ne: "" },
      },
    },
    {
      $group: {
        _id: "$orderItems.sku",
        productName: { $first: "$orderItems.productName" },
        unitsSold: { $sum: "$orderItems.qty" },
        bookedRevenue: {
          $sum: {
            $ifNull: [
              "$orderItems.lineTotal",
              { $multiply: ["$orderItems.qty", "$orderItems.unitPrice"] },
            ],
          },
        },
        orderIds: { $addToSet: "$_id" },
      },
    },
    {
      $project: {
        _id: 0,
        sku: "$_id",
        productName: { $ifNull: ["$productName", ""] },
        unitsSold: 1,
        bookedRevenue: 1,
        orderCount: { $size: "$orderIds" },
      },
    },
    { $sort: { bookedRevenue: -1, unitsSold: -1, sku: 1 } },
    { $limit: limit },
  ]);

  return rows.map((row) => {
    const unitsSold = Number(row.unitsSold || 0);
    const bookedRevenue = roundMajor(row.bookedRevenue);
    return {
      sku: row.sku,
      productName: row.productName || "",
      unitsSold,
      bookedRevenue,
      orderCount: Number(row.orderCount || 0),
      averageSellingPrice: unitsSold > 0 ? roundMajor(bookedRevenue / unitsSold) : 0,
      currency: DEFAULT_CURRENCY,
    };
  });
}

async function aggregateCustomerBooked(start, endExclusive, customerId = null) {
  return Order.aggregate([
    {
      $match: {
        status: { $ne: "Cancelled" },
        ...customerFilter(customerId),
        ...dateMatch("createdAt", start, endExclusive),
      },
    },
    addAnalyticsOrderValueStage(),
    {
      $group: {
        _id: "$user",
        bookedSales: { $sum: "$analyticsOrderValue" },
        orderCount: { $sum: 1 },
      },
    },
  ]);
}

async function aggregateCustomerDelivered(start, endExclusive, customerId = null) {
  return Order.aggregate([
    {
      $match: {
        status: "Delivered",
        ...customerFilter(customerId),
        ...dateMatch("deliveredAt", start, endExclusive),
      },
    },
    addAnalyticsOrderValueStage(),
    {
      $group: {
        _id: "$user",
        deliveredValue: { $sum: "$analyticsOrderValue" },
        deliveredCount: { $sum: 1 },
      },
    },
  ]);
}

async function aggregateCustomerInvoiced(start, endExclusive, customerId = null) {
  return Invoice.aggregate([
    {
      $match: {
        status: "Issued",
        ...customerFilter(customerId),
        ...dateMatch("invoiceDate", start, endExclusive),
      },
    },
    {
      $group: {
        _id: "$user",
        amountMinor: { $sum: "$amountMinor" },
        count: { $sum: 1 },
      },
    },
  ]);
}

async function aggregateCustomerCollected(start, endExclusive, customerId = null) {
  return Payment.aggregate([
    {
      $match: {
        ...customerFilter(customerId),
        ...dateMatch("paymentDate", start, endExclusive),
      },
    },
    {
      $group: {
        _id: "$user",
        amountMinor: { $sum: "$amountMinor" },
        count: { $sum: 1 },
      },
    },
  ]);
}

async function aggregateCustomerOutstanding(customerId = null) {
  return Invoice.aggregate([
    {
      $match: {
        status: "Issued",
        ...customerFilter(customerId),
        balanceDueMinor: { $gt: 0 },
      },
    },
    {
      $group: {
        _id: "$user",
        amountMinor: { $sum: "$balanceDueMinor" },
        count: { $sum: 1 },
      },
    },
  ]);
}

function rowsToMap(rows = []) {
  return new Map(rows.map((row) => [toUserKey(row._id), row]));
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
  let customerId;
  try {
    range = buildAnalyticsDateRange(req.query);
    customerId = parseCustomerId(req.query.customerId);
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
    selectedCustomer,
    trend,
  ] = await Promise.all([
    aggregateBookedOrders(range.start, range.endExclusive, customerId),
    aggregateBookedOrders(
      range.previousStart,
      range.previousEndExclusive,
      customerId
    ),
    aggregateDeliveredValue(range.start, range.endExclusive, customerId),
    aggregateDeliveredValue(
      range.previousStart,
      range.previousEndExclusive,
      customerId
    ),
    aggregateInvoicedMinor(range.start, range.endExclusive, customerId),
    aggregateInvoicedMinor(
      range.previousStart,
      range.previousEndExclusive,
      customerId
    ),
    aggregateCollectedMinor(range.start, range.endExclusive, customerId),
    aggregateCollectedMinor(
      range.previousStart,
      range.previousEndExclusive,
      customerId
    ),
    aggregateCurrentOutstandingMinor(customerId),
    customerId
      ? User.findById(customerId).select("name email").lean()
      : Promise.resolve(null),
    aggregateBookedSalesTrend(range, customerId),
  ]);

  if (customerId && !selectedCustomer) {
    res.status(404);
    throw new Error("Customer not found.");
  }

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
      scope: {
        customer: selectedCustomer
          ? {
              _id: String(selectedCustomer._id),
              name: selectedCustomer.name,
              email: selectedCustomer.email,
            }
          : null,
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

export const getAnalyticsCustomers = asyncHandler(async (req, res) => {
  let range;
  let customerId;
  try {
    range = buildAnalyticsDateRange(req.query);
    customerId = parseCustomerId(req.query.customerId);
  } catch (err) {
    res.status(400);
    throw err;
  }

  const limit = parseLimit(req.query.limit);

  const [booked, delivered, invoiced, collected, outstanding, selectedCustomer] =
    await Promise.all([
      aggregateCustomerBooked(range.start, range.endExclusive, customerId),
      aggregateCustomerDelivered(range.start, range.endExclusive, customerId),
      aggregateCustomerInvoiced(range.start, range.endExclusive, customerId),
      aggregateCustomerCollected(range.start, range.endExclusive, customerId),
      aggregateCustomerOutstanding(customerId),
      customerId
        ? User.findById(customerId).select("name email").lean()
        : Promise.resolve(null),
    ]);

  if (customerId && !selectedCustomer) {
    res.status(404);
    throw new Error("Customer not found.");
  }

  const metricMaps = {
    booked: rowsToMap(booked),
    delivered: rowsToMap(delivered),
    invoiced: rowsToMap(invoiced),
    collected: rowsToMap(collected),
    outstanding: rowsToMap(outstanding),
  };

  const userIds = new Set([
    ...metricMaps.booked.keys(),
    ...metricMaps.delivered.keys(),
    ...metricMaps.invoiced.keys(),
    ...metricMaps.collected.keys(),
    ...metricMaps.outstanding.keys(),
  ]);
  if (customerId) userIds.add(toUserKey(customerId));

  const objectIds = Array.from(userIds)
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  const users = objectIds.length
    ? await User.find({ _id: { $in: objectIds } }).select("name email").lean()
    : [];
  const usersById = new Map(users.map((user) => [toUserKey(user._id), user]));

  const rows = Array.from(userIds)
    .map((userId) => buildCustomerRow(userId, usersById, metricMaps))
    .sort((a, b) => {
      const bookedDiff = b.bookedSales - a.bookedSales;
      if (bookedDiff) return bookedDiff;
      const collectedDiff = b.collectedMinor - a.collectedMinor;
      if (collectedDiff) return collectedDiff;
      const invoicedDiff = b.invoicedMinor - a.invoicedMinor;
      if (invoicedDiff) return invoicedDiff;
      const outstandingDiff =
        b.currentOutstandingMinor - a.currentOutstandingMinor;
      if (outstandingDiff) return outstandingDiff;
      return a.customer.name.localeCompare(b.customer.name);
    })
    .slice(0, limit);

  res.status(200).json({
    success: true,
    message: "Analytics customer performance retrieved successfully.",
    data: {
      range: {
        from: range.from,
        to: range.to,
        timezone: range.timezone,
        boundary: range.boundary,
      },
      scope: {
        customer: selectedCustomer
          ? {
              _id: String(selectedCustomer._id),
              name: selectedCustomer.name,
              email: selectedCustomer.email,
            }
          : null,
      },
      currency: DEFAULT_CURRENCY,
      minorUnitFactor: DEFAULT_MINOR_UNIT_FACTOR,
      limit,
      customers: rows,
    },
  });
});

export const getAnalyticsSkus = asyncHandler(async (req, res) => {
  let range;
  let customerId;
  try {
    range = buildAnalyticsDateRange(req.query);
    customerId = parseCustomerId(req.query.customerId);
  } catch (err) {
    res.status(400);
    throw err;
  }

  const limit = parseLimit(req.query.limit);
  const [selectedCustomer, skus] = await Promise.all([
    customerId
      ? User.findById(customerId).select("name email").lean()
      : Promise.resolve(null),
    aggregateSkuPerformance(range.start, range.endExclusive, customerId, limit),
  ]);

  if (customerId && !selectedCustomer) {
    res.status(404);
    throw new Error("Customer not found.");
  }

  res.status(200).json({
    success: true,
    message: "Analytics SKU performance retrieved successfully.",
    data: {
      range: {
        from: range.from,
        to: range.to,
        timezone: range.timezone,
        boundary: range.boundary,
      },
      scope: {
        customer: selectedCustomer
          ? {
              _id: String(selectedCustomer._id),
              name: selectedCustomer.name,
              email: selectedCustomer.email,
            }
          : null,
      },
      currency: DEFAULT_CURRENCY,
      limit,
      skus,
    },
  });
});
