const mongoose = require('mongoose');

const ledgerEntrySchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    entryDate: { type: Date, required: true, default: Date.now },
    account: {
      type: String,
      enum: ['contributions', 'claims_payable', 'expenses', 'cash', 'bank', 'mobile_money', 'adjustments'],
      required: true,
    },
    // Named fund account this entry is attributed to (General Fund, Welfare
    // Fund, etc). Nullable for entries posted before fund accounts existed.
    fundAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'FundAccount' },
    // Free-form category for manually posted fund-account entries — distinct
    // from the chart-of-accounts `account` enum above.
    category: {
      type: String,
      enum: ['member_dues', 'claims_payout', 'operating_expense', 'investment_return', 'transfer', 'adjustment'],
    },
    reference: { type: String, trim: true },
    direction: { type: String, enum: ['debit', 'credit'], required: true },
    amount: { type: Number, required: true, min: 0.01 },
    description: { type: String, trim: true },
    sourceType: { type: String, enum: ['contribution', 'claim', 'reversal', 'expense', 'manual'], required: true },
    sourceId: { type: mongoose.Schema.Types.ObjectId },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

ledgerEntrySchema.index({ organizationId: 1, entryDate: -1 });
ledgerEntrySchema.index({ organizationId: 1, account: 1, entryDate: -1 });
ledgerEntrySchema.index({ organizationId: 1, sourceType: 1, sourceId: 1 });
ledgerEntrySchema.index({ organizationId: 1, fundAccountId: 1, entryDate: -1 });

module.exports = mongoose.model('LedgerEntry', ledgerEntrySchema);
