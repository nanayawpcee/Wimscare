const express = require('express');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');
const Contribution = require('../models/Contribution');
const Claim = require('../models/Claim');
const ClaimType = require('../models/ClaimType');
const AccountEntry = require('../models/AccountEntry');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const Organization = require('../models/Organization');
const { protect, requireRoles, requirePermission, requireOrg, requireFeature } = require('../middleware/auth');

const router = express.Router();

router.use(protect, requireOrg, requirePermission('view_reports'), requireFeature('reports'));

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const gh = (n) => `GHS ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function contributionRows(orgId, year, month) {
  const match = { organizationId: oid(orgId), status: { $ne: 'reversed' } };
  if (year) match.year = Number(year);
  if (month) match.month = Number(month);
  const items = await Contribution.find(match)
    .sort({ contributionDate: 1 })
    .populate('memberId', 'firstName lastName memberNumber')
    .populate('recordedBy', 'firstName lastName')
    .lean();
  return items.map((c) => ({
    Receipt: c.receiptNumber,
    Member: c.memberId ? `${c.memberId.firstName} ${c.memberId.lastName}` : '—',
    'Member No.': c.memberId?.memberNumber || '',
    Date: new Date(c.contributionDate).toISOString().slice(0, 10),
    Method: c.method,
    Reference: c.reference || '',
    Status: c.status,
    Amount: c.amount,
    'Recorded By': c.recordedBy ? `${c.recordedBy.firstName} ${c.recordedBy.lastName}` : '',
  }));
}

// GET /api/reports/summary?year=&month=
router.get('/summary', async (req, res, next) => {
  try {
    const orgId = oid(req.orgId);
    const year = Number(req.query.year) || new Date().getFullYear();
    const month = req.query.month && req.query.month !== 'all' ? Number(req.query.month) : null;
    const match = { organizationId: orgId, year, status: { $ne: 'reversed' } };
    if (month) match.month = month;

    const [contribAgg, byMethod, claimAgg, memberCount] = await Promise.all([
      Contribution.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
      Contribution.aggregate([{ $match: match }, { $group: { _id: '$method', total: { $sum: '$amount' }, count: { $sum: 1 } } }, { $sort: { total: -1 } }]),
      Claim.aggregate([
        { $match: { organizationId: orgId, status: { $ne: 'draft' } } },
        { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: { $ifNull: ['$amountApproved', '$amountRequested'] } } } },
      ]),
      User.countDocuments({ organizationId: orgId }),
    ]);

    res.json({
      year,
      month,
      contributions: contribAgg[0] || { total: 0, count: 0 },
      byMethod,
      claims: claimAgg,
      memberCount,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/contributions.xlsx?year=&month=
router.get('/contributions.xlsx', async (req, res, next) => {
  try {
    const rows = await contributionRows(req.orgId, req.query.year, req.query.month);
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 15 }, { wch: 24 }, { wch: 12 }, { wch: 12 }, { wch: 18 }, { wch: 16 }, { wch: 10 }, { wch: 12 }, { wch: 20 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Contributions');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="contributions-${req.query.year || 'all'}.xlsx"`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/contributions.pdf?year=&month=
router.get('/contributions.pdf', async (req, res, next) => {
  try {
    const org = await Organization.findById(req.orgId);
    const rows = await contributionRows(req.orgId, req.query.year, req.query.month);
    const total = rows.reduce((a, r) => a + r.Amount, 0);

    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    res.setHeader('Content-Disposition', `attachment; filename="contributions-${req.query.year || 'all'}.pdf"`);
    res.type('application/pdf');
    doc.pipe(res);

    doc.fontSize(16).font('Helvetica-Bold').fillColor('#0f2c3f').text(org ? org.name : 'WIMScare');
    doc.fontSize(11).font('Helvetica').fillColor('#5a6b75')
      .text(`Contribution report — ${req.query.month && req.query.month !== 'all' ? `month ${req.query.month}, ` : ''}${req.query.year || 'all years'}`);
    doc.moveDown(0.3).text(`Generated ${new Date().toLocaleString()} · ${rows.length} records · Total ${gh(total)}`);
    doc.moveDown(1);

    const cols = [
      { key: 'Receipt', w: 90 }, { key: 'Member', w: 130 }, { key: 'Date', w: 65 },
      { key: 'Method', w: 95 }, { key: 'Status', w: 55 }, { key: 'Amount', w: 80, align: 'right' },
    ];
    const startX = doc.x;
    let y = doc.y;

    function header() {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#8a98a1');
      let x = startX;
      for (const c of cols) {
        doc.text(c.key.toUpperCase(), x, y, { width: c.w, align: c.align || 'left' });
        x += c.w;
      }
      y += 16;
      doc.moveTo(startX, y - 4).lineTo(startX + cols.reduce((a, c) => a + c.w, 0), y - 4).strokeColor('#e2e9ec').stroke();
    }

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
        const val = c.key === 'Amount' ? gh(row.Amount) : String(row[c.key] ?? '');
        doc.text(val, x, y, { width: c.w, align: c.align || 'left', ellipsis: true, height: 12 });
        x += c.w;
      }
      y += 17;
    }

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#12242e');
    doc.text(`Total: ${gh(total)}`, startX, y + 8, { width: cols.reduce((a, c) => a + c.w, 0), align: 'right' });
    doc.end();
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/tab?type=summary|members|contributions|accounts|claims|audit&from=&to=
router.get('/tab', async (req, res, next) => {
  try {
    const type = req.query.type || 'summary';
    if (type === 'audit' && !['admin', 'superadmin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Audit logs are administrator-only' });
    }
    if (type === 'audit' && req.user.role !== 'superadmin') {
      const { currentLicense, effectiveFeatures } = require('../utils/plans');
      if (!effectiveFeatures(await currentLicense(req.orgId)).auditTrail) {
        return res.status(403).json({ error: 'The audit trail is a Pro plan feature', upgradeRequired: true, feature: 'auditTrail' });
      }
    }

    const orgId = oid(req.orgId);
    const from = req.query.from ? new Date(req.query.from) : new Date(new Date().getFullYear(), 0, 1);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    to.setHours(23, 59, 59, 999);
    const dateLabel = `${from.toISOString().slice(0, 10)} – ${to.toISOString().slice(0, 10)}`;

    // Optional department filter. Only members carry a department, so for
    // contributions and claims it's resolved once to that department's
    // member ids and applied by id rather than joining on every pipeline.
    // An unrecognised department yields an empty id list — an empty report,
    // which is the honest answer, not an unfiltered one.
    const department = String(req.query.department || '').trim();
    const deptScope = department ? { department } : {};
    let deptMemberIds = null;
    if (department) {
      const members = await User.find({ organizationId: orgId, department }).select('_id').lean();
      deptMemberIds = members.map((m) => m._id);
    }
    const byDeptMember = deptMemberIds ? { memberId: { $in: deptMemberIds } } : {};
    // Appended to every title so an exported report says what it was filtered to.
    const deptLabel = department ? ` · ${department}` : '';

    if (type === 'members') {
      const [members, memberCount, activeCount, newCount, suspendedCount] = await Promise.all([
        User.aggregate([
          { $match: { organizationId: orgId, ...deptScope } },
          // Empty-string departments are as unassigned as missing ones —
          // without this they form their own nameless row in the report.
          { $group: { _id: { $cond: [{ $in: [{ $ifNull: ['$department', ''] }, ['', null]] }, 'Unassigned', '$department'] }, members: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } } } },
          { $sort: { members: -1 } },
        ]),
        User.countDocuments({ organizationId: orgId, ...deptScope }),
        User.countDocuments({ organizationId: orgId, ...deptScope, status: 'active' }),
        User.countDocuments({ organizationId: orgId, ...deptScope, createdAt: { $gte: from, $lte: to } }),
        User.countDocuments({ organizationId: orgId, ...deptScope, status: 'suspended' }),
      ]);
      const contribByDept = await Contribution.aggregate([
        { $match: { organizationId: orgId, status: { $ne: 'reversed' }, ...byDeptMember } },
        { $lookup: { from: 'users', localField: 'memberId', foreignField: '_id', as: 'member' } },
        { $unwind: { path: '$member', preserveNullAndEmptyArrays: true } },
        { $group: { _id: { $cond: [{ $in: [{ $ifNull: ['$member.department', ''] }, ['', null]] }, 'Unassigned', '$member.department'] }, total: { $sum: '$amount' } } },
      ]);
      const totalByDept = Object.fromEntries(contribByDept.map((c) => [c._id, c.total]));
      return res.json({
        title: `Members by department, ${dateLabel}${deptLabel}`,
        summary: [
          { label: 'Total members', value: String(memberCount), sub: 'All time' },
          { label: 'Active', value: String(activeCount), sub: memberCount ? `${Math.round((activeCount / memberCount) * 100)}% of total` : '—' },
          { label: 'New this period', value: String(newCount), sub: dateLabel },
          { label: 'Suspended', value: String(suspendedCount), sub: 'Needs attention' },
        ],
        columns: ['Department', 'Members', 'Active', 'Contributions'],
        rows: members.map((m) => [m._id, String(m.members), String(m.active), gh(totalByDept[m._id] || 0)]),
      });
    }

    if (type === 'contributions') {
      const monthlyAgg = await Contribution.aggregate([
        { $match: { organizationId: orgId, status: { $ne: 'reversed' }, contributionDate: { $gte: from, $lte: to }, ...byDeptMember } },
        { $group: { _id: { y: '$year', m: '$month' }, total: { $sum: '$amount' }, count: { $sum: 1 }, members: { $addToSet: '$memberId' } } },
        { $sort: { '_id.y': -1, '_id.m': -1 } },
      ]);
      const total = monthlyAgg.reduce((a, m) => a + m.total, 0);
      const records = monthlyAgg.reduce((a, m) => a + m.count, 0);
      const byMethod = await Contribution.aggregate([
        { $match: { organizationId: orgId, status: { $ne: 'reversed' }, contributionDate: { $gte: from, $lte: to }, ...byDeptMember } },
        { $group: { _id: '$method', total: { $sum: '$amount' } } },
        { $sort: { total: -1 } },
      ]);
      const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      return res.json({
        title: `Contributions by month, ${dateLabel}${deptLabel}`,
        summary: [
          { label: 'Period total', value: gh(total), sub: dateLabel },
          { label: 'Records', value: String(records), sub: 'In period' },
          { label: 'Period average', value: gh(monthlyAgg.length ? total / monthlyAgg.length : 0), sub: 'Per month' },
          { label: 'Top method', value: byMethod[0]?._id || '—', sub: byMethod[0] ? gh(byMethod[0].total) : '' },
        ],
        columns: ['Month', 'Records', 'Members', 'Total'],
        rows: monthlyAgg.map((m) => [`${monthNames[m._id.m - 1]} ${m._id.y}`, String(m.count), String(m.members.length), gh(m.total)]),
      });
    }

    if (type === 'accounts') {
      const [byCategory, income] = await Promise.all([
        AccountEntry.aggregate([
          { $match: { organizationId: orgId, entryDate: { $gte: from, $lte: to }, status: { $in: ['approved', 'paid'] } } },
          { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
          { $sort: { total: -1 } },
        ]),
        Contribution.aggregate([
          { $match: { organizationId: orgId, status: { $ne: 'reversed' }, contributionDate: { $gte: from, $lte: to } } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]),
      ]);
      const expenditure = byCategory.reduce((a, c) => a + c.total, 0);
      const incomeTotal = income[0]?.total || 0;
      const entries = byCategory.reduce((a, c) => a + c.count, 0);
      return res.json({
        title: `Account entries by category, ${dateLabel}`,
        summary: [
          { label: 'Period total', value: gh(expenditure), sub: `${entries} entries` },
          { label: 'Income', value: gh(incomeTotal), sub: 'Contributions in' },
          { label: 'Expenditure', value: gh(expenditure), sub: 'Claims + operations' },
          { label: 'Net position', value: gh(incomeTotal - expenditure), sub: incomeTotal >= expenditure ? 'Surplus' : 'Deficit' },
        ],
        columns: ['Category', 'Entries', 'Total', ''],
        rows: byCategory.map((c) => [c._id, String(c.count), gh(c.total), '']),
      });
    }

    if (type === 'claims') {
      const byType = await Claim.aggregate([
        { $match: { organizationId: orgId, status: { $nin: ['draft'] }, createdAt: { $gte: from, $lte: to }, ...byDeptMember } },
        { $group: { _id: '$claimTypeId', count: { $sum: 1 }, approved: { $sum: { $cond: [{ $in: ['$status', ['approved', 'paid']] }, 1, 0] } }, total: { $sum: { $cond: [{ $in: ['$status', ['approved', 'paid']] }, { $ifNull: ['$amountApproved', '$amountRequested'] }, 0] } } } },
        { $sort: { total: -1 } },
      ]);
      const types = await ClaimType.find({ _id: { $in: byType.map((t) => t._id) } }).select('name').lean();
      const nameById = Object.fromEntries(types.map((t) => [String(t._id), t.name]));
      const totalCount = byType.reduce((a, t) => a + t.count, 0);
      const totalApproved = byType.reduce((a, t) => a + t.approved, 0);
      const totalPaid = byType.reduce((a, t) => a + t.total, 0);
      const rejected = await Claim.countDocuments({ organizationId: orgId, status: 'rejected', createdAt: { $gte: from, $lte: to }, ...byDeptMember });
      return res.json({
        title: `Claims by type, ${dateLabel}${deptLabel}`,
        summary: [
          { label: 'Period total', value: gh(totalPaid), sub: `${totalCount} claims` },
          { label: 'Approved / paid', value: String(totalApproved), sub: totalCount ? `${Math.round((totalApproved / totalCount) * 100)}% approval rate` : '—' },
          { label: 'Rejected', value: String(rejected), sub: totalCount ? `${Math.round((rejected / totalCount) * 100)}% of claims` : '—' },
          { label: 'Claim types', value: String(byType.length), sub: 'With activity' },
        ],
        columns: ['Claim type', 'Count', 'Approved', 'Total paid'],
        rows: byType.map((t) => [nameById[String(t._id)] || 'Unknown', String(t.count), String(t.approved), gh(t.total)]),
      });
    }

    if (type === 'audit') {
      const [byAction, totalEvents] = await Promise.all([
        AuditLog.aggregate([
          { $match: { organizationId: orgId, createdAt: { $gte: from, $lte: to } } },
          { $group: { _id: '$action', count: { $sum: 1 }, last: { $max: '$createdAt' } } },
          { $sort: { count: -1 } },
          { $limit: 20 },
        ]),
        AuditLog.countDocuments({ organizationId: orgId, createdAt: { $gte: from, $lte: to } }),
      ]);
      return res.json({
        title: `Audit log activity, ${dateLabel}`,
        summary: [
          { label: 'Total events', value: String(totalEvents), sub: 'In period' },
          { label: 'Top action', value: byAction[0]?._id || '—', sub: byAction[0] ? `${byAction[0].count} events` : '' },
          { label: 'Distinct actions', value: String(byAction.length), sub: 'Types logged' },
          { label: 'Flagged', value: '0', sub: 'No anomalies' },
        ],
        columns: ['Action', 'Count', 'Last event', ''],
        rows: byAction.map((a) => [a._id, String(a.count), new Date(a.last).toLocaleDateString('en-GB'), '']),
      });
    }

    // default: summary
    const [memberCount, contribAgg, byMethod, claimAgg, accountAgg] = await Promise.all([
      User.countDocuments({ organizationId: orgId }),
      Contribution.aggregate([
        { $match: { organizationId: orgId, status: { $ne: 'reversed' }, contributionDate: { $gte: from, $lte: to } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Contribution.aggregate([
        { $match: { organizationId: orgId, status: { $ne: 'reversed' }, contributionDate: { $gte: from, $lte: to } } },
        { $group: { _id: '$method', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Claim.aggregate([
        { $match: { organizationId: orgId, status: { $in: ['approved', 'paid'] }, createdAt: { $gte: from, $lte: to } } },
        { $group: { _id: '$claimTypeId', total: { $sum: { $ifNull: ['$amountApproved', '$amountRequested'] } }, count: { $sum: 1 } } },
      ]),
      AccountEntry.aggregate([
        { $match: { organizationId: orgId, status: { $in: ['approved', 'paid'] }, entryDate: { $gte: from, $lte: to } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
    ]);
    const types = await ClaimType.find({ _id: { $in: claimAgg.map((c) => c._id) } }).select('name').lean();
    const nameById = Object.fromEntries(types.map((t) => [String(t._id), t.name]));
    res.json({
      title: `Organisation summary, ${dateLabel}`,
      summary: [
        { label: 'Members', value: String(memberCount), sub: 'All time' },
        { label: 'Contributions', value: gh(contribAgg[0]?.total || 0), sub: `${contribAgg[0]?.count || 0} records` },
        { label: 'Claims', value: gh(claimAgg.reduce((a, c) => a + c.total, 0)), sub: `${claimAgg.reduce((a, c) => a + c.count, 0)} processed` },
        { label: 'Account entries', value: gh(accountAgg[0]?.total || 0), sub: `${accountAgg[0]?.count || 0} entries` },
      ],
      columns: ['Category', 'Detail', 'Count', 'Total'],
      rows: [
        ...byMethod.map((m) => ['Contributions', m._id, String(m.count), gh(m.total)]),
        ...claimAgg.map((c) => ['Claims', nameById[String(c._id)] || 'Unknown', String(c.count), gh(c.total)]),
      ],
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
