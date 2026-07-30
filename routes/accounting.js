const express = require('express');
const mongoose = require('mongoose');
const LedgerEntry = require('../models/LedgerEntry');
const { protect, requireRoles, requireOrg, orgFilter, requireFeature } = require('../middleware/auth');
const { audit } = require('../utils/audit');

const router = express.Router();

router.use(protect, requireOrg, requireRoles('admin', 'accountant'), requireFeature('accountsManagement'));

const oid = (v) => new mongoose.Types.ObjectId(String(v));

// GET /api/accounting/ledger?account=&from=&to=&page=
router.get('/ledger', async (req, res, next) => {
  try {
    const { account, from, to, page = 1, limit = 30 } = req.query;
    const filter = orgFilter(req);
    if (account) filter.account = account;
    if (from || to) {
      filter.entryDate = {};
      if (from) filter.entryDate.$gte = new Date(from);
      if (to) filter.entryDate.$lte = new Date(to);
    }
    const perPage = Math.min(Number(limit) || 30, 100);
    const [items, total] = await Promise.all([
      LedgerEntry.find(filter)
        .sort({ entryDate: -1, _id: -1 })
        .skip((Number(page) - 1) * perPage)
        .limit(perPage)
        .populate('memberId', 'firstName lastName')
        .populate('createdBy', 'firstName lastName'),
      LedgerEntry.countDocuments(filter),
    ]);
    res.json({ items, total, page: Number(page), pages: Math.ceil(total / perPage) });
  } catch (err) {
    next(err);
  }
});

// GET /api/accounting/balances — per-account debit/credit totals
router.get('/balances', async (req, res, next) => {
  try {
    const agg = await LedgerEntry.aggregate([
      { $match: { organizationId: oid(req.orgId) } },
      {
        $group: {
          _id: '$account',
          debits: { $sum: { $cond: [{ $eq: ['$direction', 'debit'] }, '$amount', 0] } },
          credits: { $sum: { $cond: [{ $eq: ['$direction', 'credit'] }, '$amount', 0] } },
        },
      },
    ]);
    const balances = agg.map((a) => ({
      account: a._id,
      debits: a.debits,
      credits: a.credits,
      net: a.debits - a.credits,
    }));
    res.json({ balances });
  } catch (err) {
    next(err);
  }
});

// POST /api/accounting/manual — balanced manual adjustment (both legs required)
router.post('/manual', requireRoles('admin'), async (req, res, next) => {
  try {
    const { debitAccount, creditAccount, amount, description, entryDate } = req.body;
    const accounts = ['contributions', 'claims_payable', 'expenses', 'cash', 'bank', 'mobile_money', 'adjustments'];
    if (!accounts.includes(debitAccount) || !accounts.includes(creditAccount)) {
      return res.status(400).json({ error: 'Invalid account' });
    }
    if (debitAccount === creditAccount) return res.status(400).json({ error: 'Debit and credit accounts must differ' });
    const amt = Number(amount);
    if (!(amt > 0)) return res.status(400).json({ error: 'Amount must be greater than zero' });

    const base = {
      organizationId: req.orgId,
      entryDate: entryDate ? new Date(entryDate) : new Date(),
      amount: amt,
      description: description || 'Manual adjustment',
      sourceType: 'manual',
      createdBy: req.user._id,
    };
    const entries = await LedgerEntry.insertMany([
      { ...base, account: debitAccount, direction: 'debit' },
      { ...base, account: creditAccount, direction: 'credit' },
    ]);
    audit(req, 'ledger.manual', { entityType: 'LedgerEntry', detail: { debitAccount, creditAccount, amount: amt } });
    res.status(201).json({ entries });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
