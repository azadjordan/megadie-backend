import asyncHandler from "../middleware/asyncHandler.js";
import mongoose from "mongoose";
import SlotItem from "../models/slotItemModel.js";
import Slot from "../models/slotModel.js";
import OrderAllocation from "../models/orderAllocationModel.js";
import { applySlotOccupancyDelta } from "../utils/slotOccupancy.js";
import { logInventoryMovement, getUnitCbm } from "../utils/inventoryMovement.js";

const hasReservedAllocations = async (slotId, productIds, session = null) => {
  if (!productIds || productIds.length === 0) return false;
  const query = OrderAllocation.exists({
    slot: slotId,
    product: { $in: productIds },
    $or: [{ status: "Reserved" }, { status: { $exists: false } }],
  });
  if (session) {
    query.session(session);
  }
  const exists = await query;
  return Boolean(exists);
};

/* =========================
   GET /api/slot-items/by-product/:productId
   Lists all slot items for a product (for picking UI)
   ========================= */
export const getSlotItemsByProduct = asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const { orderId } = req.query;

  if (!mongoose.isValidObjectId(productId)) {
    res.status(400);
    throw new Error("Invalid product id.");
  }
  if (orderId && !mongoose.isValidObjectId(orderId)) {
    res.status(400);
    throw new Error("Invalid order id.");
  }

  let items = await SlotItem.find({ product: productId })
    .populate("slot", "label store unit position")
    .sort({ qty: 1, createdAt: -1 })
    .lean();

  if (orderId) {
    const reservedRows = await OrderAllocation.find({
      product: productId,
      slot: { $in: items.map((item) => item.slot?._id || item.slot).filter(Boolean) },
      order: { $ne: orderId },
      $or: [{ status: "Reserved" }, { status: { $exists: false } }],
    })
      .select("slot qty")
      .lean();

    const reservedBySlot = new Map();
    for (const row of reservedRows) {
      const slotKey = String(row.slot);
      const qtyValue = Number(row.qty) || 0;
      reservedBySlot.set(slotKey, (reservedBySlot.get(slotKey) || 0) + qtyValue);
    }

    items = items.map((item) => {
      const slotKey = String(item.slot?._id || item.slot);
      const reservedQty = reservedBySlot.get(slotKey) || 0;
      const onHand = Number(item.qty) || 0;
      const availableQty = Math.max(0, onHand - reservedQty);
      return { ...item, reservedQty, availableQty };
    });
  }

  res.status(200).json({
    success: true,
    message: "Slot items retrieved successfully.",
    data: items,
  });
});

/* =========================
   GET /api/slot-items/by-slot/:slotId
   Lists all slot items for a slot
   ========================= */
export const getSlotItemsBySlot = asyncHandler(async (req, res) => {
  const { slotId } = req.params;

  if (!mongoose.isValidObjectId(slotId)) {
    res.status(400);
    throw new Error("Invalid slot id.");
  }

  const items = await SlotItem.find({ slot: slotId })
    .populate("product", "name sku catalogCode")
    .sort({ qty: -1, updatedAt: -1 })
    .lean();

  res.status(200).json({
    success: true,
    message: "Slot items retrieved successfully.",
    data: items,
  });
});

/* =========================
   POST /api/slot-items/adjust
   Adds stock for a product in a slot
   Body: { productId, slotId, deltaQty }
   ========================= */
export const adjustSlotItem = asyncHandler(async (req, res) => {
  const { productId, slotId, deltaQty } = req.body || {};

  if (!mongoose.isValidObjectId(productId)) {
    res.status(400);
    throw new Error("Invalid product id.");
  }

  if (!mongoose.isValidObjectId(slotId)) {
    res.status(400);
    throw new Error("Invalid slot id.");
  }

  const deltaValue = Number(deltaQty);
  if (
    !Number.isFinite(deltaValue) ||
    !Number.isInteger(deltaValue) ||
    deltaValue <= 0
  ) {
    res.status(400);
    throw new Error("deltaQty must be a positive integer.");
  }

  const session = await mongoose.startSession();
  let responseData = null;
  let responseStatus = 200;

  try {
    await session.withTransaction(async () => {
      const slot = await Slot.findById(slotId)
        .select("_id label cbm")
        .session(session);
      if (!slot) {
        res.status(404);
        throw new Error("Slot not found.");
      }

      const reservedExists = await hasReservedAllocations(
        slotId,
        [productId],
        session
      );
      if (reservedExists) {
        res.status(409);
        throw new Error(
          "Stock adjustments are blocked while allocations are unresolved for this slot."
        );
      }

      let item = await SlotItem.findOne({
        product: productId,
        slot: slotId,
      }).session(session);
      const prevCbm = item ? Number(item.cbm || 0) : 0;

      if (!item) {
        item = new SlotItem({
          product: productId,
          slot: slotId,
          qty: deltaValue,
        });
      } else {
        item.qty = Number(item.qty || 0) + deltaValue;
      }

      const wasNew = item.isNew;
      const saved = await item.save({ session });
      const nextCbm = Number(saved.cbm || 0);
      const deltaCbm = nextCbm - prevCbm;
      if (deltaCbm) {
        await applySlotOccupancyDelta(slotId, deltaCbm, session);
      }

      const unitCbm = getUnitCbm(deltaCbm, deltaValue);
      await logInventoryMovement(
        {
          type: "ADJUST_IN",
          product: productId,
          slot: slotId,
          qty: deltaValue,
          unitCbm: unitCbm || undefined,
          cbm: deltaCbm || undefined,
          actor: req.user?._id || null,
        },
        session
      );

      const populated = await SlotItem.findById(saved._id)
        .populate("product", "name sku")
        .populate("slot", "label store unit position")
        .session(session);

      responseData = populated || saved;
      responseStatus = wasNew ? 201 : 200;
    });
  } finally {
    session.endSession();
  }

  res.status(responseStatus).json({
    success: true,
    message: "Stock adjusted successfully.",
    data: responseData,
  });
});

