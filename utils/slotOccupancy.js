import Slot from "../models/slotModel.js";

export const computeFillPercent = (capacityCbm, occupiedCbm) => {
  const capacity = Number(capacityCbm) || 0;
  const occupied = Number(occupiedCbm) || 0;
  if (capacity <= 0) return 0;
  const percent = (occupied / capacity) * 100;
  return Math.max(0, percent);
};

export const applySlotOccupancyDelta = async (
  slotId,
  deltaCbm,
  session = null
) => {
  const delta = Number(deltaCbm) || 0;
  if (!delta) return null;

  const slotQuery = Slot.findById(slotId).select("cbm occupiedCbm fillPercent");
  if (session) {
    slotQuery.session(session);
  }
  const slot = await slotQuery;
  if (!slot) {
    throw new Error("Slot not found.");
  }

  const current = Number(slot.occupiedCbm) || 0;
  const next = Math.max(0, current + delta);
  slot.occupiedCbm = next;
  slot.fillPercent = computeFillPercent(slot.cbm, next);
  await slot.save({ session });
  return slot;
};

export const setSlotOccupancy = async (slotId, occupiedCbm, session = null) => {
  const slotQuery = Slot.findById(slotId).select("cbm occupiedCbm fillPercent");
  if (session) {
    slotQuery.session(session);
  }
  const slot = await slotQuery;
  if (!slot) {
    throw new Error("Slot not found.");
  }

  const next = Math.max(0, Number(occupiedCbm) || 0);
  slot.occupiedCbm = next;
  slot.fillPercent = computeFillPercent(slot.cbm, next);
  await slot.save({ session });
  return slot;
};
