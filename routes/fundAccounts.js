const express = require('express');
const mongoose = require('mongoose');
const FundAccount = require('../models/FundAccount');
const LedgerEntry = require('../models/LedgerEntry');
const { protect, requireRoles, requirePermission, requireOrg, orgFilter, requireFeature } = require('../middleware/auth');
const { audit } = require('../utils/audit');

const router = express.Router();

router.use(protect, requireOrg, requirePermission('view_accounts'), requireFeature('accountsManagement'));

const oid = (v) => new mongoose.Types.ObjectId(String(v));

// A fund account is tagged onto exactly one leg per automated transaction
// (the real cash-movement leg), so whether that leg means money "in" or
// "out" of the fund is a fixed rule per source — not the raw double-entry
// `direction`, which follows standard debit/credit accounting instead.
// Only user-authored manual entries (posted via POST /:id/ledger) use the
// cash-book "credit = in, debit = out" convention on `direction` directly.
const FUND_DIRECTION_AGG = {
  $cond: [
    { $eq: ['$sourceType', 'contribution'] }, 'in',
    { $cond: [
      { $in: ['$sourceType', ['claim', 'reversal', 'expense']] }, 'out',
      { $cond: [{ $eq: ['$direction', 'credit'] }, 'in', 'out'] },
    ] },
  ],
};
function fundDirection(entry) {
  if (entry.sourceType === 'contribution') return 'in';
  if (['claim', 'reversal', 'expense'].includes(entry.sourceType)) return 'out';
  return entry.direction === 'credit' ? 'in' : 'out';
}

// Separated-funds model: each fund is a self-contained bucket whose balance
// is the net of the ledger entries tagged to IT (contributions, payouts,
// expenses and transfers). Funds don't overlap, so the organization's total
// is a clean sum of all fund balances. Money is moved between funds with the
// transfer endpoint below.
async function accountTotals(orgId, fundAccountId, from) {
  const match = { organizationId: oid(orgId), fundAccountId: oid(fundAccountId) };
  if (from) match.entryDate = { $gte: from };
  const agg = await LedgerEntry.aggregate([
    { $match: match },
    { $group: { _id: FUND_DIRECTION_AGG, total: { $sum: '$amount' } } },
  ]);
  const inflow = agg.find((a) => a._id === 'in')?.total || 0;
  const outflow = agg.find((a) => a._id === 'out')?.total || 0;
  return { inflow, outflow, balance: inflow - outflow };
}

// GET /api/fund-accounts — list with derived YTD inflow/outflow/balance
router.get('/', async (req, res, next) => {
  try {
    const accounts = await FundAccount.find(orgFilter(req)).sort({ createdAt: 1 });
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const items = await Promise.all(
      accounts.map(async (a) => {
        const totals = await accountTotals(req.orgId, a._id, yearStart);
        return { ...a.toObject(), inflowYtd: totals.inflow, outflowYtd: totals.outflow, balance: totals.balance };
      })
    );
    // Non-overlapping funds → the total is a clean sum.
    const summary = items.reduce(
      (acc, a) => ({
        balance: acc.balance + a.balance,
        inflow: acc.inflow + a.inflowYtd,
        outflow: acc.outflow + a.outflowYtd,
      }),
      { balance: 0, inflow: 0, outflow: 0 }
    );
    res.json({ items, summary });
  } catch (err) {
    next(err);
  }
});

// POST /api/fund-accounts — create (admin exclusive)
router.post('/', requireRoles('admin'), async (req, res, next) => {
  try {
    const { name, type = 'operating', description } = req.body;
    if (!name) return res.status(400).json({ error: 'Account name is required' });
    if (!['operating', 'benefits', 'investment', 'reserve'].includes(type)) {
      return res.status(400).json({ error: 'Invalid account type' });
    }
    const account = await FundAccount.create({
      organizationId: req.orgId,
      name: String(name).trim(),
      type,
      description,
      createdBy: req.user._id,
    });
    audit(req, 'fund_account.create', { entityType: 'FundAccount', entityId: account._id, detail: { name, type } });
    res.status(201).json({ account });
  } catch (err) {
    next(err);
  }
});

