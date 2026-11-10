import SiteSettings from "../models/siteSettingsModel.js";
import asyncHandler from "../middleware/asyncHandler.js";
import { MAINTENANCE_MESSAGE, normalizeNoticeMessage } from "../utils/maintenanceNotice.js";

export { MAINTENANCE_MESSAGE } from "../utils/maintenanceNotice.js";

const noticeState = settings => ({
  enabled: settings?.maintenanceNoticeEnabled === true,
  message: settings?.maintenanceNoticeMessage || MAINTENANCE_MESSAGE,
});
const publicNotice = settings => {
  const notice = noticeState(settings);
  return { ...notice, message: notice.enabled ? notice.message : MAINTENANCE_MESSAGE };
};
const adminNotice = settings => ({
  ...noticeState(settings),
  updatedAt: settings?.noticeUpdatedAt || null,
  updatedBy: settings?.noticeUpdatedBy?.name || null,
});

export const getMaintenanceNotice = asyncHandler(async (_req, res) => {
  const settings = await SiteSettings.findById("site").lean();
  res.json({ data: publicNotice(settings) });
});

export const getAdminMaintenanceNotice = asyncHandler(async (_req, res) => {
  const settings = await SiteSettings.findById("site").populate("noticeUpdatedBy", "name").lean();
  res.json({ data: adminNotice(settings) });
});

export const updateMaintenanceNotice = asyncHandler(async (req, res) => {
  const hasEnabled = Object.hasOwn(req.body || {}, "enabled");
  const hasMessage = Object.hasOwn(req.body || {}, "message");
  if (!hasEnabled && !hasMessage) {
    res.status(400);
    throw new Error("Provide a notice message or visibility change.");
  }
  if (hasEnabled && typeof req.body.enabled !== "boolean") {
    res.status(400);
    throw new Error("enabled must be true or false.");
  }
  let message;
  if (hasMessage) {
    try { message = normalizeNoticeMessage(req.body.message); }
    catch (error) { res.status(400); throw error; }
  }
  const settings = await SiteSettings.findByIdAndUpdate("site", {
    $set: {
      ...(hasEnabled ? { maintenanceNoticeEnabled: req.body.enabled } : {}),
      ...(hasMessage ? { maintenanceNoticeMessage: message } : {}),
      noticeUpdatedBy: req.user._id,
      noticeUpdatedAt: new Date(),
    },
  }, { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true })
    .populate("noticeUpdatedBy", "name").lean();
  res.json({ data: adminNotice(settings) });
});
