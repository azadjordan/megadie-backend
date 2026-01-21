// controllers/inventoryController.js
import mongoose from "mongoose";
import asyncHandler from "../middleware/asyncHandler.js";
import Product from "../models/productModel.js";
import SlotItem from "../models/slotItemModel.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import {
  buildProductFilter,
  parsePagination,
  buildSort,
} from "./productController.js";

const LOW_STOCK_THRESHOLD = 10;

const escapeRegex = (text = "") =>
  String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* =========================
   GET /api/inventory/products
   Private/Admin
   Returns inventory totals per product
   ========================= */
export const getInventoryProducts = asyncHandler(async (req, res) => {
  const { productType } = req.query;
  const { page, limit, skip } = parsePagination(req, {
    defaultLimit: 50,
    maxLimit: 200,
  });

  const filter = await buildProductFilter(req, { forAdmin: true });
  const q = String(req.query.q || "").trim();
  const sortRaw = String(req.query.sort || "recent").toLowerCase();
  const sortKey = ["recent", "qtyhigh", "qtylow"].includes(sortRaw)
    ? sortRaw
    : "recent";
  const statusKey = String(req.query.status || "").toLowerCase();
  const statusValue =
    statusKey === "ok"
      ? "OK"
      : statusKey === "low"
      ? "Low"
      : statusKey === "out"
      ? "Out"
      : null;
  if (q) {
    const regex = { $regex: escapeRegex(q), $options: "i" };
    const search = [{ sku: regex }];
    if (filter.$or) {
      filter.$and = filter.$and || [];
      filter.$and.push({ $or: filter.$or }, { $or: search });
      delete filter.$or;
    } else {
      filter.$or = search;
    }
  }

  const slotItemsCollection = SlotItem.collection.name;
  const allocationsCollection = OrderAllocation.collection.name;

  const inventoryStages = [
    {
      $lookup: {
        from: slotItemsCollection,
        let: { productId: "$_id" },
        pipeline: [
          { $match: { $expr: { $eq: ["$product", "$$productId"] } } },
          { $group: { _id: "$product", onHand: { $sum: "$qty" } } },
        ],
        as: "slotAgg",
      },
    },
    {
      $lookup: {
        from: allocationsCollection,
        let: { productId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ["$product", "$$productId"] },
              $or: [{ status: "Reserved" }, { status: { $exists: false } }],
            },
          },
          { $group: { _id: "$product", allocated: { $sum: "$qty" } } },
        ],
        as: "allocAgg",
      },
    },
    {
      $addFields: {
        onHand: { $ifNull: [{ $arrayElemAt: ["$slotAgg.onHand", 0] }, 0] },
        allocated: {
          $ifNull: [{ $arrayElemAt: ["$allocAgg.allocated", 0] }, 0],
        },
      },
    },
    { $addFields: { available: { $subtract: ["$onHand", "$allocated"] } } },
    {
      $addFields: {
        available: {
          $cond: [{ $lt: ["$available", 0] }, 0, "$available"],
        },
      },
    },
    {
      $addFields: {
        status: {
          $switch: {
            branches: [
              { case: { $lte: ["$onHand", 0] }, then: "Out" },
              { case: { $lte: ["$onHand", LOW_STOCK_THRESHOLD] }, then: "Low" },
            ],
            default: "OK",
          },
        },
      },
    },
  ];

  const needsFullAggregation =
    !!statusValue || sortKey === "qtyhigh" || sortKey === "qtylow";
  const preSort =
    sortKey === "recent" ? buildSort(productType) : null;

  const summaryPipeline = [
    { $match: filter },
    ...inventoryStages,
    ...(statusValue ? [{ $match: { status: statusValue } }] : []),
    {
      $group: {
        _id: null,
        totalSkus: { $sum: 1 },
        totalOnHand: { $sum: "$onHand" },
        totalAllocated: { $sum: "$allocated" },
        lowStockCount: {
          $sum: { $cond: [{ $ne: ["$status", "OK"] }, 1, 0] },
        },
      },
    },
    {
      $project: {
        _id: 0,
        totalSkus: 1,
        totalOnHand: 1,
        totalAllocated: 1,
        lowStockCount: 1,
      },
    },
  ];

  const summaryResult = await Product.aggregate(summaryPipeline);
  const summary = summaryResult[0] || {
    totalSkus: 0,
    totalOnHand: 0,
    totalAllocated: 0,
    lowStockCount: 0,
  };

  const total = summary.totalSkus || 0;
  const totalPages = Math.max(Math.ceil(total / limit), 1);

  const pipeline = [{ $match: filter }];
  if (!needsFullAggregation) {
    if (preSort) pipeline.push({ $sort: preSort });
    pipeline.push({ $skip: skip }, { $limit: limit });
  }

  pipeline.push(...inventoryStages);

  if (statusValue) {
    pipeline.push({ $match: { status: statusValue } });
  }

  if (needsFullAggregation) {
    const postSort =
      sortKey === "qtylow"
        ? { onHand: 1, name: 1, _id: 1 }
        : sortKey === "qtyhigh"
        ? { onHand: -1, name: 1, _id: 1 }
        : buildSort(productType);
    pipeline.push({ $sort: postSort }, { $skip: skip }, { $limit: limit });
  }

  pipeline.push(
    {
      $lookup: {
        from: "categories",
        localField: "category",
        foreignField: "_id",
        as: "categoryDoc",
      },
    },
    {
      $project: {
        _id: 0,
        id: "$_id",
        sku: 1,
        name: 1,
        productType: 1,
        category: {
          $ifNull: [
            { $arrayElemAt: ["$categoryDoc.displayName", 0] },
            {
              $ifNull: [
                { $arrayElemAt: ["$categoryDoc.name", 0] },
                { $arrayElemAt: ["$categoryDoc.key", 0] },
              ],
            },
          ],
        },
        onHand: 1,
        allocated: 1,
        available: 1,
        status: 1,
        isActive: 1,
      },
    }
  );

  const rows = await Product.aggregate(pipeline);

  res.status(200).json({
    success: true,
    message: "Inventory products retrieved successfully.",
    summary,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasPrev: page > 1,
      hasNext: page < totalPages,
    },
    data: rows,
  });
});

