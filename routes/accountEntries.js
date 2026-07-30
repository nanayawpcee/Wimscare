const express = require('express');
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const AccountEntry = require('../models/AccountEntry');
const LedgerEntry = require('../models/LedgerEntry');
const { protect, requireRoles, requirePermission, requireOrg, orgFilter, requireFeature } = require('../middleware/auth');
const { audit } = require('../utils/audit');

const router = express.Router();

router.use(protect, requireOrg, requirePermission('view_accounts'), requireFeature('accountsManagement'));

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const CATEGORY_LABELS = {
  claims_payout: 'Claims payout',
  reimbursement: 'Reimbursement',
  operating_expense: 'Operating expense',
  investment: 'Investment',
  adjustment: 'Adjustment',
  other: 'Other',
};

// Ledger accounts debited per category when an entry is paid.
const DEBIT_ACCOUNT = {
  claims_payout: 'claims_payable',
  reimbursement: 'expenses',
  operating_expense: 'expenses',
  investment: 'expenses',
  adjustment: 'adjustments',
  other: 'expenses',
};

// Posts the double-entry pair when an expenditure is paid. Standard
// double-entry: debit the expense account, credit the cash account the money
// left from. The cash-out (credit) leg is tagged with the chosen fund and
// marked sourceType 'expense', so the fund view reads it as money OUT of that
// fund (fund direction is driven by sourceType, not raw debit/credit — see
// fundDirection in routes/fundAccounts.js), while the chart-of-accounts
// balances stay correct standard double-entry.
async function postEntryToLedger(entry, actorId) {
  await LedgerEntry.insertMany([
    {
      organizationId: entry.organizationId,
      entryDate: entry.paidAt || new Date(),
      account: DEBIT_ACCOUNT[entry.category] || 'expenses',
      direction: 'debit',
      amount: entry.amount,
      description: `${CATEGORY_LABELS[entry.category]} ${entry.ref} — ${entry.title}`,
      sourceType: 'manual',
      sourceId: entry._id,
      createdBy: actorId,
    },
    {
      organizationId: entry.organizationId,
      entryDate: entry.paidAt || new Date(),
      account: entry.payoutAccount,
      fundAccountId: entry.fundAccountId || undefined,
      category: 'operating_expense',
      direction: 'credit',
      amount: entry.amount,
      description: `${CATEGORY_LABELS[entry.category]} ${entry.ref} — ${entry.title}`,
      sourceType: entry.fundAccountId ? 'expense' : 'manual',
      sourceId: entry._id,
      createdBy: actorId,
    },
  ]);
}

function listFilter(req) {
  const { q, status, category, year } = req.query;
  const filter = orgFilter(req);
  if (status) filter.status = status;
  if (category) filter.category = category;
  if (year) {
    filter.entryDate = {
      $gte: new Date(Number(year), 0, 1),
      $lt: new Date(Number(year) + 1, 0, 1),
    };
  }
  if (q) {
    const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ title: rx }, { ref: rx }, { department: rx }, { note: rx }];
  }
  return filter;
}

// GET /api/accounts — list with filters + pagination
router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const filter = listFilter(req);
    const perPage = Math.min(Number(limit) || 20, 100);
    const [items, total] = await Promise.all([
      AccountEntry.find(filter)
        .sort({ entryDate: -1, ref: -1 })
        .skip((Number(page) - 1) * perPage)
        .limit(perPage)
        .populate('preparedBy', 'firstName lastName')
        .populate('decidedBy', 'firstName lastName')
        .populate('paidBy', 'firstName lastName'),
      AccountEntry.countDocuments(filter),
    ]);
    res.json({ items, total, page: Number(page), pages: Math.ceil(total / perPage) });
  } catch (err) {
    next(err);
  }
});

