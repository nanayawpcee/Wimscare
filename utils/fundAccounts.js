const FundAccount = require('../models/FundAccount');

const DEFAULT_FUND_ACCOUNTS = [
  { name: 'General Fund', type: 'operating', description: 'Day-to-day operating account — member dues and running costs.' },
  { name: 'Welfare Fund', type: 'benefits', description: 'Claim benefit payouts.' },
  { name: 'Investment Account', type: 'investment', description: 'Treasury bills, fixed deposits and other investments.' },
  { name: 'Emergency Reserve', type: 'reserve', description: 'Restricted reserve for emergencies.' },
];

async function seedDefaultFundAccounts(organizationId, createdBy) {
  return FundAccount.insertMany(
    DEFAULT_FUND_ACCOUNTS.map((a) => ({ ...a, organizationId, createdBy })),
    { ordered: false }
  ).catch(() => {}); // ignore duplicate-key races
}

// Resolve a default fund account by name, creating it if this organization
// predates fund accounts. Used so automated ledger postings (contributions,
// claim payouts) reconcile with the named fund-account view.
async function getDefaultFundAccount(organizationId, name) {
  let account = await FundAccount.findOne({ organizationId, name });
  if (!account) {
    const def = DEFAULT_FUND_ACCOUNTS.find((a) => a.name === name) || { name, type: 'operating' };
    account = await FundAccount.create({ ...def, organizationId });
  }
  return account;
}

module.exports = { DEFAULT_FUND_ACCOUNTS, seedDefaultFundAccounts, getDefaultFundAccount };
