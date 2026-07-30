const mongoose = require('mongoose');

const contributionSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    receiptNumber: { type: String, required: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true, min: 0.01 },
    paymentModeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentMode' },
    // Which named fund this contribution was deposited into (default General
    // Fund). Drives the fund-account balance the money is credited to.
    fundAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'FundAccount' },
    method: { type: String, trim: true, default: 'Cash' },
    reference: { type: String, trim: true },
    note: { type: String, trim: true },
    contributionDate: { type: Date, required: true, default: Date.now },
    // denormalized for fast period reports
    month: { type: Number, min: 1, max: 12 },
    year: { type: Number },
    status: { type: String, enum: ['paid', 'pending', 'review', 'reversed'], default: 'paid' },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    receiptPath: { type: String },
    reversedAt: { type: Date },
    reversalId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReversalRequest' },
  },
  { timestamps: true }
);

contributionSchema.index({ organizationId: 1, receiptNumber: 1 }, { unique: true });
contributionSchema.index({ organizationId: 1, memberId: 1, contributionDate: -1 });
contributionSchema.index({ organizationId: 1, year: 1, month: 1 });
contributionSchema.index({ organizationId: 1, status: 1 });

contributionSchema.pre('validate', function (next) {
  if (this.contributionDate) {
    this.month = this.contributionDate.getMonth() + 1;
    this.year = this.contributionDate.getFullYear();
  }
  next();
});

contributionSchema.statics.nextReceiptNumber = async function (organizationId) {
  const year = new Date().getFullYear();
  const prefix = `RCT-${year}-`;
  const last = await this.findOne({ organizationId, receiptNumber: new RegExp(`^${prefix}`) })
    .sort({ receiptNumber: -1 })
    .select('receiptNumber')
    .lean();
  const seq = last ? parseInt(last.receiptNumber.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(seq).padStart(5, '0')}`;
};

module.exports = mongoose.model('Contribution', contributionSchema);
