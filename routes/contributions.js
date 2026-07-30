const express = require('express');
const mongoose = require('mongoose');
const Contribution = require('../models/Contribution');
const LedgerEntry = require('../models/LedgerEntry');
const PaymentMode = require('../models/PaymentMode');
const User = require('../models/User');
const Organization = require('../models/Organization');
const { protect, requireRoles, requireOrg, orgFilter } = require('../middleware/auth');
const { receipt } = require('../middleware/upload');
const storage = require('../utils/storage');
const { sendContributionReceiptEmail } = require('../utils/email');
const { audit } = require('../utils/audit');
const { getDefaultFundAccount } = require('../utils/fundAccounts');

const router = express.Router();

router.use(protect, requireOrg);

// Post the double-entry pair for a contribution into the ledger. Only the
// cash-movement leg (the asset account that actually received the money) is
// tagged with a fundAccountId — the revenue-recognition leg ('contributions')
// is pure bookkeeping and would otherwise net every fund-account entry to
// zero if tagged too. See routes/fundAccounts.js for how this is read back.
async function postContributionToLedger(contribution, ledgerAccount, actorId) {
  // Use the fund chosen when recording the contribution; fall back to the
  // General Fund for older records / when none was picked.
  const fundAccountId =
    contribution.fundAccountId || (await getDefaultFundAccount(contribution.organizationId, 'General Fund'))._id;
  await LedgerEntry.insertMany([
    {
      organizationId: contribution.organizationId,
      entryDate: contribution.contributionDate,
      account: ledgerAccount,
      fundAccountId,
      category: 'member_dues',
      direction: 'debit',
      amount: contribution.amount,
      description: `Contribution ${contribution.receiptNumber}`,
      sourceType: 'contribution',
      sourceId: contribution._id,
      memberId: contribution.memberId,
      createdBy: actorId,
    },
    {
      organizationId: contribution.organizationId,
      entryDate: contribution.contributionDate,
      account: 'contributions',
      category: 'member_dues',
      direction: 'credit',
      amount: contribution.amount,
      description: `Contribution ${contribution.receiptNumber}`,
      sourceType: 'contribution',
      sourceId: contribution._id,
      memberId: contribution.memberId,
      createdBy: actorId,
    },
  ]);
}

// Shared list filter for the list endpoint and the exports.
async function buildListFilter(req) {
  const { memberId, year, month, status, q, from, to } = req.query;
  const filter = orgFilter(req);
  const isStaff = ['admin', 'supervisor', 'accountant', 'superadmin'].includes(req.user.role);
  filter.memberId = isStaff ? memberId || undefined : req.user._id;
  if (!filter.memberId) delete filter.memberId;
  if (year) filter.year = Number(year);
  if (month) filter.month = Number(month);
  if (status) filter.status = status;
  if (from || to) {
    filter.contributionDate = {};
    if (from) filter.contributionDate.$gte = new Date(from);
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      filter.contributionDate.$lte = end;
    }
  }
  if (q && isStaff) {
    const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const members = await User.find(orgFilter(req, { $or: [{ firstName: rx }, { lastName: rx }, { email: rx }] })).select('_id');
    filter.$or = [{ receiptNumber: rx }, { note: rx }, { reference: rx }, { memberId: { $in: members.map((m) => m._id) } }];
  }
  return filter;
}

