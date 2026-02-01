// controllers/userController.js
import asyncHandler from "../middleware/asyncHandler.js";
import User from "../models/userModel.js";
import Order from "../models/orderModel.js";
import Invoice from "../models/invoiceModel.js";
import Quote from "../models/quoteModel.js";
import generateToken from "../utils/generateToken.js";
import sendTelegramAlert from "../utils/sendTelegramAlert.js";

// Forgot password (Resend)
import crypto from "crypto";
import sendTransactionalEmail from "../utils/sendTransactionalEmail.js";

/* =========================
   Helpers
   ========================= */
function toInt(v, fallback) {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function escapeRegex(text = "") {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeTelegramMarkdown(text = "") {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/_/g, "\\_")
    .replace(/\*/g, "\\*")
    .replace(/\[/g, "\\[")
    .replace(/]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/`/g, "\\`");
}

function applyApprovalStatus(user, nextStatus, actorId) {
  if (!["Pending", "Approved", "Rejected"].includes(nextStatus)) {
    throw new Error("Invalid approval status.");
  }

  user.approvalStatus = nextStatus;

  if (nextStatus === "Approved") {
    user.approvedAt = new Date();
    user.approvedBy = actorId || user.approvedBy;
    user.rejectedAt = null;
    user.rejectedBy = null;
    return;
  }

  if (nextStatus === "Rejected") {
    user.rejectedAt = new Date();
    user.rejectedBy = actorId || user.rejectedBy;
    user.approvedAt = null;
    user.approvedBy = null;
    return;
  }

  user.approvedAt = null;
  user.approvedBy = null;
  user.rejectedAt = null;
  user.rejectedBy = null;
}

const USER_SORT_MAP = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  name: { name: 1, createdAt: -1 },
};

/* =========================
   POST /api/users/auth
   Public — Authenticate user
   ========================= */
export const authUser = asyncHandler(async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const { password } = req.body;

  const user = await User.findOne({ email });
  if (user && (await user.matchPassword(password))) {
    if (!user.isAdmin && user.approvalStatus === "Rejected") {
      res.status(403);
      throw new Error("Your account was rejected. Contact support.");
    }
    generateToken(res, user._id);
    return res.status(200).json({
      success: true,
      message: "Login successful.",
      data: {
        _id: user._id,
        name: user.name,
        phoneNumber: user.phoneNumber,
        email: user.email,
        isAdmin: user.isAdmin,
        address: user.address,
        approvalStatus: user.approvalStatus,
      },
    });
  }

  res.status(401);
  throw new Error("Invalid email or password.");
});

/* =========================
   POST /api/users/logout
   Public — Logout user
   ========================= */
export const logoutUser = asyncHandler(async (req, res) => {
  const isProd = process.env.NODE_ENV === "production";

  res.clearCookie("jwt", {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/",
  });

  return res.status(200).json({
    success: true,
    message: "Logged out successfully.",
  });
});

/* =========================
   POST /api/users
   Public — Register new user
   ========================= */
