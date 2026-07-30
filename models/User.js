const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const ROLES = ['superadmin', 'admin', 'supervisor', 'accountant', 'user'];

const userSchema = new mongoose.Schema(
  {
    // null for superadmin — they exist above all tenants
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, index: true },
    phone: { type: String, trim: true },
    phoneVerified: { type: Boolean, default: false },
    phoneVerifiedAt: { type: Date },
    // Opt-in: require an SMS code at login, on top of the password. Can
    // only be turned on once phoneVerified is true (enforced in routes).
    twoFactorEnabled: { type: Boolean, default: false },
    passwordHash: { type: String, select: false },
    // Set when the superadmin resets this account's password to the shared
    // default (routes/users.js reset-password, superadmin-only, org-scoped
    // via the developer portal's "Open as superadmin" access) — blocks the
    // account behind a forced password-change prompt (public/js/app.js
    // requireSession) until they set their own, and is cleared the moment
    // they do (routes/auth.js change-password).
    mustChangePassword: { type: Boolean, default: false },
    role: { type: String, enum: ROLES, default: 'user' },
    // Explicit per-user permission grants on top of the role's defaults —
    // see utils/permissions.js for the catalogue and role default mapping.
    permissions: [{ type: String }],
    status: { type: String, enum: ['pending', 'active', 'suspended', 'deleted'], default: 'pending' },
    // Account deletion — a request, not the act itself. Members request
    // their own deletion for their org admin to act on; admins request
    // their own deletion for the superadmin to act on (see routes/profile.js
    // request-deletion, routes/users.js and routes/developer.js for the
    // approve/reject side). Approving sets status:'deleted' + deletedAt/By
    // and clears these — the record itself is kept (not erased) so
    // contributions, claims and ledger entries the account is tied to stay
    // intact for reporting/audit.
    deletionRequestedAt: { type: Date },
    deletionRequestReason: { type: String, trim: true },
    deletionRequestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deletedAt: { type: Date },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Terms & Data Policy acceptance (see utils/terms.js for the current
    // version string and public/terms.html for the text). Required at
    // registration/activation for new accounts; existing accounts without
    // it are prompted once at their next sign-in (public/js/app.js
    // requireSession). A version bump re-prompts everyone.
    acceptedTermsAt: { type: Date },
    acceptedTermsVersion: { type: String },
    memberNumber: { type: String, trim: true },
    department: { type: String, trim: true },
    avatarPath: { type: String },
    lastLoginAt: { type: Date },
    activationToken: { type: String, select: false },
    activationExpires: { type: Date, select: false },
    resetToken: { type: String, select: false },
    resetExpires: { type: Date, select: false },
    // Generic hashed one-time-code slot, reused for both phone verification
    // and login 2FA (never both at once for a given user, so one slot is
    // enough — see issueOtp/verifyOtp below).
    otpHash: { type: String, select: false },
    otpExpires: { type: Date, select: false },
    otpPurpose: { type: String, select: false }, // 'phone_verify' | 'login'
    otpAttempts: { type: Number, select: false, default: 0 },
    preferences: {
      emailNotifications: { type: Boolean, default: true },
      claimUpdates: { type: Boolean, default: true },
      contributionReceipts: { type: Boolean, default: true },
      monthlyStatement: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

// Same email may exist in multiple organizations, but only once per organization.
userSchema.index({ email: 1, organizationId: 1 }, { unique: true });
userSchema.index({ organizationId: 1, role: 1 });
userSchema.index({ organizationId: 1, status: 1 });

userSchema.methods.setPassword = async function (plain) {
  this.passwordHash = await bcrypt.hash(plain, 12);
};

userSchema.methods.comparePassword = function (plain) {
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.methods.issueToken = function (field, ttlMs) {
  const raw = crypto.randomBytes(32).toString('hex');
  const hashed = crypto.createHash('sha256').update(raw).digest('hex');
  if (field === 'activation') {
    this.activationToken = hashed;
    this.activationExpires = new Date(Date.now() + ttlMs);
  } else {
    this.resetToken = hashed;
    this.resetExpires = new Date(Date.now() + ttlMs);
  }
  return raw;
};

userSchema.statics.hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

// One-time SMS code (6 digits). Stores only its hash, same shape as
// issueToken above. Caller is responsible for saving the document.
userSchema.methods.issueOtp = function (purpose, ttlMs) {
  const code = String(crypto.randomInt(100000, 1000000));
  this.otpHash = crypto.createHash('sha256').update(code).digest('hex');
  this.otpExpires = new Date(Date.now() + ttlMs);
  this.otpPurpose = purpose;
  this.otpAttempts = 0;
  return code;
};

// Checks a submitted code against the stored OTP. Mutates attempt count /
// clears the slot on success, but does NOT save — caller must persist.
userSchema.methods.verifyOtp = function (purpose, code) {
  if (!this.otpHash || !this.otpExpires || this.otpPurpose !== purpose) {
    return { ok: false, error: 'No verification code was requested' };
  }
  if (this.otpExpires < new Date()) return { ok: false, error: 'Code has expired — request a new one' };
  if (this.otpAttempts >= 5) return { ok: false, error: 'Too many incorrect attempts — request a new code' };
  const hash = crypto.createHash('sha256').update(String(code)).digest('hex');
  if (hash !== this.otpHash) {
    this.otpAttempts += 1;
    return { ok: false, error: 'Incorrect code' };
  }
  this.otpHash = undefined;
  this.otpExpires = undefined;
  this.otpPurpose = undefined;
  this.otpAttempts = 0;
  return { ok: true };
};

userSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`.trim();
});

userSchema.set('toJSON', {
  virtuals: true,
  transform(_doc, ret) {
    delete ret.passwordHash;
    delete ret.activationToken;
    delete ret.activationExpires;
    delete ret.resetToken;
    delete ret.resetExpires;
    delete ret.otpHash;
    delete ret.otpExpires;
    delete ret.otpPurpose;
    delete ret.otpAttempts;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
module.exports.ROLES = ROLES;