// GET /api/contributions — admins see all; members see their own
router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const filter = await buildListFilter(req);

    // Aggregation pipelines do not cast strings to ObjectIds — build an explicit match.
    const match = { organizationId: new mongoose.Types.ObjectId(req.orgId), status: { $ne: 'reversed' } };
    if (filter.memberId) match.memberId = new mongoose.Types.ObjectId(String(filter.memberId));
    if (filter.year) match.year = filter.year;
    if (filter.month) match.month = filter.month;
    if (filter.contributionDate) match.contributionDate = filter.contributionDate;

    const perPage = Math.min(Number(limit) || 20, 100);
    const [items, total, sums] = await Promise.all([
      Contribution.find(filter)
        .sort({ contributionDate: -1 })
        .skip((Number(page) - 1) * perPage)
        .limit(perPage)
        .populate('memberId', 'firstName lastName email memberNumber')
        .populate('recordedBy', 'firstName lastName'),
      Contribution.countDocuments(filter),
      Contribution.aggregate([
        { $match: match },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
    ]);
    res.json({
      items,
      total,
      page: Number(page),
      pages: Math.ceil(total / perPage),
      summary: sums[0] || { total: 0, count: 0 },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/contributions — record a contribution (staff only)
router.post('/', requireRoles('admin', 'supervisor', 'accountant'), receipt.single('receipt'), async (req, res, next) => {
  try {
    const { memberId, amount, paymentModeId, fundAccountId, reference, note, contributionDate, status } = req.body;
    if (!memberId || !amount) return res.status(400).json({ error: 'Member and amount are required' });
    const numAmount = Number(amount);
    if (!(numAmount > 0)) return res.status(400).json({ error: 'Amount must be greater than zero' });

    const member = await User.findOne(orgFilter(req, { _id: memberId }));
    if (!member) return res.status(404).json({ error: 'Member not found in this organization' });

    // Optional deposit fund — must belong to this organization.
    let fund = null;
    if (fundAccountId) {
      const FundAccount = require('../models/FundAccount');
      fund = await FundAccount.findOne(orgFilter(req, { _id: fundAccountId, status: 'active' }));
      if (!fund) return res.status(400).json({ error: 'Invalid deposit fund' });
    }

    let mode = null;
    if (paymentModeId) {
      mode = await PaymentMode.findOne(orgFilter(req, { _id: paymentModeId, status: 'active' }));
      if (!mode) return res.status(400).json({ error: 'Invalid payment mode' });
      if (mode.requiresReference && !reference) {
        return res.status(400).json({ error: `${mode.name} payments require a transaction reference` });
      }
    }

    const receiptPath = req.file
      ? await storage.save(req.orgId, 'receipts', req.file.buffer, { originalName: req.file.originalname, contentType: req.file.mimetype })
      : undefined;

    const contribution = await Contribution.create({
      organizationId: req.orgId,
      receiptNumber: await Contribution.nextReceiptNumber(req.orgId),
      memberId,
      amount: numAmount,
      paymentModeId: mode ? mode._id : undefined,
      fundAccountId: fund ? fund._id : undefined,
      method: mode ? mode.name : 'Cash',
      reference,
      note,
      contributionDate: contributionDate ? new Date(contributionDate) : new Date(),
      status: ['paid', 'pending', 'review'].includes(status) ? status : 'paid',
      recordedBy: req.user._id,
      receiptPath,
    });

    if (contribution.status === 'paid') {
      await postContributionToLedger(contribution, mode ? mode.ledgerAccount : 'cash', req.user._id);
    }

    if (member.preferences?.contributionReceipts !== false) {
      const org = await Organization.findById(req.orgId);
      sendContributionReceiptEmail(member, contribution, org).catch(() => {});
    }

    audit(req, 'contribution.create', { entityType: 'Contribution', entityId: contribution._id, detail: { amount: numAmount, memberId } });
    res.status(201).json({ contribution });
  } catch (err) {
    next(err);
  }
});

// GET /api/contributions/stats — headline numbers + reversal banner data
router.get('/stats', requireRoles('admin', 'supervisor', 'accountant'), async (req, res, next) => {
  try {
    const ReversalRequest = require('../models/ReversalRequest');
    const orgId = new mongoose.Types.ObjectId(req.orgId);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);

    const [allTime, thisMonth, last12, pendingReversals, latestReversal] = await Promise.all([
      Contribution.aggregate([
        { $match: { organizationId: orgId, status: { $ne: 'reversed' } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Contribution.aggregate([
        { $match: { organizationId: orgId, status: { $ne: 'reversed' }, contributionDate: { $gte: monthStart } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Contribution.aggregate([
        { $match: { organizationId: orgId, status: { $ne: 'reversed' }, contributionDate: { $gte: twelveMonthsAgo } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      ReversalRequest.countDocuments({ organizationId: orgId, status: 'pending' }),
      ReversalRequest.findOne({ organizationId: orgId, status: 'pending' })
        .sort({ createdAt: -1 })
        .populate({ path: 'contributionId', select: 'amount', populate: { path: 'memberId', select: 'firstName lastName' } }),
    ]);

    res.json({
      total: allTime[0]?.total || 0,
      count: allTime[0]?.count || 0,
      monthTotal: thisMonth[0]?.total || 0,
      avgMonthly: (last12[0]?.total || 0) / 12,
      pendingReversals: {
        count: pendingReversals,
        latest: latestReversal && latestReversal.contributionId
          ? {
              member: latestReversal.contributionId.memberId
                ? `${latestReversal.contributionId.memberId.firstName} ${latestReversal.contributionId.memberId.lastName}`
                : '—',
              amount: latestReversal.contributionId.amount,
              requestedAt: latestReversal.createdAt,
            }
          : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// --- Exports (honor the same filters as the list) ---

async function exportRows(req) {
  const filter = await buildListFilter(req);
  const items = await Contribution.find(filter)
    .sort({ contributionDate: -1 })
    .populate('memberId', 'firstName lastName email memberNumber')
    .populate('recordedBy', 'firstName lastName')
    .lean();
  return items.map((c) => ({
    Receipt: c.receiptNumber,
    Date: new Date(c.contributionDate).toISOString().slice(0, 10),
    Member: c.memberId ? `${c.memberId.firstName} ${c.memberId.lastName}` : '—',
    Email: c.memberId?.email || '',
    Method: c.method,
    Account: c.reference || '',
    Note: c.note || '',
    Status: c.status,
    Amount: c.amount,
    'Recorded by': c.recordedBy ? `${c.recordedBy.firstName} ${c.recordedBy.lastName}` : '',
  }));
}

router.get('/export.xlsx', requireRoles('admin', 'supervisor', 'accountant'), async (req, res, next) => {
  try {
    const XLSX = require('xlsx');
    const rows = await exportRows(req);
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 15 }, { wch: 12 }, { wch: 24 }, { wch: 28 }, { wch: 18 }, { wch: 16 }, { wch: 26 }, { wch: 10 }, { wch: 12 }, { wch: 20 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Contributions');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="contributions.xlsx"');
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
  } catch (err) {
    next(err);
  }
});

router.get('/export.csv', requireRoles('admin', 'supervisor', 'accountant'), async (req, res, next) => {
  try {
    const rows = await exportRows(req);
    const headers = ['Receipt', 'Date', 'Member', 'Email', 'Method', 'Account', 'Note', 'Status', 'Amount', 'Recorded by'];
    const cell = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\n');
    res.setHeader('Content-Disposition', 'attachment; filename="contributions.csv"');
    res.type('text/csv').send(csv);
  } catch (err) {
    next(err);
  }
});

router.get('/export.pdf', requireRoles('admin', 'supervisor', 'accountant'), async (req, res, next) => {
  try {
    const PDFDocument = require('pdfkit');
    const Organization = require('../models/Organization');
    const org = await Organization.findById(req.orgId);
    const rows = await exportRows(req);
    const total = rows.filter((r) => r.Status !== 'reversed').reduce((a, r) => a + r.Amount, 0);
    const ghs = (n) => `GHS ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    res.setHeader('Content-Disposition', 'attachment; filename="contributions.pdf"');
    res.type('application/pdf');
    doc.pipe(res);

    doc.fontSize(16).font('Helvetica-Bold').fillColor('#0f2c3f').text(org ? org.name : 'WIMScare');
    const range = [req.query.from, req.query.to].filter(Boolean).join(' to ');
    doc.fontSize(11).font('Helvetica').fillColor('#5a6b75')
      .text(`Contributions${range ? ` — ${range}` : ''} · generated ${new Date().toLocaleString()} · ${rows.length} records · Total ${ghs(total)}`);
    doc.moveDown(1);

    const cols = [
      { key: 'Date', w: 62 }, { key: 'Member', w: 118 }, { key: 'Method', w: 92 },
      { key: 'Account', w: 78 }, { key: 'Note', w: 90 }, { key: 'Amount', w: 75, align: 'right' },
    ];
    const startX = doc.x;
    let y = doc.y;
    const header = () => {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#8a98a1');
      let x = startX;
      for (const c of cols) {
        doc.text(c.key.toUpperCase(), x, y, { width: c.w, align: c.align || 'left' });
        x += c.w;
      }
      y += 16;
      doc.moveTo(startX, y - 4).lineTo(startX + cols.reduce((a, c) => a + c.w, 0), y - 4).strokeColor('#e2e9ec').stroke();
    };
    header();
    doc.font('Helvetica').fontSize(9).fillColor('#12242e');
    for (const row of rows) {
      if (y > 780) {
        doc.addPage();
        y = doc.y;
        header();
        doc.font('Helvetica').fontSize(9).fillColor('#12242e');
      }
      let x = startX;
      for (const c of cols) {
        const val = c.key === 'Amount' ? ghs(row.Amount) : String(row[c.key] ?? '');
        doc.text(val, x, y, { width: c.w, align: c.align || 'left', ellipsis: true, height: 12 });
        x += c.w;
      }
      y += 17;
    }
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#12242e');
    doc.text(`Total: ${ghs(total)}`, startX, y + 8, { width: cols.reduce((a, c) => a + c.w, 0), align: 'right' });
    doc.end();
  } catch (err) {
    next(err);
  }
});

// POST /api/contributions/bulk — CSV import (client sends parsed rows as JSON).
// Columns: date, email, amount, method, account, notes. Receipt emails are
// skipped on bulk import to avoid flooding members.
router.post('/bulk', requireRoles('admin', 'accountant'), async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'No rows to import' });
    if (rows.length > 500) return res.status(400).json({ error: 'Maximum 500 rows per import' });

    const modes = await PaymentMode.find(orgFilter(req, { status: 'active' }));
    const modeByName = new Map(modes.map((m) => [m.name.toLowerCase(), m]));
    const results = [];
    let imported = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const line = i + 1;
      const email = String(r.email || '').trim().toLowerCase();
      const amount = Number(r.amount);
      const date = r.date ? new Date(r.date) : null;

      if (!email) { results.push({ line, status: 'error', reason: 'Missing email' }); continue; }
      if (!(amount > 0)) { results.push({ line, email, status: 'error', reason: 'Amount must be a positive number' }); continue; }
      if (!date || isNaN(date)) { results.push({ line, email, status: 'error', reason: 'Invalid or missing date' }); continue; }

      const member = await User.findOne(orgFilter(req, { email }));
      if (!member) { results.push({ line, email, status: 'error', reason: 'No member with this email' }); continue; }

      const mode = r.method ? modeByName.get(String(r.method).trim().toLowerCase()) : null;
      const contribution = await Contribution.create({
        organizationId: req.orgId,
        receiptNumber: await Contribution.nextReceiptNumber(req.orgId),
        memberId: member._id,
        amount,
        paymentModeId: mode ? mode._id : undefined,
        method: mode ? mode.name : (String(r.method || 'Cash').trim() || 'Cash'),
        reference: String(r.account || '').trim() || undefined,
        note: String(r.notes || '').trim() || undefined,
        contributionDate: date,
        status: 'paid',
        recordedBy: req.user._id,
      });
      await postContributionToLedger(contribution, mode ? mode.ledgerAccount : 'cash', req.user._id);
      imported++;
      results.push({ line, email, status: 'imported', receipt: contribution.receiptNumber });
    }

    audit(req, 'contribution.bulk_import', { detail: { imported, failed: rows.length - imported } });
    res.status(imported ? 201 : 400).json({
      imported,
      failed: rows.length - imported,
      results,
      message: imported
        ? `${imported} contribution${imported === 1 ? '' : 's'} imported${rows.length - imported ? `, ${rows.length - imported} failed` : ''}`
        : 'Nothing was imported — check the errors below',
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/contributions/:id
router.get('/:id', async (req, res, next) => {
  try {
    const filter = orgFilter(req, { _id: req.params.id });
    if (!['admin', 'supervisor', 'accountant', 'superadmin'].includes(req.user.role)) {
      filter.memberId = req.user._id;
    }
    const contribution = await Contribution.findOne(filter)
      .populate('memberId', 'firstName lastName email memberNumber')
      .populate('recordedBy', 'firstName lastName');
    if (!contribution) return res.status(404).json({ error: 'Contribution not found' });
    res.json({ contribution });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/contributions/:id — limited edits while pending/review
router.patch('/:id', requireRoles('admin', 'accountant'), async (req, res, next) => {
  try {
    const contribution = await Contribution.findOne(orgFilter(req, { _id: req.params.id }));
    if (!contribution) return res.status(404).json({ error: 'Contribution not found' });
    if (contribution.status === 'reversed') return res.status(400).json({ error: 'Reversed contributions cannot be edited' });

    if (['note', 'reference'].some((k) => req.body[k] !== undefined)) {
      if (req.body.note !== undefined) contribution.note = req.body.note;
      if (req.body.reference !== undefined) contribution.reference = req.body.reference;
    }
    if (req.body.status && ['paid', 'pending', 'review'].includes(req.body.status)) {
      const wasPaid = contribution.status === 'paid';
      contribution.status = req.body.status;
      if (!wasPaid && req.body.status === 'paid') {
        const mode = contribution.paymentModeId ? await PaymentMode.findById(contribution.paymentModeId) : null;
        await postContributionToLedger(contribution, mode ? mode.ledgerAccount : 'cash', req.user._id);
      }
    }
    await contribution.save();
    audit(req, 'contribution.update', { entityType: 'Contribution', entityId: contribution._id, detail: req.body });
    res.json({ contribution });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.postContributionToLedger = postContributionToLedger;
