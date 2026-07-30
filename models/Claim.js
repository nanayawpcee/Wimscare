const mongoose = require('mongoose');

const CLAIM_STATUSES = ['draft', 'submitted', 'under_review', 'approved', 'rejected', 'paid'];

const claimDocumentSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true },
    originalName: { type: String },
    path: { type: String, required: true },
    mimeType: { type: String },
    size: { type: Number },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const approvalStepSchema = new mongoose.Schema(
  {
    step: { type: String, enum: ['supervisor', 'accountant', 'admin', 'committee'], required: true },
    decision: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    actedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    actedAt: { type: Date },
    comment: { type: String, trim: true },
  },
  { _id: false }
);

// Tracks the accountant-prepares / administrator-releases payout workflow,
// separate from claim.status. Administrator may release without a prior
// "prepared" step (bypass); accountant/admin may prepare but never release.
const disbursementSchema = new mongoose.Schema(
  {
    documentsReviewed: { type: Boolean, default: false },
    documentsReviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    documentsReviewedAt: { type: Date },
    status: { type: String, enum: ['none', 'prepared', 'released'], default: 'none' },
    payoutAccount: { type: String, enum: ['cash', 'bank', 'mobile_money'] },
    fundAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'FundAccount' },
    paymentReference: { type: String, trim: true },
    preparedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    preparedAt: { type: Date },
    releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    releasedAt: { type: Date },
  },
  { _id: false }
);

const claimSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    claimNumber: { type: String, required: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    claimTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClaimType', required: true },
    amountRequested: { type: Number, required: true, min: 0 },
    amountApproved: { type: Number, min: 0 },
    description: { type: String, trim: true, default: '' },
    eventDate: { type: Date },
    beneficiaryName: { type: String, trim: true },
    documents: [claimDocumentSchema],
    status: { type: String, enum: CLAIM_STATUSES, default: 'draft', index: true },
    approvals: [approvalStepSchema],
    disbursement: { type: disbursementSchema, default: () => ({}) },
    submittedAt: { type: Date },
    decidedAt: { type: Date },
    paidAt: { type: Date },
    paymentReference: { type: String, trim: true },
    rejectionReason: { type: String, trim: true },
    // Which status the member last dismissed the outcome banner for. Stored
    // server-side (not localStorage) so the dismissal follows the account
    // across devices/browsers; re-cleared when status moves on (e.g.
    // approved -> paid), so the member is notified again.
    memberBannerDismissedStatus: { type: String },
    timeline: [
      {
        at: { type: Date, default: Date.now },
        actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        event: { type: String, required: true },
        note: { type: String },
      },
    ],
  },
  { timestamps: true }
);

claimSchema.index({ organizationId: 1, claimNumber: 1 }, { unique: true });
claimSchema.index({ organizationId: 1, memberId: 1, status: 1 });
claimSchema.index({ organizationId: 1, status: 1, createdAt: -1 });

claimSchema.statics.nextClaimNumber = async function (organizationId) {
  const year = new Date().getFullYear();
  const prefix = `CLM-${year}-`;
  const last = await this.findOne({ organizationId, claimNumber: new RegExp(`^${prefix}`) })
    .sort({ claimNumber: -1 })
    .select('claimNumber')
    .lean();
  const seq = last ? parseInt(last.claimNumber.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
};

module.exports = mongoose.model('Claim', claimSchema);
module.exports.CLAIM_STATUSES = CLAIM_STATUSES;