/* =========================
   GET /api/inventory/allocations
   Private/Admin
   Returns allocation ledger across orders
   Query: status, orderStatus, q, orderId, productId, slotId
   ========================= */
export const getInventoryAllocations = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req, {
    defaultLimit: 25,
    maxLimit: 100,
  });

  const statusRaw = String(req.query.status || "").trim();
  const orderStatusRaw = String(req.query.orderStatus || "").trim();
  const searchRaw = String(req.query.q || "").trim();
  const orderId = String(req.query.orderId || "").trim();
  const productId = String(req.query.productId || "").trim();
  const slotId = String(req.query.slotId || "").trim();

  const match = {};
  if (statusRaw && statusRaw !== "all") {
    const normalized = statusRaw.toLowerCase();
    if (normalized === "reserved") {
      match.$or = [{ status: "Reserved" }, { status: { $exists: false } }];
    } else if (normalized === "deducted") {
      match.status = "Deducted";
    } else if (normalized === "cancelled" || normalized === "canceled") {
      match.status = "Cancelled";
    } else {
      res.status(400);
      throw new Error("Invalid allocation status filter.");
    }
  }

  if (orderId) {
    if (!mongoose.isValidObjectId(orderId)) {
      res.status(400);
      throw new Error("Invalid order id.");
    }
    match.order = new mongoose.Types.ObjectId(orderId);
  }

  if (productId) {
    if (!mongoose.isValidObjectId(productId)) {
      res.status(400);
      throw new Error("Invalid product id.");
    }
    match.product = new mongoose.Types.ObjectId(productId);
  }

  if (slotId) {
    if (!mongoose.isValidObjectId(slotId)) {
      res.status(400);
      throw new Error("Invalid slot id.");
    }
    match.slot = new mongoose.Types.ObjectId(slotId);
  }

  const pipeline = [
    { $match: match },
    {
      $lookup: {
        from: "orders",
        localField: "order",
        foreignField: "_id",
        as: "order",
      },
    },
    { $unwind: "$order" },
    {
      $lookup: {
        from: "users",
        localField: "order.user",
        foreignField: "_id",
        as: "customer",
      },
    },
    { $unwind: { path: "$customer", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "products",
        localField: "product",
        foreignField: "_id",
        as: "product",
      },
    },
    { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "slots",
        localField: "slot",
        foreignField: "_id",
        as: "slot",
      },
    },
    { $unwind: { path: "$slot", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "users",
        localField: "by",
        foreignField: "_id",
        as: "by",
      },
    },
    { $unwind: { path: "$by", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "users",
        localField: "deductedBy",
        foreignField: "_id",
        as: "deductedBy",
      },
    },
    { $unwind: { path: "$deductedBy", preserveNullAndEmptyArrays: true } },
  ];

  if (orderStatusRaw && orderStatusRaw !== "all") {
    const allowedStatuses = new Set(
      ["Processing", "Shipping", "Delivered", "Cancelled"]
    );
    if (!allowedStatuses.has(orderStatusRaw)) {
      res.status(400);
      throw new Error("Invalid order status filter.");
    }
    pipeline.push({ $match: { "order.status": orderStatusRaw } });
  }

  if (searchRaw) {
    const regex = new RegExp(escapeRegex(searchRaw), "i");
    pipeline.push({
      $match: {
        $or: [
          { "order.orderNumber": regex },
          { "product.name": regex },
          { "product.sku": regex },
          { "slot.label": regex },
          { "slot.store": regex },
          { "customer.name": regex },
          { "customer.email": regex },
        ],
      },
    });
  }

  pipeline.push(
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $facet: {
        rows: [
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              _id: 0,
              id: "$_id",
              qty: 1,
              status: { $ifNull: ["$status", "Reserved"] },
              note: 1,
              expiresAt: 1,
              createdAt: 1,
              updatedAt: 1,
              deductedAt: 1,
              order: {
                id: "$order._id",
                orderNumber: "$order.orderNumber",
                status: "$order.status",
                allocationStatus: "$order.allocationStatus",
                invoice: "$order.invoice",
                stockFinalizedAt: "$order.stockFinalizedAt",
                user: {
                  id: "$customer._id",
                  name: "$customer.name",
                  email: "$customer.email",
                },
              },
              product: {
                id: "$product._id",
                name: "$product.name",
                sku: "$product.sku",
              },
              slot: {
                id: "$slot._id",
                label: "$slot.label",
                store: "$slot.store",
                unit: "$slot.unit",
                position: "$slot.position",
              },
              by: {
                id: "$by._id",
                name: "$by.name",
                email: "$by.email",
              },
              deductedBy: {
                id: "$deductedBy._id",
                name: "$deductedBy.name",
                email: "$deductedBy.email",
              },
            },
          },
        ],
        total: [{ $count: "count" }],
      },
    }
  );

  const [result] = await OrderAllocation.aggregate(pipeline);
  const rows = result?.rows ?? [];
  const total = result?.total?.[0]?.count ?? 0;
  const totalPages = Math.max(Math.ceil(total / limit), 1);

  res.status(200).json({
    success: true,
    message: "Inventory allocations retrieved successfully.",
    data: rows,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasPrev: page > 1,
      hasNext: page < totalPages,
    },
  });
});
