const mongoose = require('mongoose');

const backupSchema = new mongoose.Schema(
  {
    // null for full-system backups taken from the developer portal
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    fileName: { type: String, required: true },
    filePath: { type: String, required: true },
    sizeBytes: { type: Number, default: 0 },
    scope: { type: String, enum: ['organization', 'system'], default: 'organization' },
    trigger: { type: String, enum: ['manual', 'scheduled'], default: 'manual' },
    collections: [{ name: String, count: Number }],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: ['completed', 'failed'], default: 'completed' },
    error: { type: String },
  },
  { timestamps: true }
);

backupSchema.index({ organizationId: 1, createdAt: -1 });

module.exports = mongoose.model('Backup', backupSchema);