// POST /api/fund-accounts/transfer — move money from one fund to another.
// Posts a balanced pair of fund-ledger entries (source out, destination in),
// so the organization total is unchanged — only the allocation shifts. The
// source fund must hold enough to cover the move.
router.post('/transfer', requirePermission('manage_accounts'), async (req, res, next) => {
  try {
    const { fromFundId, toFundId, amount, description, entryDate } = req.body;
    if (!fromFundId || !toFundId) return res.status(400).json({ error: 'Source and destination funds are required' });
    if (String(fromFundId) === String(toFundId)) return res.status(400).json({ error: 'Source and destination must be different funds' });
    const amt = Number(amount);
    if (!(amt > 0)) return res.status(400).json({ error: 'Amount must be greater than zero' });

    const [fromFund, toFund] = await Promise.all([
      FundAccount.findOne(orgFilter(req, { _id: fromFundId, status: 'active' })),
      FundAccount.findOne(orgFilter(req, { _id: toFundId, status: 'active' })),
    ]);
    if (!fromFund || !toFund) return res.status(404).json({ error: 'Fund account not found' });

    // Can't move more than the source currently holds.
    const { balance } = await accountTotals(req.orgId, fromFund._id);
    if (amt > balance) {
      return res.status(400).json({ error: `${fromFund.name} only has GH₵ ${balance.toFixed(2)} available to transfer` });
    }

    const when = entryDate ? new Date(entryDate) : new Date();
    const base = {
      organizationId: req.orgId,
      entryDate: when,
      account: 'adjustments',
      category: 'transfer',
      amount: amt,
      sourceType: 'manual',
      createdBy: req.user._id,
    };
    const entries = await LedgerEntry.insertMany([
      { ...base, fundAccountId: fromFund._id, direction: 'debit', description: description || `Transfer to ${toFund.name}` },
      { ...base, fundAccountId: toFund._id, direction: 'credit', description: description || `Transfer from ${fromFund.name}` },
    ]);
    audit(req, 'fund_account.transfer', { entityType: 'FundAccount', entityId: fromFund._id, detail: { toFundId: toFund._id, amount: amt } });
    res.status(201).json({ entries, from: fromFund.name, to: toFund.name });
  } catch (err) {
    next(err);
  }
});

async function loadAccount(req, res, next) {
  try {
    const account = await FundAccount.findOne(orgFilter(req, { _id: req.params.id }));
    if (!account) return res.status(404).json({ error: 'Fund account not found' });
    req.fundAccount = account;
    next();
  } catch (err) {
    next(err);
  }
}

// GET /api/fund-accounts/:id/ledger?from=&to=&page=
router.get('/:id/ledger', loadAccount, async (req, res, next) => {
  try {
    const { from, to, page = 1, limit = 25 } = req.query;
    const filter = orgFilter(req, { fundAccountId: req.fundAccount._id });
    if (from || to) {
      filter.entryDate = {};
      if (from) filter.entryDate.$gte = new Date(from);
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        filter.entryDate.$lte = end;
      }
    }
    const perPage = Math.min(Number(limit) || 25, 100);

    // Opening balance = net of everything before the window start.
    const openingAgg = from
      ? await LedgerEntry.aggregate([
          { $match: { organizationId: oid(req.orgId), fundAccountId: req.fundAccount._id, entryDate: { $lt: new Date(from) } } },
          { $group: { _id: FUND_DIRECTION_AGG, total: { $sum: '$amount' } } },
        ])
      : [];
    const opening = (openingAgg.find((a) => a._id === 'in')?.total || 0) - (openingAgg.find((a) => a._id === 'out')?.total || 0);

    const [items, total] = await Promise.all([
      LedgerEntry.find(filter)
        .sort({ entryDate: -1, _id: -1 })
        .skip((Number(page) - 1) * perPage)
        .limit(perPage)
        .populate('createdBy', 'firstName lastName'),
      LedgerEntry.countDocuments(filter),
    ]);

    // Running balance shown newest-first: compute from the opening balance
    // forward across the whole filtered set, then map onto the page.
    const allInWindow = await LedgerEntry.find(filter).sort({ entryDate: 1, _id: 1 }).select('_id direction amount sourceType').lean();
    const runningById = new Map();
    let running = opening;
    for (const e of allInWindow) {
      running += fundDirection(e) === 'in' ? e.amount : -e.amount;
      runningById.set(String(e._id), running);
    }
    const closing = running;

    res.json({
      account: req.fundAccount,
      opening,
      closing,
      movement: closing - opening,
      items: items.map((e) => ({ ...e.toObject(), fundDirection: fundDirection(e), balance: runningById.get(String(e._id)) })),
      total,
      page: Number(page),
      pages: Math.ceil(total / perPage),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/fund-accounts/:id/ledger — post a single manual entry (cash-book
// style: one row per entry, not a double-entry pair — see models/LedgerEntry.js)
router.post('/:id/ledger', requirePermission('manage_accounts'), loadAccount, async (req, res, next) => {
  try {
    const { direction, amount, category, description, reference, entryDate } = req.body;
    if (!['credit', 'debit'].includes(direction)) return res.status(400).json({ error: 'Direction must be credit or debit' });
    const amt = Number(amount);
    if (!(amt > 0)) return res.status(400).json({ error: 'Amount must be greater than zero' });
    if (!description) return res.status(400).json({ error: 'Description is required' });
    const validCategories = ['member_dues', 'claims_payout', 'operating_expense', 'investment_return', 'transfer', 'adjustment'];
    if (category && !validCategories.includes(category)) return res.status(400).json({ error: 'Invalid category' });

    const entry = await LedgerEntry.create({
      organizationId: req.orgId,
      entryDate: entryDate ? new Date(entryDate) : new Date(),
      account: 'adjustments',
      fundAccountId: req.fundAccount._id,
      category: category || 'adjustment',
      direction,
      amount: amt,
      description,
      reference,
      sourceType: 'manual',
      createdBy: req.user._id,
    });
    audit(req, 'fund_account.ledger_entry', { entityType: 'LedgerEntry', entityId: entry._id, detail: { fundAccountId: req.fundAccount._id, direction, amount: amt } });
    res.status(201).json({ entry });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
// Exported for unit tests — the inflow/outflow rule is the heart of the
// fund-account balance math.
module.exports.fundDirection = fundDirection;
