const express = require('express');
const ReversalRequest = require('../models/ReversalRequest');
const Contribution = require('../models/Contribution');
const LedgerEntry = require('../models/LedgerEntry');
const PaymentMode = require('../models/PaymentMode');
const { protect, requireRoles, requirePermission, requireOrg, orgFilter } = require('../middleware/auth');
const { audit } = require('../utils/audit');
const { getDefaultFundAccount } = require('../utils/fundAccounts');

const router = express.Router();

router.use(protect, requireOrg, requirePermission('view_contributions'));

// GET /api/reversals
router.get('/', async (req, res, next) => {
  try {
    const filter = orgFilter(req);
    if (req.query.status) filter.status = req.query.status;
    const items = await ReversalRequest.find(filter)
      .sort({ createdAt: -1 })
      .populate({ path: 'contributionId', populate: { path: 'memberId', select: 'firstName lastName' } })
      .populate('requestedBy', 'firstName lastName')
      .populate('decidedBy', 'firstName lastName')
      .populate('recommendedBy', 'firstName lastName');
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// POST /api/reversals — accountant/supervisor asks to reverse a contribution
router.post('/', async (req, res, next) => {
  try {
    const { contributionId, reason } = req.body;
    if (!contributionId || !reason) return res.status(400).json({ error: 'Contribution and reason are required' });
    const contribution = await Contribution.findOne(orgFilter(req, { _id: contributionId }));
    if (!contribution) return res.status(404).json({ error: 'Contribution not found' });
    if (contribution.status === 'reversed') return res.status(400).json({ error: 'This contribution is already reversed' });

    const existing = await ReversalRequest.findOne(orgFilter(req, { contributionId, status: 'pending' }));
    if (existing) return res.status(409).json({ error: 'A reversal request for this contribution is already pending' });

    const request = await ReversalRequest.create({
      organizationId: req.orgId,
      contributionId,
      reason,
      requestedBy: req.user._id,
    });
    audit(req, 'reversal.request', { entityType: 'ReversalRequest', entityId: request._id });
    res.status(201).json({ request });
  } catch (err) {
    next(err);
  }
});

// POST /api/reversals/:id/recommend — accountant leaves a non-binding
// recommendation for the administrator, who makes the actual decision.
router.post('/:id/recommend', requirePermission('manage_accounts'), async (req, res, next) => {
  try {
    const { recommendation, note } = req.body;
    if (!['recommend', 'flag'].includes(recommendation)) return res.status(400).json({ error: 'Recommendation must be recommend or flag' });
    const request = await ReversalRequest.findOne(orgFilter(req, { _id: req.params.id, status: 'pending' }));
    if (!request) return res.status(404).json({ error: 'Pending reversal request not found' });

    request.recommendation = recommendation;
    request.recommendedBy = req.user._id;
    request.recommendedAt = new Date();
    request.recommendationNote = note;
    await request.save();
    audit(req, `reversal.${recommendation}`, { entityType: 'ReversalRequest', entityId: request._id, detail: { note } });
    res.json({ request });
  } catch (err) {
    next(err);
  }
});

// POST /api/reversals/:id/decide — admin approves/rejects; approval reverses the ledger
router.post('/:id/decide', requireRoles('admin'), async (req, res, next) => {
  try {
    const { decision, note } = req.body;
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Decision must be approved or rejected' });

    const request = await ReversalRequest.findOne(orgFilter(req, { _id: req.params.id, status: 'pending' }));
    if (!request) return res.status(404).json({ error: 'Pending reversal request not found' });

    request.status = decision;
    request.decidedBy = req.user._id;
    request.decidedAt = new Date();
    request.decisionNote = note;
    await request.save();

    if (decision === 'approved') {
      const contribution = await Contribution.findOne(orgFilter(req, { _id: request.contributionId }));
      const wasPaid = contribution.status === 'paid';
      contribution.status = 'reversed';
      contribution.reversedAt = new Date();
      contribution.reversalId = request._id;
      await contribution.save();

      if (wasPaid) {
        const mode = contribution.paymentModeId ? await PaymentMode.findById(contribution.paymentModeId) : null;
        const account = mode ? mode.ledgerAccount : 'cash';
        const fundAccount = await getDefaultFundAccount(req.orgId, 'General Fund');
        // Mirror-image entries undo the original posting. Only the cash leg
        // is fund-tagged — see the matching note in contributions.js.
        await LedgerEntry.insertMany([
          {
            organizationId: req.orgId,
            account: 'contributions',
            category: 'adjustment',
            direction: 'debit',
            amount: contribution.amount,
            description: `Reversal of ${contribution.receiptNumber}`,
            sourceType: 'reversal',
            sourceId: request._id,
            memberId: contribution.memberId,
            createdBy: req.user._id,
          },
          {
            organizationId: req.orgId,
            account,
            fundAccountId: fundAccount._id,
            category: 'adjustment',
            direction: 'credit',
            amount: contribution.amount,
            description: `Reversal of ${contribution.receiptNumber}`,
            sourceType: 'reversal',
            sourceId: request._id,
            memberId: contribution.memberId,
            createdBy: req.user._id,
          },
        ]);
      }
    }

    audit(req, `reversal.${decision}`, { entityType: 'ReversalRequest', entityId: request._id, detail: { note } });
    res.json({ request });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
