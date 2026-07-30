const mongoose = require('mongoose');

const reversalRequestSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    contributionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contribution', required: true },
    reason: { type: String, required: true, trim: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedAt: { type: Date },
    decisionNote: { type: String, trim: true },
    // An accountant's non-binding recommendation, shown to the administrator
    // who makes the actual decision above.
    recommendation: { type: String, enum: ['recommend', 'flag'] },
    recommendedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    recommendedAt: { type: Date },
    recommendationNote: { type: String, trim: true },
  },
  { timestamps: true }
);

reversalRequestSchema.index({ organizationId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('ReversalRequest', reversalRequestSchema);
