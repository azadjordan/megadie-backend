import mongoose from "mongoose";

const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  startedAt: { type: Date, required: true },
  lastActivityAt: { type: Date, required: true },
  idleExpiresAt: { type: Date, required: true },
  absoluteExpiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
}, { versionKey: false });

// Cleanup is asynchronous; authentication always checks deadlines itself.
schema.index({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0 });
export default mongoose.models.AdminSession || mongoose.model("AdminSession", schema);
