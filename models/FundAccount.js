const mongoose = require('mongoose');

const fundAccountSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['operating', 'benefits', 'investment', 'reserve'], default: 'operating' },
    description: { type: String, trim: true },
    status: { type: String, enum: ['active', 'closed'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

fundAccountSchema.index({ organizationId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('FundAccount', fundAccountSchema);