/* =========================
   POST /api/slot-items/move
   Moves slot items to another slot (full or partial quantities)
   Body: { fromSlotId, toSlotId, slotItemIds } OR { fromSlotId, toSlotId, moves: [{ slotItemId, qty }] }
   ========================= */
export const moveSlotItems = asyncHandler(async (req, res) => {
  const { fromSlotId, toSlotId, slotItemIds, moves } = req.body || {};

  if (!mongoose.isValidObjectId(fromSlotId)) {
    res.status(400);
    throw new Error("Invalid source slot id.");
  }
  if (!mongoose.isValidObjectId(toSlotId)) {
    res.status(400);
    throw new Error("Invalid target slot id.");
  }
  if (String(fromSlotId) === String(toSlotId)) {
    res.status(400);
    throw new Error("Source and target slots must be different.");
  }

  const hasMoves = Array.isArray(moves) && moves.length > 0;
  const moveMap = new Map();
  let uniqueIds = [];

  if (hasMoves) {
    for (const entry of moves) {
      const itemId = String(
        entry?.slotItemId || entry?.slotItem || entry?.id || ""
      );
      const qtyValue = Number(entry?.qty);
      if (!mongoose.isValidObjectId(itemId)) {
        res.status(400);
        throw new Error("One or more slot item ids are invalid.");
      }
      if (
        !Number.isFinite(qtyValue) ||
        !Number.isInteger(qtyValue) ||
        qtyValue <= 0
      ) {
        res.status(400);
        throw new Error("Move qty must be a positive integer.");
      }
      if (moveMap.has(itemId)) {
        res.status(400);
        throw new Error("Duplicate slot item ids are not allowed.");
      }
      moveMap.set(itemId, qtyValue);
    }

    uniqueIds = Array.from(moveMap.keys());
  } else {
    if (!Array.isArray(slotItemIds) || slotItemIds.length === 0) {
      res.status(400);
      throw new Error("Provide at least one slot item to move.");
    }

    uniqueIds = Array.from(
      new Set(slotItemIds.map((value) => String(value)))
    );
    const invalidId = uniqueIds.find(
      (value) => !mongoose.isValidObjectId(value)
    );
    if (invalidId) {
      res.status(400);
      throw new Error("One or more slot item ids are invalid.");
    }
  }

  const session = await mongoose.startSession();
  let movedCount = 0;

  try {
    await session.withTransaction(async () => {
      const [fromSlot, toSlot] = await Promise.all([
        Slot.findById(fromSlotId).select("_id label").session(session),
        Slot.findById(toSlotId).select("_id label").session(session),
      ]);

      if (!fromSlot) {
        res.status(404);
        throw new Error("Source slot not found.");
      }
      if (!toSlot) {
        res.status(404);
        throw new Error("Target slot not found.");
      }

      const slotItems = await SlotItem.find({
        _id: { $in: uniqueIds },
        slot: fromSlotId,
      }).session(session);

      if (slotItems.length !== uniqueIds.length) {
        res.status(404);
        throw new Error("One or more slot items were not found.");
      }

      const productIds = Array.from(
        new Set(slotItems.map((item) => String(item.product)))
      );
      const reservedExists = await hasReservedAllocations(
        fromSlotId,
        productIds,
        session
      );
      if (reservedExists) {
        res.status(409);
        throw new Error(
          "Reserved allocations must be cleared before moving stock."
        );
      }

      const targetItems = await SlotItem.find({
        slot: toSlotId,
        product: { $in: productIds },
      }).session(session);
      const targetByProduct = new Map(
        targetItems.map((item) => [String(item.product), item])
      );
      const occupancyDeltas = new Map();
      const addDelta = (slotKey, delta) => {
        const key = String(slotKey);
        occupancyDeltas.set(key, (occupancyDeltas.get(key) || 0) + delta);
      };

      for (const item of slotItems) {
        const qtyValue = Number(item.qty) || 0;
        const itemCbm = Number(item.cbm) || 0;
        if (qtyValue <= 0 || itemCbm <= 0) {
          await item.deleteOne({ session });
          continue;
        }

        const itemId = String(item._id);
        const qtyToMove = hasMoves ? moveMap.get(itemId) : qtyValue;
        if (!Number.isFinite(qtyToMove) || qtyToMove <= 0) {
          continue;
        }
        if (qtyToMove > qtyValue) {
          res.status(400);
          throw new Error(
            "Move qty exceeds on-hand qty for one or more items."
          );
        }

        const productKey = String(item.product);
        const existingTarget = targetByProduct.get(productKey);
        const unitCbm = getUnitCbm(itemCbm, qtyValue);
        const movedCbm = unitCbm * qtyToMove;

        if (movedCbm) {
          addDelta(fromSlotId, -movedCbm);
          addDelta(toSlotId, movedCbm);
        }

        if (existingTarget) {
          existingTarget.qty = Number(existingTarget.qty || 0) + qtyToMove;
          await existingTarget.save({ session });
        } else {
          if (qtyToMove === qtyValue) {
            item.slot = toSlotId;
            await item.save({ session });
            targetByProduct.set(productKey, item);
          } else {
            const movedItem = new SlotItem({
              product: item.product,
              slot: toSlotId,
              qty: qtyToMove,
            });
            const saved = await movedItem.save({ session });
            targetByProduct.set(productKey, saved);
          }
        }

        if (qtyToMove < qtyValue) {
          item.qty = qtyValue - qtyToMove;
          await item.save({ session });
        } else if (qtyToMove === qtyValue && existingTarget) {
          await item.deleteOne({ session });
        }

        await logInventoryMovement(
          {
            type: "MOVE",
            product: item.product,
            fromSlot: fromSlotId,
            toSlot: toSlotId,
            qty: qtyToMove,
            unitCbm: unitCbm || undefined,
            cbm: movedCbm || undefined,
            actor: req.user?._id || null,
          },
          session
        );

        movedCount += 1;
      }

      for (const [slotKey, delta] of occupancyDeltas.entries()) {
        if (!delta) continue;
        await applySlotOccupancyDelta(slotKey, delta, session);
      }
    });
  } finally {
    session.endSession();
  }

  res.status(200).json({
    success: true,
    message: "Slot items moved successfully.",
    data: { moved: movedCount },
  });
});

