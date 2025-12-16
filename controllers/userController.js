// controllers/userController.js
import asyncHandler from "../middleware/asyncHandler.js";
import User from "../models/userModel.js";
import generateToken from "../utils/generateToken.js";

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
export const getUsers = asyncHandler(async (_req, res) => {
  const users = await User.find({}).select("-password").lean();
  res.status(200).json({
    success: true,
    message: "Users retrieved successfully.",
    total: users.length,
    data: users,
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
