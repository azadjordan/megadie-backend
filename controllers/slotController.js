// controllers/slotController.js
import asyncHandler from "../middleware/asyncHandler.js";
import Slot from "../models/slotModel.js";
import SlotItem from "../models/slotItemModel.js";
import { SLOT_UNITS } from "../constants.js";
import { computeFillPercent } from "../utils/slotOccupancy.js";

/* =========================
   GET /api/slots
   Private/Admin
   Filters: store, unit, isActive, q
   Pagination: page, limit
   ========================= */
export const getSlots = asyncHandler(async (req, res) => {
  const {
    store,
    unit,
    isActive,
    q,
    sort,
    order,
    page = 1,
    limit = 50,
  } = req.query;

  const filter = {};
  if (store) filter.store = String(store).trim();
  if (unit) filter.unit = String(unit).trim();
  if (typeof isActive !== "undefined") {
    filter.isActive = String(isActive).toLowerCase() === "true";
  }
  if (q && q.trim()) {
    const regex = { $regex: q.trim(), $options: "i" };
    filter.$or = [{ label: regex }, { store: regex }, { unit: regex }, { notes: regex }];
  }

  const allowedSorts = new Set(["occupiedCbm", "fillPercent"]);
  const sortField = allowedSorts.has(sort) ? sort : null;
  const sortDir = String(order).toLowerCase() === "asc" ? 1 : -1;
  const sortSpec = sortField
    ? { [sortField]: sortDir, store: 1, unit: 1, position: 1 }
    : { store: 1, unit: 1, position: 1 };

  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const perPage = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

  const total = await Slot.countDocuments(filter);
  const data = await Slot.find(filter)
    .sort(sortSpec)
    .skip((pageNum - 1) * perPage)
    .limit(perPage);

  res.status(200).json({
    success: true,
    message: "Slots retrieved successfully.",
    page: pageNum,
    pages: Math.ceil(total / perPage) || 1,
    limit: perPage,
    total,
    data,
  });
});

/* =========================
   GET /api/slots/summary
   Private/Admin
   Summary counts for slots
   ========================= */
export const getSlotSummary = asyncHandler(async (req, res) => {
  const { store, unit, isActive, q } = req.query;

  const filter = {};
  if (store) filter.store = String(store).trim();
  if (unit) filter.unit = String(unit).trim();
  if (typeof isActive !== "undefined") {
    filter.isActive = String(isActive).toLowerCase() === "true";
  }
  if (q && q.trim()) {
    const regex = { $regex: q.trim(), $options: "i" };
    filter.$or = [{ label: regex }, { store: regex }, { unit: regex }, { notes: regex }];
  }

  const totalSlots = await Slot.countDocuments(filter);
  let inactiveSlots = 0;
  if (Object.prototype.hasOwnProperty.call(filter, "isActive")) {
    inactiveSlots = filter.isActive === false ? totalSlots : 0;
  } else {
    inactiveSlots = await Slot.countDocuments({ ...filter, isActive: false });
  }
  const storesFilteredRaw = await Slot.distinct("store", filter);
  const storesFiltered = storesFilteredRaw
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const storesRaw = await Slot.distinct("store");
  const stores = storesRaw
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  res.status(200).json({
    success: true,
    message: "Slot summary retrieved successfully.",
    data: {
      totalSlots,
      inactiveSlots,
      storesCount: storesFiltered.length,
      stores,
      units: SLOT_UNITS,
    },
  });
});

/* =========================
   POST /api/slots/occupancy/rebuild
   Private/Admin
   Optional query: store
   ========================= */
