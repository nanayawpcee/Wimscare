const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true }, // e.g. user.create, claim.approve, backup.restore
    entityType: { type: String },
    entityId: { type: mongoose.Schema.Types.ObjectId },
    detail: { type: mongoose.Schema.Types.Mixed },
    ip: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ organizationId: 1, createdAt: -1 });
auditLogSchema.index({ organizationId: 1, action: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
