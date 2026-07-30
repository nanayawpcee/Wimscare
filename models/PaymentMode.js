const mongoose = require('mongoose');

const paymentModeSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    name: { type: String, required: true, trim: true },
    ledgerAccount: {
      type: String,
      enum: ['cash', 'bank', 'mobile_money'],
      default: 'cash',
    },
    requiresReference: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
  },
  { timestamps: true }
);

paymentModeSchema.index({ organizationId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('PaymentMode', paymentModeSchema);
