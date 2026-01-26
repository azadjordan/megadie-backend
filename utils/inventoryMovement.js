// utils/inventoryMovement.js
import InventoryMovement from "../models/inventoryMovementModel.js";

export const getUnitCbm = (totalCbm, qty) => {
  const q = Number(qty) || 0;
  if (!q) return 0;
  const t = Number(totalCbm) || 0;
  return Math.max(0, t / q);
};

export const logInventoryMovement = async (payload, session = null) => {
  if (!payload) return null;

  const data = { ...payload };
  const qty = Number(data.qty);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  data.qty = qty;

  if (!data.eventAt) data.eventAt = new Date();

  if (typeof data.note === "string") {
    data.note = data.note.trim();
    if (!data.note) delete data.note;
  }

  if (typeof data.unitCbm === "number" && !Number.isFinite(data.unitCbm)) {
    delete data.unitCbm;
  }

  if (typeof data.cbm === "number") {
    if (!Number.isFinite(data.cbm)) {
      delete data.cbm;
    } else {
      data.cbm = Math.max(0, data.cbm);
    }
  } else if (typeof data.unitCbm === "number") {
    data.cbm = Math.max(0, data.unitCbm * qty);
  }

  const options = session ? { session } : undefined;
  const [doc] = await InventoryMovement.create([data], options);
  return doc || null;
};
