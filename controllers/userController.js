// controllers/userController.js
import asyncHandler from "../middleware/asyncHandler.js";
import User from "../models/userModel.js";
import generateToken from "../utils/generateToken.js";

/* =========================
   POST /api/users/auth
   Public
   ========================= */
export const authUser = asyncHandler(async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const { password } = req.body;

  const user = await User.findOne({ email });
  if (user && (await user.matchPassword(password))) {
    generateToken(res, user._id);
    return res.status(200).json({
      _id: user._id,
      name: user.name,
      phoneNumber: user.phoneNumber,
      email: user.email,
      isAdmin: user.isAdmin,
      address: user.address,
    });
  }

  res.status(401);
  throw new Error("Invalid credentials");
});

/* =========================
   POST /api/users/logout
   Public
   ========================= */
export const logoutUser = asyncHandler(async (req, res) => {
  // Must match generateToken() cookie options
  res.clearCookie("jwt", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  return res.status(204).end();
});

/* =========================
   POST /api/users
   Public
   ========================= */
export const registerUser = asyncHandler(async (req, res) => {
  const name = (req.body.name || "").trim();
  const phoneNumber = (req.body.phoneNumber || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  const { password } = req.body;

  const userExists = await User.findOne({ email });
  if (userExists) {
    res.status(409);
    throw new Error("Email already registered");
  }

  const user = await User.create({ name, phoneNumber, email, password });

  if (!user) {
    res.status(400);
    throw new Error("Invalid user data");
  }

  generateToken(res, user._id);
  return res.status(201).json({
    _id: user._id,
    name: user.name,
    phoneNumber: user.phoneNumber,
    email: user.email,
    isAdmin: user.isAdmin,
  });
});

/* =========================
   GET /api/users/account/profile
   Private (guarded in routes)
   ========================= */
export const getUserProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  return res.json({
    _id: user._id,
    name: user.name,
    email: user.email,
    phoneNumber: user.phoneNumber,
    address: user.address,
    isAdmin: user.isAdmin,
  });
});

/* =========================
   PUT /api/users/account/profile
   Private (guarded in routes)
   ========================= */
export const updateUserProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  user.name = req.body.name ?? user.name;
  user.phoneNumber = req.body.phoneNumber ?? user.phoneNumber;
  user.address = req.body.address ?? user.address;

  const updatedUser = await user.save();

  return res.json({
    _id: updatedUser._id,
    name: updatedUser.name,
    email: updatedUser.email,
    phoneNumber: updatedUser.phoneNumber,
    address: updatedUser.address,
    isAdmin: updatedUser.isAdmin,
  });
});

/* =========================
   GET /api/users
   Private/Admin (guarded in routes)
   ========================= */
export const getUsers = asyncHandler(async (_req, res) => {
  const users = await User.find({}).select("-password").lean();
  res.status(200).json(users);
});

/* =========================
   GET /api/users/:id
   Private/Admin (guarded in routes)
   ========================= */
export const getUserById = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select("-password");

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  return res.status(200).json(user);
});

/* =========================
   DELETE /api/users/:id
   Private/Admin (guarded in routes)
   ========================= */
export const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  if (user.isAdmin) {
    res.status(400);
    throw new Error("Cannot delete admin user");
  }

  await User.deleteOne({ _id: user._id });
  return res.status(204).end();
});

/* =========================
   PUT /api/users/:id
   Private/Admin (guarded in routes)
   ========================= */
export const updateUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  if (req.body.name != null) user.name = req.body.name;
  if (req.body.email != null) user.email = req.body.email.trim().toLowerCase();
  if (req.body.phoneNumber != null) user.phoneNumber = req.body.phoneNumber;
  if (req.body.address != null) user.address = req.body.address;

  // Only modify isAdmin if explicitly provided
  if (req.body.isAdmin != null) user.isAdmin = Boolean(req.body.isAdmin);

  try {
    const updatedUser = await user.save();
    return res.status(200).json({
      _id: updatedUser._id,
      name: updatedUser.name,
      email: updatedUser.email,
      phoneNumber: updatedUser.phoneNumber,
      address: updatedUser.address,
      isAdmin: updatedUser.isAdmin,
    });
  } catch (err) {
    // Duplicate email
    if (err.code === 11000 && err.keyPattern?.email) {
      res.status(409);
      throw new Error("Email already in use");
    }
    throw err;
  }
});
