// models/userModel.js
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please enter a valid email address"],
    },
    password: { type: String, required: true },
    isAdmin: { type: Boolean, required: true, default: false },
    phoneNumber: { type: String, trim: true },
    address: { type: String, trim: true },

    /* =========================
       Forgot Password (Email)
       =========================
       We store ONLY a HASH of the reset token (never the raw token),
       plus an expiration date. */
    passwordResetTokenHash: { type: String },
    passwordResetExpires: { type: Date },
  },
  { timestamps: true }
);

// compare passwords
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// hash before saving
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// hide password in responses
userSchema.set("toJSON", {
  transform: (_doc, ret) => {
    delete ret.password;

    // also hide reset fields (extra safety)
    delete ret.passwordResetTokenHash;
    delete ret.passwordResetExpires;

    return ret;
  },
});

userSchema.index({ name: 1 });
userSchema.index({ email: 1 });

const User = mongoose.model("User", userSchema);
export default User;