/* =========================
   POST /api/slot-items/clear
   Deletes selected slot items from a slot
   Body: { slotId, slotItemIds }
   ========================= */
export const clearSlotItems = asyncHandler(async (req, res) => {
  const { slotId, slotItemIds } = req.body || {};

  if (!mongoose.isValidObjectId(slotId)) {
    res.status(400);
    throw new Error("Invalid slot id.");
  }
  if (!Array.isArray(slotItemIds) || slotItemIds.length === 0) {
    res.status(400);
    throw new Error("Provide at least one slot item to clear.");
  }

  const uniqueIds = Array.from(
    new Set(slotItemIds.map((value) => String(value)))
  );
  const invalidId = uniqueIds.find(
    (value) => !mongoose.isValidObjectId(value)
  );
  if (invalidId) {
    res.status(400);
    throw new Error("One or more slot item ids are invalid.");
  }

  const session = await mongoose.startSession();
  let deletedCount = 0;

  try {
    await session.withTransaction(async () => {
      const slot = await Slot.findById(slotId).select("_id").session(session);
      if (!slot) {
        res.status(404);
        throw new Error("Slot not found.");
      }

      const slotItems = await SlotItem.find({
        _id: { $in: uniqueIds },
        slot: slotId,
      }).session(session);

      if (slotItems.length !== uniqueIds.length) {
        res.status(404);
        throw new Error("One or more slot items were not found.");
      }

      const totalCbm = slotItems.reduce(
        (sum, item) => sum + (Number(item.cbm) || 0),
        0
      );
      const productIds = Array.from(
        new Set(slotItems.map((item) => String(item.product)))
      );
      const reservedExists = await hasReservedAllocations(
        slotId,
        productIds,
        session
      );
      if (reservedExists) {
        res.status(409);
        throw new Error(
          "Reserved allocations must be cleared before clearing stock."
        );
      }

      for (const item of slotItems) {
        const qtyValue = Number(item.qty) || 0;
        if (qtyValue <= 0) continue;
        const itemCbm = Number(item.cbm) || 0;
        const unitCbm = getUnitCbm(itemCbm, qtyValue);
        await logInventoryMovement(
          {
            type: "ADJUST_OUT",
            product: item.product,
            slot: slotId,
            qty: qtyValue,
            unitCbm: unitCbm || undefined,
            cbm: itemCbm || undefined,
            actor: req.user?._id || null,
          },
          session
        );
      }

      const result = await SlotItem.deleteMany({
        _id: { $in: uniqueIds },
        slot: slotId,
      }).session(session);

      deletedCount = result?.deletedCount || 0;
      if (totalCbm) {
        await applySlotOccupancyDelta(slotId, -totalCbm, session);
      }
    });
  } finally {
    session.endSession();
  }

  res.status(200).json({
    success: true,
    message: "Slot items cleared successfully.",
    data: { deleted: deletedCount },
  });
});