export const rebuildSlotOccupancy = asyncHandler(async (req, res) => {
  const store = req.query.store ? String(req.query.store).trim() : "";
  const filter = {};
  if (store) filter.store = store;

  const slots = await Slot.find(filter).select("_id cbm").lean();
  if (!slots.length) {
    res.status(200).json({
      success: true,
      message: "No slots found to rebuild.",
      data: { updated: 0, store: store || null },
    });
    return;
  }

  const slotIds = slots.map((slot) => slot._id);
  const occRows = await SlotItem.aggregate([
    { $match: { slot: { $in: slotIds } } },
    { $group: { _id: "$slot", occupiedCbm: { $sum: "$cbm" } } },
  ]);
  const occBySlot = new Map(
    occRows.map((row) => [String(row._id), row.occupiedCbm || 0])
  );

  const updates = slots.map((slot) => {
    const occupied = occBySlot.get(String(slot._id)) || 0;
    const fillPercent = computeFillPercent(slot.cbm, occupied);
    return {
      updateOne: {
        filter: { _id: slot._id },
        update: { $set: { occupiedCbm: occupied, fillPercent } },
      },
    };
  });

  if (updates.length) {
    await Slot.bulkWrite(updates);
  }

  res.status(200).json({
    success: true,
    message: "Slot occupancy rebuilt successfully.",
    data: { updated: updates.length, store: store || null },
  });
});

/* =========================
   GET /api/slots/:id
   Private/Admin
   ========================= */
export const getSlotById = asyncHandler(async (req, res) => {
  const slot = await Slot.findById(req.params.id);
  if (!slot) {
    res.status(404);
    throw new Error("Slot not found.");
  }
  res.status(200).json({ success: true, message: "Slot retrieved successfully.", data: slot });
});

/* =========================
   POST /api/slots
   Private/Admin
   Body:
     - store (string, required)
     - unit (string, required)
     - position (number, required)
     - cbm (number, required)
     - isActive (boolean, optional)
     - notes (string, optional)
   ========================= */
export const createSlot = asyncHandler(async (req, res) => {
  const { store, unit, position, cbm, isActive, notes } = req.body || {};
  if (!store || !unit || typeof position === "undefined" || typeof cbm === "undefined") {
    res.status(400);
    throw new Error("store, unit, position, and cbm are required.");
  }

  const slot = await Slot.create({
    store: String(store).trim(),
    unit: String(unit).trim(),
    position: Number(position),
    cbm: Number(cbm),
    isActive: typeof isActive === "boolean" ? isActive : true,
    notes: typeof notes === "string" ? notes.trim() : undefined,
  });

  res.status(201).json({ success: true, message: "Slot created successfully.", data: slot });
});

/* =========================
   PUT /api/slots/:id
   Private/Admin
   ========================= */
export const updateSlot = asyncHandler(async (req, res) => {
  const { store, unit, position, cbm, isActive, notes } = req.body || {};
  const slot = await Slot.findById(req.params.id);
  if (!slot) {
    res.status(404);
    throw new Error("Slot not found.");
  }

  const changes = {};
  if (typeof store !== "undefined" && store.trim() !== slot.store) {
    changes.store = { from: slot.store, to: store.trim() }; slot.store = store.trim();
  }
  if (typeof unit !== "undefined" && unit.trim() !== slot.unit) {
    changes.unit = { from: slot.unit, to: unit.trim() }; slot.unit = unit.trim();
  }
  if (typeof position !== "undefined" && Number(position) !== slot.position) {
    changes.position = { from: slot.position, to: Number(position) }; slot.position = Number(position);
  }
  if (typeof cbm !== "undefined" && Number(cbm) !== slot.cbm) {
    changes.cbm = { from: slot.cbm, to: Number(cbm) }; slot.cbm = Number(cbm);
  }
  if (typeof isActive !== "undefined" && !!isActive !== slot.isActive) {
    changes.isActive = { from: slot.isActive, to: !!isActive }; slot.isActive = !!isActive;
  }
  if (typeof notes !== "undefined" && notes !== slot.notes) {
    changes.notes = { from: slot.notes, to: notes }; slot.notes = notes?.trim();
  }

  const updated = await slot.save();
  const changedKeys = Object.keys(changes);
  const message = changedKeys.length
    ? `Slot updated successfully (${changedKeys.join(", ")}).`
    : "Slot saved (no changes detected).";

  res.status(200).json({ success: true, message, changed: changes, data: updated });
});

/* =========================
   DELETE /api/slots/:id
   Private/Admin
   ========================= */
export const deleteSlot = asyncHandler(async (req, res) => {
  const slot = await Slot.findById(req.params.id);
  if (!slot) {
    res.status(404);
    throw new Error("Slot not found.");
  }
  await slot.deleteOne();
  res.status(200).json({ success: true, message: `Slot '${slot.label}' deleted successfully.`, slotId: slot._id });
});


