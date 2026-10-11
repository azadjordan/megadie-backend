import mongoose from "mongoose";

const schema = new mongoose.Schema({
  _id: { type: String, default: "site" },
  maintenanceNoticeEnabled: { type: Boolean, default: false },
  noticeUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  noticeUpdatedAt: Date,
}, { timestamps: true });

export default mongoose.models.SiteSettings || mongoose.model("SiteSettings", schema);