export const registerUser = asyncHandler(async (req, res) => {
  const name = (req.body.name || "").trim();
  const phoneNumber = (req.body.phoneNumber || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  const { password } = req.body;

  if (!phoneNumber) {
    res.status(400);
    throw new Error("Phone number is required.");
  }

  const userByEmail = await User.findOne({ email }).select("_id").lean();
  if (userByEmail) {
    res.status(409);
    throw new Error(
      "An account with this email already exists. Try signing in or resetting your password."
    );
  }

  const userByPhone = await User.findOne({ phoneNumber }).select("_id").lean();
  if (userByPhone) {
    res.status(409);
    throw new Error(
      "This phone number is already registered. Use a different number or contact support."
    );
  }

  let user;
  try {
    user = await User.create({
      name,
      phoneNumber,
      email,
      password,
      approvalStatus: "Pending",
    });
  } catch (err) {
    if (err?.code === 11000) {
      res.status(409);
      if (err?.keyPattern?.email) {
        throw new Error(
          "An account with this email already exists. Try signing in or resetting your password."
        );
      }
      if (err?.keyPattern?.phoneNumber) {
        throw new Error(
          "This phone number is already registered. Use a different number or contact support."
        );
      }
      throw new Error("Duplicate user details.");
    }
    throw err;
  }

  if (!user) {
    res.status(400);
    throw new Error("Invalid user data.");
  }

  const messageLines = ["⚪ New user registration"];
  const addLine = (label, value) => {
    const cleaned = String(value || "").trim();
    if (!cleaned) return;
    messageLines.push(`${label}: ${escapeTelegramMarkdown(cleaned)}`);
  };

  addLine("Name", user.name);
  addLine("Email", user.email);
  addLine("Phone", user.phoneNumber);
  addLine("Approval", user.approvalStatus || "Pending");

  const frontendBaseUrl = String(
    process.env.FRONTEND_URL || "https://www.megadie.com"
  ).replace(/\/$/, "");
  const userUrl = `${frontendBaseUrl}/admin/users/${user._id}/edit`;
  messageLines.push("");
  messageLines.push(userUrl);

  void sendTelegramAlert(messageLines.join("\n"));

  return res.status(201).json({
    success: true,
    message: "Registration submitted. Await admin approval.",
    data: {
      _id: user._id,
      name: user.name,
      phoneNumber: user.phoneNumber,
      email: user.email,
      isAdmin: user.isAdmin,
      approvalStatus: user.approvalStatus,
    },
  });
});

/* =========================
   POST /api/users/forgot-password
   Public — Email reset link
   ========================= */
export const forgotPassword = asyncHandler(async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();

  const genericResponse = {
    success: true,
    message: "If you are a registered user, a password reset link has been sent.",
  };

  if (!email) return res.status(200).json(genericResponse);

  const user = await User.findOne({ email });
  if (!user) return res.status(200).json(genericResponse);

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expires = new Date(Date.now() + 1000 * 60 * 30);

  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
  const resetUrl = `${frontendUrl}/reset-password/${rawToken}`;

  try {
    await sendTransactionalEmail({
      to: user.email,
      subject: "Reset your Megadie password",
      text:
        `You requested a password reset.\n\n` +
        `Copy/paste this link into your browser:\n${resetUrl}\n\n` +
        `This link expires in 30 minutes.\n\n` +
        `If you didn't request this, you can ignore this email.`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6;">
          <p>You requested a password reset.</p>
          <p><strong>Copy/paste this link into your browser:</strong></p>
          <p style="word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;">
            ${resetUrl}
          </p>
          <p style="color:#666;">This link expires in 30 minutes.</p>
          <p style="color:#666;">If you didn’t request this, you can ignore this email.</p>
        </div>
      `,
    });

    // Only overwrite token AFTER successful send
    user.passwordResetTokenHash = tokenHash;
    user.passwordResetExpires = expires;
    await user.save();
  } catch (err) {
    console.error("Forgot-password email failed", { email: user.email, err });
    // Do not save new token — keeps previous link valid
  }

  return res.status(200).json(genericResponse);
});

/* =========================
   POST /api/users/reset-password/:token
   Public — Reset password
   ========================= */
export const resetPassword = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  if (!token) {
    res.status(400);
    throw new Error("Reset token is required.");
  }

  if (!password || String(password).length < 6) {
    res.status(400);
    throw new Error("Password must be at least 6 characters.");
  }

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const user = await User.findOne({
    passwordResetTokenHash: tokenHash,
    passwordResetExpires: { $gt: new Date() },
  });

  if (!user) {
    res.status(400);
    throw new Error("Reset token is invalid or expired.");
  }

  // Update password (pre-save hook hashes it)
  user.password = password;

  // Clear reset fields
  user.passwordResetTokenHash = undefined;
  user.passwordResetExpires = undefined;

  await user.save();

  // Optional: auto-login after reset
  generateToken(res, user._id);

  return res.status(200).json({
    success: true,
    message: "Password reset successful.",
  });
});

/* =========================
   GET /api/users/account/profile
   Private — Get my profile
   ========================= */
export const getUserProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);

  if (!user) {
    res.status(404);
    throw new Error("User not found.");
  }

  return res.status(200).json({
    success: true,
    message: "Profile retrieved successfully.",
    data: {
      _id: user._id,
      name: user.name,
      email: user.email,
      phoneNumber: user.phoneNumber,
      address: user.address,
      isAdmin: user.isAdmin,
      approvalStatus: user.approvalStatus,
    },
  });
});

/* =========================
   PUT /api/users/account/profile
   Private — Update my profile
   ========================= */
export const updateUserProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);

  if (!user) {
    res.status(404);
    throw new Error("User not found.");
  }

  user.name = req.body.name ?? user.name;
  user.phoneNumber = req.body.phoneNumber ?? user.phoneNumber;
  user.address = req.body.address ?? user.address;

  const updatedUser = await user.save();

  return res.status(200).json({
    success: true,
    message: "Profile updated successfully.",
    data: {
      _id: updatedUser._id,
      name: updatedUser.name,
      email: updatedUser.email,
      phoneNumber: updatedUser.phoneNumber,
      address: updatedUser.address,
      isAdmin: updatedUser.isAdmin,
      approvalStatus: updatedUser.approvalStatus,
    },
  });
});

/* =========================
   GET /api/users
   Private/Admin — Get all users
   ========================= */
export const getUsers = asyncHandler(async (req, res) => {
  const page = Math.max(1, toInt(req.query.page, 1));
  const limitRaw = toInt(req.query.limit, 5);
  const limit = Math.min(Math.max(1, limitRaw), 100);
  const skip = (page - 1) * limit;

  const search = req.query.search ? String(req.query.search).trim() : "";
  const role = req.query.role ? String(req.query.role) : "all";
  const approvalStatus = req.query.approvalStatus
    ? String(req.query.approvalStatus)
    : "all";
  const sortKey = req.query.sort ? String(req.query.sort) : "newest";
  const sort = USER_SORT_MAP[sortKey] || USER_SORT_MAP.newest;

  const filter = {};
  const andFilters = [];
  if (role === "admin") filter.isAdmin = true;
  if (role === "user") filter.isAdmin = false;

  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    andFilters.push({
      $or: [{ name: regex }, { email: regex }, { phoneNumber: regex }],
    });
  }

  if (approvalStatus !== "all") {
    if (!["Pending", "Approved", "Rejected"].includes(approvalStatus)) {
      res.status(400);
      throw new Error("Invalid approvalStatus filter.");
    }
    if (approvalStatus === "Approved") {
      andFilters.push({
        $or: [
          { approvalStatus: "Approved" },
          { approvalStatus: { $exists: false } },
        ],
      });
    } else {
      andFilters.push({ approvalStatus });
    }
  }

  if (andFilters.length) {
    filter.$and = andFilters;
  }

  const [total, usersRaw] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter)
      .select("name email phoneNumber address isAdmin approvalStatus createdAt")
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  let users = usersRaw;
  if (users.length) {
    const userIds = users.map((u) => u._id);
    const [orderAgg, invoiceAgg, quoteAgg] = await Promise.all([
      Order.aggregate([
        { $match: { user: { $in: userIds } } },
        { $group: { _id: "$user", count: { $sum: 1 } } },
      ]),
      Invoice.aggregate([
        { $match: { user: { $in: userIds } } },
        { $group: { _id: "$user", count: { $sum: 1 } } },
      ]),
      Quote.aggregate([
        { $match: { user: { $in: userIds } } },
        { $group: { _id: "$user", count: { $sum: 1 } } },
      ]),
    ]);

    const orderMap = new Map(orderAgg.map((row) => [String(row._id), row.count]));
    const invoiceMap = new Map(
      invoiceAgg.map((row) => [String(row._id), row.count])
    );
    const quoteMap = new Map(quoteAgg.map((row) => [String(row._id), row.count]));

    users = users.map((u) => {
      const id = String(u._id);
      const ordersCount = orderMap.get(id) || 0;
      const invoicesCount = invoiceMap.get(id) || 0;
      const requestsCount = quoteMap.get(id) || 0;
      const hasLinked =
        ordersCount > 0 || invoicesCount > 0 || requestsCount > 0;
      const approval = u.approvalStatus || "Approved";
      return {
        ...u,
        linkCounts: {
          orders: ordersCount,
          invoices: invoicesCount,
          requests: requestsCount,
        },
        canDelete: !u.isAdmin && approval === "Rejected" && !hasLinked,
      };
    });
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  res.status(200).json({
    success: true,
    message: "Users retrieved successfully.",
    page,
    pages: totalPages,
    total,
    limit,
    items: users,
    data: users,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasPrev: page > 1,
      hasNext: page < totalPages,
    },
  });
});

/* =========================
   GET /api/users/:id
   Private/Admin — Get user by ID
   ========================= */
export const getUserById = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select("-password");

  if (!user) {
    res.status(404);
    throw new Error("User not found.");
  }

  return res.status(200).json({
    success: true,
    message: "User retrieved successfully.",
    data: user,
  });
});

/* =========================
   DELETE /api/users/:id
   Private/Admin — Delete user
   ========================= */
export const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    res.status(404);
    throw new Error("User not found.");
  }

  if (user.isAdmin) {
    res.status(400);
    throw new Error("Cannot delete admin user.");
  }

  const approval = user.approvalStatus || "Approved";
  if (approval !== "Rejected") {
    res.status(400);
    throw new Error("Only rejected users can be deleted.");
  }

  const [hasOrder, hasInvoice, hasQuote] = await Promise.all([
    Order.exists({ user: user._id }),
    Invoice.exists({ user: user._id }),
    Quote.exists({ user: user._id }),
  ]);

  if (hasOrder || hasInvoice || hasQuote) {
    res.status(400);
    throw new Error("Cannot delete user with linked orders, invoices, or requests.");
  }

  await User.deleteOne({ _id: user._id });

  return res.status(200).json({
    success: true,
    message: "User deleted successfully.",
    data: { _id: user._id, email: user.email },
  });
});

/* =========================
   PUT /api/users/:id
   Private/Admin — Update user
   ========================= */
export const updateUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    res.status(404);
    throw new Error("User not found.");
  }

  if (req.body.name != null) user.name = req.body.name;
  if (req.body.email != null) user.email = req.body.email.trim().toLowerCase();
  if (req.body.phoneNumber != null) user.phoneNumber = req.body.phoneNumber;
  if (req.body.address != null) user.address = req.body.address;
  if (req.body.isAdmin != null) user.isAdmin = Boolean(req.body.isAdmin);

  if (req.body.approvalStatus != null) {
    const nextStatus = String(req.body.approvalStatus);
    try {
      applyApprovalStatus(user, nextStatus, req.user?._id);
    } catch (err) {
      res.status(400);
      throw err;
    }
  }

  if (user.isAdmin) {
    user.approvalStatus = "Approved";
    if (!user.approvedAt) user.approvedAt = new Date();
  }

  try {
    const updatedUser = await user.save();
    return res.status(200).json({
      success: true,
      message: "User updated successfully.",
      data: {
        _id: updatedUser._id,
        name: updatedUser.name,
        email: updatedUser.email,
        phoneNumber: updatedUser.phoneNumber,
        address: updatedUser.address,
        isAdmin: updatedUser.isAdmin,
        approvalStatus: updatedUser.approvalStatus,
      },
    });
  } catch (err) {
    if (err.code === 11000 && err.keyPattern?.email) {
      res.status(409);
      throw new Error("Email already in use.");
    }
    throw err;
  }
});

/* =========================
   PUT /api/users/:id/approval
   Private/Admin – Update user approval status
   ========================= */
export const updateUserApprovalStatus = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    res.status(404);
    throw new Error("User not found.");
  }

  const nextStatus = String(req.body?.approvalStatus || "");
  if (!nextStatus) {
    res.status(400);
    throw new Error("Approval status is required.");
  }

  if (user.isAdmin) {
    user.approvalStatus = "Approved";
    if (!user.approvedAt) user.approvedAt = new Date();
  } else {
    try {
      applyApprovalStatus(user, nextStatus, req.user?._id);
    } catch (err) {
      res.status(400);
      throw err;
    }
  }

  const updatedUser = await user.save();

  return res.status(200).json({
    success: true,
    message: "Approval status updated successfully.",
    data: {
      _id: updatedUser._id,
      approvalStatus: updatedUser.approvalStatus,
      approvedAt: updatedUser.approvedAt,
      rejectedAt: updatedUser.rejectedAt,
    },
  });
});

/* =========================
   PUT /api/users/:id/password
   Private/Admin — Update user password
   ========================= */
export const updateUserPasswordByAdmin = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    res.status(404);
    throw new Error("User not found.");
  }

  const password = String(req.body?.password || "");
  if (password.length < 6) {
    res.status(400);
    throw new Error("Password must be at least 6 characters.");
  }

  user.password = password;
  user.passwordResetTokenHash = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  return res.status(200).json({
    success: true,
    message: "Password updated successfully.",
  });
});

