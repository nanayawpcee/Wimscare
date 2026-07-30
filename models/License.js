const mongoose = require('mongoose');
const crypto = require('crypto');

// Feature flags gate optional modules per organization. Keys mirror the
// superadmin console's create-license form; absent keys mean "off".
const FEATURE_KEYS = [
  'claimsManagement',
  'contributionsManagement',
  'accountsManagement',
  'reports',
  'auditTrail',
  'customBranding',
];

const featureDefaults = {};
for (const key of FEATURE_KEYS) {
  featureDefaults[key] = { type: Boolean, default: false };
}

const licenseSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    key: { type: String, required: true, unique: true },
    // Current tiers are free/standard/pro (see utils/plans.js). The other
    // values are legacy plans from earlier catalogues, grandfathered with
    // all features enabled.
    plan: {
      type: String,
      enum: ['free', 'standard', 'pro', 'trial', 'professional', 'enterprise', 'premium'],
      default: 'free',
    },
    maxUsers: { type: Number, default: 5 },
    maxMembers: { type: Number, default: 50 },
    features: featureDefaults,
    contactName: { type: String, trim: true },
    contactEmail: { type: String, trim: true, lowercase: true },
    issuedAt: { type: Date, default: Date.now },
    // Set when the organization's admin activates their account; pending
    // licenses have no activation date yet.
    activatedAt: { type: Date },
    expiresAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ['pending', 'active', 'expired', 'suspended', 'cancelled', 'revoked'],
      default: 'active',
    },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    notes: { type: String, trim: true },
    // Set when an organization admin requests a renewal from their console;
    // surfaced on the superadmin overview and cleared when the superadmin
    // renews the license.
    renewalRequestedAt: { type: Date },
    renewalRequestNote: { type: String, trim: true },
    renewalRequestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Set when an organization admin requests a plan change (usually an
    // upgrade) from their console; surfaced on the superadmin overview and
    // cleared when the superadmin changes the plan.
    requestedPlan: { type: String },
    planRequestedAt: { type: Date },
    planRequestNote: { type: String, trim: true },
    planRequestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Append-only log of every renewal applied to this license, so the
    // organization's renewal history is preserved over time.
    renewals: [
      {
        at: { type: Date, default: Date.now },
        months: { type: Number },
        previousExpiresAt: { type: Date },
        newExpiresAt: { type: Date },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        note: { type: String, trim: true },
        _id: false,
      },
    ],
  },
  { timestamps: true }
);

licenseSchema.statics.FEATURE_KEYS = FEATURE_KEYS;

licenseSchema.statics.generateKey = function () {
  const raw = crypto.randomBytes(10).toString('hex').toUpperCase();
  return `WIMS-${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`;
};

licenseSchema.methods.isValid = function () {
  return this.status === 'active' && this.expiresAt > new Date();
};

module.exports = mongoose.model('License', licenseSchema);
