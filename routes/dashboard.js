const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Contribution = require('../models/Contribution');
const Claim = require('../models/Claim');
const ReversalRequest = require('../models/ReversalRequest');
const { protect, requireRoles, requireOrg } = require('../middleware/auth');

const router = express.Router();

router.use(protect, requireOrg);

const oid = (v) => new mongoose.Types.ObjectId(String(v));

// GET /api/dashboard/admin?year=2026&month=all
router.get('/admin', requireRoles('admin', 'supervisor', 'accountant'), async (req, res, next) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const month = req.query.month && req.query.month !== 'all' ? Number(req.query.month) : null;
    const orgId = oid(req.orgId);

    const periodMatch = { organizationId: orgId, year, status: { $ne: 'reversed' } };
    if (month) periodMatch.month = month;

    const [totalMembers, periodAgg, monthlyAgg, activeMemberIds, pendingReversals, pendingClaims, recent] = await Promise.all([
      User.countDocuments({ organizationId: orgId }),
      Contribution.aggregate([
        { $match: periodMatch },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Contribution.aggregate([
        { $match: { organizationId: orgId, year, status: { $ne: 'reversed' } } },
        { $group: { _id: '$month', total: { $sum: '$amount' } } },
      ]),
      Contribution.distinct('memberId', periodMatch),
      ReversalRequest.countDocuments({ organizationId: orgId, status: 'pending' }),
      Claim.countDocuments({ organizationId: orgId, status: { $in: ['submitted', 'under_review'] } }),
      Contribution.find({ organizationId: orgId, status: { $ne: 'reversed' } })
        .sort({ contributionDate: -1 })
        .limit(6)
        .populate('memberId', 'firstName lastName'),
    ]);

    const monthly = Array.from({ length: 12 }, (_, i) => {
      const hit = monthlyAgg.find((m) => m._id === i + 1);
      return hit ? hit.total : 0;
    });

    res.json({
      year,
      month,
      totalMembers,
      periodTotal: periodAgg[0]?.total || 0,
      periodCount: periodAgg[0]?.count || 0,
      activeMembers: activeMemberIds.length,
      pendingReversals,
      pendingClaims,
      monthly,
      recent,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/member — the signed-in member's own summary
router.get('/member', async (req, res, next) => {
  try {
    const orgId = oid(req.orgId);
    const memberId = req.user._id;
    const now = new Date();

    const [totalAgg, monthAgg, lastContribution, claims, recentContributions] = await Promise.all([
      Contribution.aggregate([
        { $match: { organizationId: orgId, memberId, status: { $ne: 'reversed' } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Contribution.aggregate([
        { $match: { organizationId: orgId, memberId, year: now.getFullYear(), month: now.getMonth() + 1, status: { $ne: 'reversed' } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Contribution.findOne({ organizationId: orgId, memberId, status: { $ne: 'reversed' } }).sort({ contributionDate: -1 }),
      Claim.find({ organizationId: orgId, memberId }).sort({ createdAt: -1 }).limit(10).populate('claimTypeId', 'name'),
      Contribution.find({ organizationId: orgId, memberId, status: { $ne: 'reversed' } })
        .sort({ contributionDate: -1 })
        .limit(12)
        .populate('recordedBy', 'firstName lastName'),
    ]);

    const active = claims.filter((c) => ['submitted', 'under_review'].includes(c.status)).length;
    const approved = claims.filter((c) => ['approved', 'paid'].includes(c.status)).length;

    res.json({
      totalContributed: totalAgg[0]?.total || 0,
      contributionCount: totalAgg[0]?.count || 0,
      monthTotal: monthAgg[0]?.total || 0,
      lastContribution,
      claimsSummary: { total: claims.length, active, approved },
      claims,
      recentContributions,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
