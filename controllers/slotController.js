// controllers/slotController.js
import asyncHandler from "../middleware/asyncHandler.js";
import Slot from "../models/slotModel.js";

/* =========================
   GET /api/slots
   Private/Admin
   Filters: store, unit, isActive, q
   Pagination: page, limit
   ========================= */
export const getSlots = asyncHandler(async (req, res) => {
  const { store, unit, isActive, q, page = 1, limit = 50 } = req.query;

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

  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const perPage = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

  const total = await Slot.countDocuments(filter);
  const data = await Slot.find(filter)
    .sort({ store: 1, unit: 1, position: 1 })
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


