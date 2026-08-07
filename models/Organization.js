const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    contactEmail: { type: String, trim: true, lowercase: true },
    contactPhone: { type: String, trim: true },
    address: { type: String, trim: true },
    currency: { type: String, default: 'GHS' },
    settings: {
      monthlyDueAmount: { type: Number, default: 0 },
      fiscalYearStartMonth: { type: Number, default: 1, min: 1, max: 12 },
      allowSelfRegistration: { type: Boolean, default: false },
    },
    claimSettings: {
      minMembershipMonths: { type: Number, default: 6 },
      standingRule: {
        type: String,
        enum: ['no_arrears_2m', 'fully_paid', 'none'],
        default: 'no_arrears_2m',
      },
      maxClaimsPerYear: { type: Number, default: 3 },
      autoAck: { type: Boolean, default: true },
      allowDrafts: { type: Boolean, default: true },
      notifyChain: { type: Boolean, default: false },
    },
    // Member departments offered when assigning a user, and the dimension
    // reports group by. Absent until an administrator customizes the list,
    // at which point it replaces the shared defaults wholesale — see
    // utils/departments.js departmentsFor().
    departments: { type: [String], default: undefined },
    status: { type: String, enum: ['active', 'suspended', 'archived'], default: 'active' },
    // Deletion request — the admin asks, the superadmin decides (same
    // request/fulfil shape as License renewal/plan-upgrade requests).
    // Approving sets status:'archived' + archivedAt/By and clears these;
    // the organization and its data are kept (not erased) for audit.
    deletionRequestedAt: { type: Date },
    deletionRequestReason: { type: String, trim: true },
    deletionRequestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    archivedAt: { type: Date },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Console-wide behaviour toggles, set from the Administrator's Profile
    // > System settings panel.
    systemSettings: {
      sessionTimeoutMinutes: { type: Number, default: 30 },
      auditLogEnabled: { type: Boolean, default: true },
      maintenanceMode: { type: Boolean, default: false },
      emailAlerts: { type: Boolean, default: true },
      strictEligibility: { type: Boolean, default: true },
    },
    // Facility profile — shown on the Administrator's Profile page and used
    // across reports, exports and public pages.
    facility: {
      shortName: { type: String, trim: true },
      tagline: { type: String, trim: true },
      website: { type: String, trim: true },
      overview: { type: String, trim: true },
      legalName: { type: String, trim: true },
      registrationNumber: { type: String, trim: true },
      taxId: { type: String, trim: true },
      vatStatus: { type: String, trim: true },
      complianceNotes: { type: String, trim: true },
      addressLine1: { type: String, trim: true },
      addressLine2: { type: String, trim: true },
      city: { type: String, trim: true },
      region: { type: String, trim: true },
      postalCode: { type: String, trim: true },
      country: { type: String, trim: true, default: 'Ghana' },
      supportHotline: { type: String, trim: true },
      supportEmail: { type: String, trim: true },
      whatsapp: { type: String, trim: true },
      // Brand colours are unset until an organization on the Pro plan
      // customizes them (utils/plans.js `customBranding`); the consoles
      // fall back to the stock WIMScare palette. ('#1d6fae'/'#79b843' were
      // old schema defaults — treated as "not customized" by app.js.)
      primaryColor: { type: String, trim: true },
      accentColor: { type: String, trim: true },
      backgroundColor: { type: String, trim: true },
      // Server path (under uploads/) of the organization's own logo,
      // uploaded from the Branding tab; served via GET /api/organization/logo.
      logoPath: { type: String, trim: true },
      facebook: { type: String, trim: true },
      twitter: { type: String, trim: true },
      instagram: { type: String, trim: true },
      linkedin: { type: String, trim: true },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Organization', organizationSchema);
