const mongoose = require('mongoose');

// Release notes / maintenance announcements published from the developer portal
// and shown in each organization's admin console.
const systemUpdateSchema = new mongoose.Schema(
  {
    version: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, trim: true, default: '' },
    kind: { type: String, enum: ['release', 'maintenance', 'security'], default: 'release' },
    publishedAt: { type: Date, default: Date.now },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: ['draft', 'published'], default: 'published' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SystemUpdate', systemUpdateSchema);