// GET /api/accounts/summary?year=
router.get('/summary', async (req, res, next) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const range = { $gte: new Date(year, 0, 1), $lt: new Date(year + 1, 0, 1) };
    const orgId = oid(req.orgId);

    const [byStatus, byCategory] = await Promise.all([
      AccountEntry.aggregate([
        { $match: { organizationId: orgId, entryDate: range } },
        { $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      AccountEntry.aggregate([
        { $match: { organizationId: orgId, entryDate: range, status: { $in: ['approved', 'paid'] } } },
        { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
    ]);

    const stat = (id) => byStatus.find((s) => s._id === id) || { total: 0, count: 0 };
    const cat = (id) => byCategory.find((c) => c._id === id) || { total: 0, count: 0 };
    const spent = byStatus
      .filter((s) => ['approved', 'paid'].includes(s._id))
      .reduce((a, s) => a + s.total, 0);

    res.json({
      year,
      periodExpenditure: spent,
      pending: { total: stat('pending').total, count: stat('pending').count },
      claimsPayouts: { total: cat('claims_payout').total, count: cat('claims_payout').count },
      operatingCosts: {
        total: cat('operating_expense').total + cat('reimbursement').total,
        count: cat('operating_expense').count + cat('reimbursement').count,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/accounts/export.xlsx — snapshot of the current filter set
router.get('/export.xlsx', async (req, res, next) => {
  try {
    const items = await AccountEntry.find(listFilter(req))
      .sort({ entryDate: -1 })
      .populate('preparedBy', 'firstName lastName')
      .lean();
    const rows = items.map((e) => ({
      Ref: e.ref,
      Title: e.title,
      Category: CATEGORY_LABELS[e.category],
      Status: e.status,
      Department: e.department,
      Date: new Date(e.entryDate).toISOString().slice(0, 10),
      Amount: e.amount,
      'Payout account': e.payoutAccount,
      'Prepared by': e.preparedBy ? `${e.preparedBy.firstName} ${e.preparedBy.lastName}` : '',
      Note: e.note || '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 13 }, { wch: 36 }, { wch: 18 }, { wch: 10 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 20 }, { wch: 30 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Accounts');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="accounts-snapshot.xlsx"');
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
  } catch (err) {
    next(err);
  }
});

// POST /api/accounts — accountant/admin records a new entry (pending)
router.post('/', requirePermission('manage_accounts'), async (req, res, next) => {
  try {
    const { title, category, department, amount, entryDate, note, payoutAccount, fundAccountId } = req.body;
    if (!title || !category || amount === undefined) {
      return res.status(400).json({ error: 'Title, category and amount are required' });
    }
    if (!AccountEntry.CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });
    const amt = Number(amount);
    if (!(amt > 0)) return res.status(400).json({ error: 'Amount must be greater than zero' });
    if (payoutAccount && !['cash', 'bank', 'mobile_money'].includes(payoutAccount)) {
      return res.status(400).json({ error: 'Invalid payout account' });
    }

    const entry = await AccountEntry.create({
      organizationId: req.orgId,
      ref: await AccountEntry.nextRef(req.orgId),
      title: String(title).trim(),
      category,
      department: department || 'General Fund',
      amount: amt,
      entryDate: entryDate ? new Date(entryDate) : new Date(),
      note,
      payoutAccount: payoutAccount || 'bank',
      fundAccountId: fundAccountId || undefined,
      preparedBy: req.user._id,
    });
    audit(req, 'account_entry.create', { entityType: 'AccountEntry', entityId: entry._id, detail: { category, amount: amt } });
    res.status(201).json({ entry });
  } catch (err) {
    next(err);
  }
});

async function loadEntry(req, res, next) {
  try {
    const entry = await AccountEntry.findOne(orgFilter(req, { _id: req.params.id }));
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    req.entry = entry;
    next();
  } catch (err) {
    next(err);
  }
}

// GET /api/accounts/:id
router.get('/:id', loadEntry, async (req, res, next) => {
  try {
    await req.entry.populate([
      { path: 'preparedBy', select: 'firstName lastName role' },
      { path: 'decidedBy', select: 'firstName lastName role' },
      { path: 'paidBy', select: 'firstName lastName role' },
      { path: 'sourceClaimId', select: 'claimNumber' },
    ]);
    res.json({ entry: req.entry });
  } catch (err) {
    next(err);
  }
});

// POST /api/accounts/:id/decide — admin approves or rejects a pending entry
router.post('/:id/decide', requireRoles('admin'), loadEntry, async (req, res, next) => {
  // Approving an operations entry / expenditure is deliberately kept
  // administrator-only (not permission-grantable) — mirrors the same
  // separation-of-duties rule as claim decisions.
  try {
    const { decision, note } = req.body;
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Decision must be approved or rejected' });
    const entry = req.entry;
    if (entry.status !== 'pending') return res.status(400).json({ error: 'Only pending entries can be decided' });

    entry.status = decision;
    entry.decidedBy = req.user._id;
    entry.decidedAt = new Date();
    entry.decisionNote = note;
    await entry.save();
    audit(req, `account_entry.${decision}`, { entityType: 'AccountEntry', entityId: entry._id, detail: { note } });
    res.json({ entry });
  } catch (err) {
    next(err);
  }
});

// POST /api/accounts/:id/pay — accountant/admin pays an approved entry; posts to ledger
router.post('/:id/pay', requirePermission('manage_accounts'), loadEntry, async (req, res, next) => {
  try {
    const entry = req.entry;
    if (entry.status !== 'approved') return res.status(400).json({ error: 'Only approved entries can be paid' });
    const { paymentReference, payoutAccount, fundAccountId } = req.body;
    if (payoutAccount) {
      if (!['cash', 'bank', 'mobile_money'].includes(payoutAccount)) return res.status(400).json({ error: 'Invalid payout account' });
      entry.payoutAccount = payoutAccount;
    }
    if (fundAccountId) {
      const FundAccount = require('../models/FundAccount');
      const fund = await FundAccount.findOne(orgFilter(req, { _id: fundAccountId }));
      if (!fund) return res.status(400).json({ error: 'Invalid fund account' });
      entry.fundAccountId = fund._id;
    }
    entry.status = 'paid';
    entry.paidBy = req.user._id;
    entry.paidAt = new Date();
    entry.paymentReference = paymentReference;
    await entry.save();
    await postEntryToLedger(entry, req.user._id);
    audit(req, 'account_entry.pay', { entityType: 'AccountEntry', entityId: entry._id, detail: { amount: entry.amount, account: entry.payoutAccount } });
    res.json({ entry });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
