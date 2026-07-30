const mongoose = require('mongoose');

const claimTypeSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    benefitLimit: { type: Number, required: true, min: 0 },
    // 'fixed': benefitLimit IS the claim amount — set by the admin, members
    // can neither raise nor lower it. 'capped': members enter an amount up
    // to benefitLimit (legacy behaviour, for genuinely variable costs).
    amountMode: { type: String, enum: ['fixed', 'capped'], default: 'fixed' },
    limitPer: { type: String, enum: ['claim', 'year', 'lifetime'], default: 'claim' },
    waitingPeriodMonths: { type: Number, default: 0 },
    maxClaimsPerYear: { type: Number, default: 1 },
    approvalChain: {
      type: String,
      enum: ['admin', 'supervisor_admin', 'committee'],
      default: 'supervisor_admin',
    },
    requiredDocuments: [{ type: String, trim: true }],
    status: { type: String, enum: ['active', 'draft', 'archived'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

claimTypeSchema.index({ organizationId: 1, slug: 1 }, { unique: true });

module.exports = mongoose.model('ClaimType', claimTypeSchema);
