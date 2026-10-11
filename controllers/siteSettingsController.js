import SiteSettings from "../models/siteSettingsModel.js";
import asyncHandler from "../middleware/asyncHandler.js";

export const MAINTENANCE_MESSAGE = "We’re carrying out temporary maintenance. Please contact us to confirm stock availability during this time.";

const publicNotice = settings => ({
  enabled: settings?.maintenanceNoticeEnabled === true,
  message: MAINTENANCE_MESSAGE,
});
const adminNotice = settings => ({
  ...publicNotice(settings),
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
  if (typeof req.body?.enabled !== "boolean") {
    res.status(400);
    throw new Error("enabled must be true or false.");
  }
  const settings = await SiteSettings.findByIdAndUpdate("site", {
    $set: {
      maintenanceNoticeEnabled: req.body.enabled,
      noticeUpdatedBy: req.user._id,
      noticeUpdatedAt: new Date(),
    },
  }, { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true })
    .populate("noticeUpdatedBy", "name").lean();
  res.json({ data: adminNotice(settings) });
});
