import mongoose from 'mongoose';

// Company-owned work receipts, independent of mutable assignments and orders.
// Never store destinations, phone numbers, prices, notes or stock locations here.
const schema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, required: true },
  type: { type: String, enum: ['packed', 'delivered'], required: true },
  worker: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  completedAt: { type: Date, required: true },
  sourceKey: { type: String, required: true, unique: true },
  legacy: { type: Boolean, default: false },
  orderRevision: { type: Number, default: 0 },
  orderNumber: { type: String, required: true },
  customerName: { type: String, required: true },
  label: { type: String, required: true },
  items: { type: [{ sku: String, name: String, qty: Number, unit: String }], default: [], _id: false },
  active: { type: Boolean, default: true },
  voidedAt: Date,
  voidReason: { type: String, enum: ['reopened', 'delivery_corrected', 'reshelved'] },
}, { timestamps: true });
schema.index({ worker: 1, completedAt: -1 });
schema.index({ order: 1, type: 1 }, { unique: true, partialFilterExpression: { active: true } });
export default mongoose.model('WorkerWork', schema);
