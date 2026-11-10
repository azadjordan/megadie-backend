import mongoose from "mongoose";
import { MAINTENANCE_MESSAGE, MAINTENANCE_MESSAGE_MAX_LENGTH } from "../utils/maintenanceNotice.js";

const schema = new mongoose.Schema({
  _id: { type: String, default: "site" },
  maintenanceNoticeEnabled: { type: Boolean, default: false },
  maintenanceNoticeMessage: { type: String, trim: true, required: true, maxlength: MAINTENANCE_MESSAGE_MAX_LENGTH, default: MAINTENANCE_MESSAGE },
  noticeUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  noticeUpdatedAt: Date,
}, { timestamps: true });

export default mongoose.models.SiteSettings || mongoose.model("SiteSettings", schema);
