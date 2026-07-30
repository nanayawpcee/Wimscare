const mongoose = require('mongoose');
const crypto = require('crypto');

const invitationSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    role: { type: String, enum: ['admin', 'supervisor', 'accountant', 'user'], default: 'user' },
    tokenHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: ['sent', 'accepted', 'revoked', 'expired'], default: 'sent' },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    acceptedAt: { type: Date },
  },
  { timestamps: true }
);

invitationSchema.index({ organizationId: 1, email: 1, status: 1 });

invitationSchema.statics.issue = function () {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
};

invitationSchema.statics.hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

module.exports = mongoose.model('Invitation', invitationSchema);
