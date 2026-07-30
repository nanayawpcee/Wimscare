const mongoose = require('mongoose');

const CATEGORIES = ['claims_payout', 'reimbursement', 'operating_expense', 'investment', 'adjustment', 'other'];
// "Office operations register" views (both Administrator and Accountant
// pages) show everything except claim-linked payouts, which have their own
// dedicated queue.
const OFFICE_OPERATIONS_CATEGORIES = CATEGORIES.filter((c) => c !== 'claims_payout');
const ENTRY_STATUSES = ['pending', 'approved', 'paid', 'rejected'];

// Expenditure entries: claims payouts, reimbursements, operating expenses and
// adjustments. Workflow: pending → approved → paid (or rejected). Paying an
// entry posts the double-entry pair to the ledger.
const accountEntrySchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    ref: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    category: { type: String, enum: CATEGORIES, required: true },
    department: { type: String, trim: true, default: 'General Fund' },
    amount: { type: Number, required: true, min: 0.01 },
    entryDate: { type: Date, required: true, default: Date.now },
    status: { type: String, enum: ENTRY_STATUSES, default: 'pending', index: true },
    note: { type: String, trim: true },
    payoutAccount: { type: String, enum: ['cash', 'bank', 'mobile_money'], default: 'bank' },
    paymentReference: { type: String, trim: true },
    preparedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedAt: { type: Date },
    decisionNote: { type: String, trim: true },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    paidAt: { type: Date },
    // set when the entry was generated automatically by a claim payout
    sourceClaimId: { type: mongoose.Schema.Types.ObjectId, ref: 'Claim' },
    fundAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'FundAccount' },
  },
  { timestamps: true }
);

accountEntrySchema.index({ organizationId: 1, ref: 1 }, { unique: true });
accountEntrySchema.index({ organizationId: 1, status: 1, entryDate: -1 });
accountEntrySchema.index({ organizationId: 1, category: 1, entryDate: -1 });

accountEntrySchema.statics.nextRef = async function (organizationId) {
  const year = new Date().getFullYear();
  const prefix = `ACC-${year}-`;
  const last = await this.findOne({ organizationId, ref: new RegExp(`^${prefix}`) })
    .sort({ ref: -1 })
    .select('ref')
    .lean();
  const seq = last ? parseInt(last.ref.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(seq).padStart(3, '0')}`;
};

module.exports = mongoose.model('AccountEntry', accountEntrySchema);
module.exports.CATEGORIES = CATEGORIES;
module.exports.OFFICE_OPERATIONS_CATEGORIES = OFFICE_OPERATIONS_CATEGORIES;
module.exports.ENTRY_STATUSES = ENTRY_STATUSES;
