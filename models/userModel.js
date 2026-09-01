// models/userModel.js
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const registrationAuditUtmSchema = new mongoose.Schema(
  {
    source: { type: String, trim: true, maxlength: 150 },
    medium: { type: String, trim: true, maxlength: 150 },
    campaign: { type: String, trim: true, maxlength: 150 },
    term: { type: String, trim: true, maxlength: 150 },
    content: { type: String, trim: true, maxlength: 150 },
  },
  { _id: false }
);

const registrationAuditSchema = new mongoose.Schema(
  {
    capturedAt: { type: Date },
    ip: { type: String, trim: true, maxlength: 100 },
    ipSource: { type: String, trim: true, maxlength: 80 },
    ipCountry: { type: String, trim: true, uppercase: true, maxlength: 2 },
    userAgent: { type: String, trim: true, maxlength: 500 },
    browserName: { type: String, trim: true, maxlength: 50 },
    osName: { type: String, trim: true, maxlength: 50 },
    deviceType: { type: String, trim: true, maxlength: 50 },
    referrer: { type: String, trim: true, maxlength: 500 },
    origin: { type: String, trim: true, maxlength: 250 },
    acceptLanguage: { type: String, trim: true, maxlength: 250 },

    browserLanguage: { type: String, trim: true, maxlength: 100 },
    timezone: { type: String, trim: true, maxlength: 100 },
    screenWidth: { type: Number, min: 0, max: 100000 },
    screenHeight: { type: Number, min: 0, max: 100000 },
    viewportWidth: { type: Number, min: 0, max: 100000 },
    viewportHeight: { type: Number, min: 0, max: 100000 },
    signupDurationMs: { type: Number, min: 0, max: 24 * 60 * 60 * 1000 },
    landingPath: { type: String, trim: true, maxlength: 300 },
    utm: { type: registrationAuditUtmSchema, default: undefined },

    emailDomain: { type: String, trim: true, lowercase: true, maxlength: 200 },
    sameIpSignupCountAtRegistration: { type: Number, min: 0, default: 0 },
    sameEmailDomainCountAtRegistration: { type: Number, min: 0, default: 0 },
    sameBrowserContextSignupCountAtRegistration: {
      type: Number,
      min: 0,
      default: 0,
    },

    riskFlags: [{ type: String, trim: true, maxlength: 80 }],
    riskLevel: {
      type: String,
      enum: ["Low", "Medium", "High"],
      default: "Low",
    },
  },
  { _id: false }
);

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
    phoneNumber: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      required: function requiredPhoneOnCreate() {
        return this.isNew;
      },
    },
    address: { type: String, trim: true },
    secondaryPhoneNumber: { type: String, trim: true },
    deliveryGoogleMapsUrl: { type: String, trim: true },
    deliveryNotes: { type: String, trim: true, maxlength: 1000, default: "" },
    approvalStatus: {
      type: String,
      enum: ["Pending", "Approved", "Rejected"],
      default: "Pending",
      index: true,
    },
    approvedAt: { type: Date },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    rejectedAt: { type: Date },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    adminNote: { type: String, trim: true, maxlength: 2000, default: "" },
    registrationAudit: { type: registrationAuditSchema, default: undefined },

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
userSchema.index({ "registrationAudit.ip": 1 }, { sparse: true });
userSchema.index({ "registrationAudit.emailDomain": 1 }, { sparse: true });
userSchema.index({ "registrationAudit.riskLevel": 1 }, { sparse: true });
// unique: true already creates an index on email

const User = mongoose.model("User", userSchema);
export default User;
