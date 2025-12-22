// controllers/userController.js
import asyncHandler from "../middleware/asyncHandler.js";
import User from "../models/userModel.js";
import generateToken from "../utils/generateToken.js";

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
      },
    });
  }

  res.status(401);
  throw new Error("Invalid credentials.");
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
    sameSite: "lax",
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

  const userExists = await User.findOne({ email });
  if (userExists) {
    res.status(409);
    throw new Error("Email already registered.");
  }

  const user = await User.create({ name, phoneNumber, email, password });

  if (!user) {
    res.status(400);
    throw new Error("Invalid user data.");
  }

  generateToken(res, user._id);
  return res.status(201).json({
    success: true,
    message: "User registered successfully.",
    data: {
      _id: user._id,
      name: user.name,
      phoneNumber: user.phoneNumber,
      email: user.email,
      isAdmin: user.isAdmin,
    },
  });
});

/* =========================
   POST /api/users/forgot-password
   Public — Email reset link
   ========================= */
export const forgotPassword = asyncHandler(async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();

  // Always respond the same to avoid revealing if an account exists
  const genericResponse = {
    success: true,
    message:
      "If you are a registered user, a password reset link has been sent.",
  };

  if (!email) return res.status(200).json(genericResponse);

  const user = await User.findOne({ email });
  if (!user) return res.status(200).json(genericResponse);

  // Generate raw token for URL, store only hash in DB
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  user.passwordResetTokenHash = tokenHash;
  user.passwordResetExpires = new Date(Date.now() + 1000 * 60 * 30); // 30 mins
  await user.save();

  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5173").replace(
    /\/$/,
    ""
  );
  const resetUrl = `${frontendUrl}/reset-password/${rawToken}`;

  // IMPORTANT:
  // - Avoid clickable <a href="..."> to reduce Resend click-tracking redirects (resend-clicks.com)
  // - Use copy/paste URL instead (still works great, fewer Gmail warnings)
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
  const limit = Math.min(Math.max(1, limitRaw), 5);
  const skip = (page - 1) * limit;

  const search = req.query.search ? String(req.query.search).trim() : "";
  const role = req.query.role ? String(req.query.role) : "all";
  const sortKey = req.query.sort ? String(req.query.sort) : "name";
  const sort = USER_SORT_MAP[sortKey] || USER_SORT_MAP.newest;

  const filter = {};
  if (role === "admin") filter.isAdmin = true;
  if (role === "user") filter.isAdmin = false;

  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    filter.$or = [
      { name: regex },
      { email: regex },
      { phoneNumber: regex },
    ];
  }

  const [total, users] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter)
      .select("name email phoneNumber address isAdmin createdAt")
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

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
