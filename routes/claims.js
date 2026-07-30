const express = require('express');
const Claim = require('../models/Claim');
const ClaimType = require('../models/ClaimType');
const LedgerEntry = require('../models/LedgerEntry');
const User = require('../models/User');
const Organization = require('../models/Organization');
const { protect, requireRoles, requireOrg, orgFilter } = require('../middleware/auth');
const { claimDocs } = require('../middleware/upload');
const storage = require('../utils/storage');
const { sendClaimStatusEmail, sendClaimInfoRequestEmail } = require('../utils/email');
const { audit } = require('../utils/audit');
const { hasPermission } = require('../utils/permissions');
const { getDefaultFundAccount } = require('../utils/fundAccounts');

const router = express.Router();

router.use(protect, requireOrg);

const STAFF = ['admin', 'supervisor', 'accountant', 'superadmin'];
// Roles allowed to file a claim application on a member's behalf (not just
// their own). Accountants may still file for themselves as members, but
// cannot originate claims for other members.
const CAN_FILE_FOR_OTHERS = ['admin', 'supervisor', 'superadmin'];
// Approval-chain step -> the role that owns deciding it. 'committee' has no
// dedicated role in this app; an administrator stands in for the committee.
const STEP_ROLE = { supervisor: 'supervisor', accountant: 'accountant', admin: 'admin', committee: 'admin' };

function chainSteps(approvalChain) {
  if (approvalChain === 'admin') return ['admin'];
  if (approvalChain === 'committee') return ['committee'];
  return ['supervisor', 'accountant', 'admin'];
}

function pushTimeline(claim, actorId, event, note) {
  claim.timeline.push({ actor: actorId, event, note });
}

async function notifyMember(claim) {
  try {
    const [member, type, org] = await Promise.all([
      User.findById(claim.memberId),
      ClaimType.findById(claim.claimTypeId),
      Organization.findById(claim.organizationId),
    ]);
    if (member && member.preferences?.claimUpdates !== false) {
      await sendClaimStatusEmail(member, claim, type ? type.name : 'welfare', org);
    }
  } catch (err) {
    console.error('[claims] notify failed:', err.message);
  }
}

// GET /api/claims — staff see all, members see their own
router.get('/', async (req, res, next) => {
  try {
    const { status, memberId, claimTypeId, page = 1, limit = 20 } = req.query;
    const filter = orgFilter(req);
    if (STAFF.includes(req.user.role)) {
      if (memberId) filter.memberId = memberId;
      // staff lists never include other people's drafts
      filter.status = status ? status : { $ne: 'draft' };
    } else {
      filter.memberId = req.user._id;
      if (status) filter.status = status;
    }
    if (claimTypeId) filter.claimTypeId = claimTypeId;

    const perPage = Math.min(Number(limit) || 20, 100);
    const [items, total] = await Promise.all([
      Claim.find(filter)
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * perPage)
        .limit(perPage)
        .populate('memberId', 'firstName lastName email memberNumber')
        .populate('claimTypeId', 'name benefitLimit limitPer approvalChain'),
      Claim.countDocuments(filter),
    ]);
    res.json({ items, total, page: Number(page), pages: Math.ceil(total / perPage) });
  } catch (err) {
    next(err);
  }
});

// GET /api/claims/metrics — counts for the status filter cards
router.get('/metrics', requireRoles('admin', 'supervisor', 'accountant'), async (req, res, next) => {
  try {
    const mongoose = require('mongoose');
    const byStatus = await Claim.aggregate([
      { $match: { organizationId: new mongoose.Types.ObjectId(req.orgId) } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const count = (s) => byStatus.find((x) => x._id === s)?.count || 0;
    res.json({
      // "Total" tracks the review queue only (submitted onward); drafts are a
      // separate pre-submission bucket surfaced by its own card.
      total: byStatus.filter((x) => x._id !== 'draft').reduce((a, x) => a + x.count, 0),
      drafts: count('draft'),
      submitted: count('submitted'),
      underReview: count('under_review'),
      approvedOrPaid: count('approved') + count('paid'),
      rejected: count('rejected'),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/claims/attention — what needs the signed-in user's action NOW.
// Staff: open claims whose current (first pending) approval step belongs to
// their role — i.e. it's their turn in the chain — plus, for admins, any
// prepared payouts awaiting release. Members: their claims that were
// approved or paid, for the good-news banner on the dashboard.
router.get('/attention', async (req, res, next) => {
  try {
    if (!STAFF.includes(req.user.role)) {
      const items = await Claim.find({
        ...orgFilter(req, { memberId: req.user._id, status: { $in: ['approved', 'paid'] } }),
        $expr: { $ne: ['$memberBannerDismissedStatus', '$status'] },
      })
        .sort({ updatedAt: -1 })
        .limit(10)
        .select('claimNumber status amountApproved amountRequested decidedAt paidAt')
        .populate('claimTypeId', 'name');
      return res.json({ scope: 'member', items });
    }

    const open = await Claim.find(orgFilter(req, { status: { $in: ['submitted', 'under_review'] } }))
      .select('claimNumber approvals')
      .lean();
    const mine = open.filter((c) => {
      const current = (c.approvals || []).find((a) => a.decision === 'pending');
      return current && STEP_ROLE[current.step] === req.user.role;
    });
    const payoutsToRelease =
      req.user.role === 'admin'
        ? await Claim.countDocuments(orgFilter(req, { status: 'approved', 'disbursement.status': 'prepared' }))
        : 0;
    res.json({
      scope: 'staff',
      count: mine.length,
      claimNumbers: mine.slice(0, 3).map((c) => c.claimNumber),
      payoutsToRelease,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/claims — member starts a claim (draft). Multi-step: create → upload docs → submit.
router.post('/', async (req, res, next) => {
  try {
    const { claimTypeId, amountRequested, description, eventDate, beneficiaryName } = req.body;
    if (!claimTypeId) return res.status(400).json({ error: 'Claim type is required' });

    const type = await ClaimType.findOne(orgFilter(req, { _id: claimTypeId, status: 'active' }));
    if (!type) return res.status(404).json({ error: 'Claim type not found' });

    // Fixed-amount benefits: the admin-set amount is the amount — whatever
    // the client sends is ignored, so it can never be more or less.
    let amount;
    if (type.amountMode !== 'capped') {
      amount = type.benefitLimit;
    } else {
      if (!amountRequested) return res.status(400).json({ error: 'Amount is required' });
      amount = Number(amountRequested);
      if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be greater than zero' });
      if (type.limitPer === 'claim' && amount > type.benefitLimit) {
        return res.status(400).json({ error: `Amount exceeds the ${type.name} limit of GH₵ ${type.benefitLimit.toFixed(2)} per claim` });
      }
    }

    // Per-year claim count rule
    const memberId = CAN_FILE_FOR_OTHERS.includes(req.user.role) && req.body.memberId ? req.body.memberId : req.user._id;
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const countThisYear = await Claim.countDocuments(orgFilter(req, {
      memberId,
      claimTypeId: type._id,
      status: { $nin: ['draft', 'rejected'] },
      createdAt: { $gte: yearStart },
    }));
    if (type.maxClaimsPerYear && countThisYear >= type.maxClaimsPerYear) {
      return res.status(400).json({ error: `Limit reached: ${type.maxClaimsPerYear} ${type.name} claim(s) per year` });
    }

    // Organization-wide yearly cap across all claim types
    const org = await Organization.findById(req.orgId).select('claimSettings');
    const globalMax = org?.claimSettings?.maxClaimsPerYear;
    if (globalMax) {
      const allThisYear = await Claim.countDocuments(orgFilter(req, {
        memberId,
        status: { $nin: ['draft', 'rejected'] },
        createdAt: { $gte: yearStart },
      }));
      if (allThisYear >= globalMax) {
        return res.status(400).json({ error: `Limit reached: members may submit at most ${globalMax} claim(s) per year` });
      }
    }

    const claim = new Claim({
      organizationId: req.orgId,
      claimNumber: await Claim.nextClaimNumber(req.orgId),
      memberId,
      claimTypeId: type._id,
      amountRequested: amount,
      description,
      eventDate: eventDate ? new Date(eventDate) : undefined,
      beneficiaryName,
      status: 'draft',
      approvals: chainSteps(type.approvalChain).map((step) => ({ step })),
    });
    pushTimeline(claim, req.user._id, 'Claim created');
    await claim.save();
    res.status(201).json({ claim, requiredDocuments: type.requiredDocuments });
  } catch (err) {
    next(err);
  }
});

// Loads a claim the requester is allowed to touch.
async function loadClaim(req, res, next) {
  try {
    const filter = orgFilter(req, { _id: req.params.id });
    if (!STAFF.includes(req.user.role)) filter.memberId = req.user._id;
    const claim = await Claim.findOne(filter);
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    req.claim = claim;
    next();
  } catch (err) {
    next(err);
  }
}

// POST /api/claims/:id/dismiss-banner — member acknowledges the
// approved/paid outcome banner on their dashboard. Persisted on the claim
// (not localStorage) so it stays dismissed across devices/browsers; a later
// status change (e.g. approved -> paid) clears the slate for a fresh notice.
router.post('/:id/dismiss-banner', loadClaim, async (req, res, next) => {
  try {
    if (STAFF.includes(req.user.role)) return res.status(403).json({ error: 'Not applicable to staff' });
    req.claim.memberBannerDismissedStatus = req.claim.status;
    await req.claim.save();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/claims/:id
router.get('/:id', loadClaim, async (req, res, next) => {
  try {
    await req.claim.populate([
      { path: 'memberId', select: 'firstName lastName email memberNumber' },
      { path: 'claimTypeId', select: 'name benefitLimit limitPer approvalChain requiredDocuments' },
      { path: 'approvals.actedBy', select: 'firstName lastName role' },
      { path: 'timeline.actor', select: 'firstName lastName role' },
    ]);
    res.json({ claim: req.claim });
  } catch (err) {
    next(err);
  }
});

// POST /api/claims/:id/documents — upload supporting documents (draft or submitted)
router.post('/:id/documents', loadClaim, claimDocs.array('documents', 10), async (req, res, next) => {
  try {
    const claim = req.claim;
    if (!['draft', 'submitted', 'under_review'].includes(claim.status)) {
      return res.status(400).json({ error: 'Documents can no longer be added to this claim' });
    }
    const labels = [].concat(req.body.labels || []);
    const files = req.files || [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const stored = await storage.save(req.orgId, 'claims', f.buffer, { originalName: f.originalname, contentType: f.mimetype });
      claim.documents.push({
        label: labels[i] || f.originalname,
        originalName: f.originalname,
        path: stored,
        mimeType: f.mimetype,
        size: f.size,
      });
    }
    pushTimeline(claim, req.user._id, `Uploaded ${files.length} document(s)`);
    await claim.save();
    res.json({ claim });
  } catch (err) {
    next(err);
  }
});

// GET /api/claims/:id/documents/:docId/download
router.get('/:id/documents/:docId/download', loadClaim, async (req, res, next) => {
  try {
    const doc = req.claim.documents.id(req.params.docId);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    await storage.serveDownload(doc.path, doc.originalName || 'document', res);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/claims/:id/documents/:docId — remove a document before the
// claim is submitted (draft only, so nothing vanishes from a reviewer's
// view of an already-submitted application).
router.delete('/:id/documents/:docId', loadClaim, async (req, res, next) => {
  try {
    const claim = req.claim;
    if (claim.status !== 'draft') {
      return res.status(400).json({ error: 'Documents can only be removed while the claim is still a draft' });
    }
    const doc = claim.documents.id(req.params.docId);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const docPath = doc.path;
    doc.deleteOne();
    pushTimeline(claim, req.user._id, 'Document removed', doc.originalName);
    await claim.save();
    storage.remove(docPath);
    res.json({ claim });
  } catch (err) {
    next(err);
  }
});

// POST /api/claims/:id/submit — member finalizes the application
router.post('/:id/submit', loadClaim, async (req, res, next) => {
  try {
    const claim = req.claim;
    if (claim.status !== 'draft') return res.status(400).json({ error: 'Only draft claims can be submitted' });
    const type = await ClaimType.findById(claim.claimTypeId);
    if (type.requiredDocuments.length && claim.documents.length < type.requiredDocuments.length) {
      return res.status(400).json({
        error: `Please upload all required documents (${claim.documents.length}/${type.requiredDocuments.length}): ${type.requiredDocuments.join(', ')}`,
      });
    }
    claim.status = 'submitted';
    claim.submittedAt = new Date();
    pushTimeline(claim, req.user._id, 'Claim submitted for review');
    await claim.save();
    notifyMember(claim);
    audit(req, 'claim.submit', { entityType: 'Claim', entityId: claim._id });
    res.json({ claim });
  } catch (err) {
    next(err);
  }
});

// GET /api/claims/:id/member-context — data for the reviewer's member card
router.get('/:id/member-context', requireRoles('admin', 'supervisor', 'accountant'), loadClaim, async (req, res, next) => {
  try {
    const mongoose = require('mongoose');
    const Contribution = require('../models/Contribution');
    const claim = req.claim;
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

    const [member, totalAgg, recentCount, claimsThisYear, org] = await Promise.all([
      User.findById(claim.memberId),
      Contribution.aggregate([
        { $match: { organizationId: new mongoose.Types.ObjectId(req.orgId), memberId: claim.memberId, status: { $ne: 'reversed' } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Contribution.countDocuments({ organizationId: req.orgId, memberId: claim.memberId, status: { $ne: 'reversed' }, contributionDate: { $gte: twoMonthsAgo } }),
      Claim.countDocuments(orgFilter(req, {
        memberId: claim.memberId,
        status: { $nin: ['draft', 'rejected'] },
        createdAt: { $gte: yearStart },
      })),
      Organization.findById(req.orgId).select('claimSettings'),
    ]);
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const membershipMonths = Math.floor((Date.now() - member.createdAt.getTime()) / (30.44 * 24 * 60 * 60 * 1000));
    res.json({
      member: {
        id: member._id,
        name: `${member.firstName} ${member.lastName}`,
        initials: `${member.firstName[0] || ''}${member.lastName[0] || ''}`.toUpperCase(),
        memberNumber: member.memberNumber,
        department: member.department,
        status: member.status,
        memberSince: member.createdAt,
      },
      totalContributed: totalAgg[0]?.total || 0,
      standing: recentCount > 0 ? 'good' : 'arrears',
      claimsThisYear,
      maxClaimsPerYear: org?.claimSettings?.maxClaimsPerYear || null,
      minMembershipMonths: org?.claimSettings?.minMembershipMonths || 0,
      membershipMonths,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/claims/:id/request-info — reviewer asks the member for more information
router.post('/:id/request-info', requireRoles('admin', 'supervisor', 'accountant'), loadClaim, async (req, res, next) => {
  try {
    const claim = req.claim;
    if (!['submitted', 'under_review'].includes(claim.status)) {
      return res.status(400).json({ error: 'Information can only be requested while a claim is in review' });
    }
    const message = String(req.body.message || '').trim();
    if (!message) return res.status(400).json({ error: 'A message to the member is required' });

    if (claim.status === 'submitted') claim.status = 'under_review';
    pushTimeline(claim, req.user._id, 'More information requested', message);
    await claim.save();

    try {
      const [member, org] = await Promise.all([
        User.findById(claim.memberId),
        Organization.findById(claim.organizationId),
      ]);
      if (member && member.preferences?.claimUpdates !== false) {
        await sendClaimInfoRequestEmail(member, claim, message, org);
      }
    } catch (err) {
      console.error('[claims] request-info email failed:', err.message);
    }

    audit(req, 'claim.request_info', { entityType: 'Claim', entityId: claim._id, detail: { message } });
    res.json({ claim });
  } catch (err) {
    next(err);
  }
});

// POST /api/claims/:id/review — staff moves submitted → under_review
router.post('/:id/review', requireRoles('admin', 'supervisor', 'accountant'), loadClaim, async (req, res, next) => {
  try {
    const claim = req.claim;
    if (claim.status !== 'submitted') return res.status(400).json({ error: 'Only submitted claims can be moved to review' });
    claim.status = 'under_review';
    pushTimeline(claim, req.user._id, 'Review started');
    await claim.save();
    notifyMember(claim);
    audit(req, 'claim.review', { entityType: 'Claim', entityId: claim._id });
    res.json({ claim });
  } catch (err) {
    next(err);
  }
});

// POST /api/claims/:id/decide — approve or reject the current step
router.post('/:id/decide', requireRoles('admin', 'supervisor', 'accountant'), loadClaim, async (req, res, next) => {
  try {
    const { decision, comment, amountApproved } = req.body;
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Decision must be approved or rejected' });

    const claim = req.claim;
    if (!['submitted', 'under_review'].includes(claim.status)) {
      return res.status(400).json({ error: 'This claim is not awaiting a decision' });
    }

    const current = claim.approvals.find((a) => a.decision === 'pending');
    if (!current) return res.status(400).json({ error: 'No pending approval step' });

    // The step's owning role decides it; admin/superadmin always can; a
    // supervisor or accountant explicitly granted 'approve_claims' may also
    // decide steps outside their own role (e.g. stand in for the admin step).
    const requiredRole = STEP_ROLE[current.step];
    const isOwner = req.user.role === requiredRole;
    const isAdminOverride = ['admin', 'superadmin'].includes(req.user.role);
    const isGrantedOverride = hasPermission(req.user, 'approve_claims');
    if (!isOwner && !isAdminOverride && !isGrantedOverride) {
      const article = requiredRole === 'admin' || requiredRole === 'accountant' ? 'an' : 'a';
      const label = requiredRole === 'admin' ? 'administrator' : requiredRole;
      return res.status(403).json({ error: `This step requires ${article} ${label}` });
    }

    current.decision = decision;
    current.actedBy = req.user._id;
    current.actedAt = new Date();
    current.comment = comment;

    if (decision === 'rejected') {
      claim.status = 'rejected';
      claim.decidedAt = new Date();
      claim.rejectionReason = comment || 'Not approved';
      pushTimeline(claim, req.user._id, `Rejected at ${current.step} step`, comment);
    } else {
      pushTimeline(claim, req.user._id, `Approved at ${current.step} step`, comment);
      const remaining = claim.approvals.some((a) => a.decision === 'pending');
      if (remaining) {
        claim.status = 'under_review';
      } else {
        claim.status = 'approved';
        claim.decidedAt = new Date();
        // Fixed-amount benefits are approved at exactly the admin-set
        // amount; only capped types honour an adjusted amountApproved.
        const type = await ClaimType.findById(claim.claimTypeId).select('amountMode');
        const isCapped = type && type.amountMode === 'capped';
        claim.amountApproved =
          isCapped && amountApproved !== undefined ? Number(amountApproved) : claim.amountRequested;
        pushTimeline(claim, req.user._id, `Claim approved for GH₵ ${claim.amountApproved.toFixed(2)}`);
      }
    }

    await claim.save();
    notifyMember(claim);
    audit(req, `claim.${decision}`, { entityType: 'Claim', entityId: claim._id, detail: { step: current.step, comment } });
    res.json({ claim });
  } catch (err) {
    next(err);
  }
});

// POST /api/claims/:id/mark-documents-reviewed — accountant/admin verifies
// supporting documents before a payout can be prepared.
router.post('/:id/mark-documents-reviewed', requireRoles('admin', 'accountant'), loadClaim, async (req, res, next) => {
  try {
    const claim = req.claim;
    if (claim.status !== 'approved') return res.status(400).json({ error: 'Only approved claims are ready for payout review' });
    claim.disbursement.documentsReviewed = true;
    claim.disbursement.documentsReviewedBy = req.user._id;
    claim.disbursement.documentsReviewedAt = new Date();
    pushTimeline(claim, req.user._id, 'Payout documents reviewed');
    await claim.save();
    audit(req, 'claim.documents_reviewed', { entityType: 'Claim', entityId: claim._id });
    res.json({ claim });
  } catch (err) {
    next(err);
  }
});

// POST /api/claims/:id/prepare-payout — accountant queues the payout for the
// administrator's release. Does not move money or touch claim.status.
router.post('/:id/prepare-payout', requireRoles('admin', 'accountant'), loadClaim, async (req, res, next) => {
  try {
    const claim = req.claim;
    if (claim.status !== 'approved') return res.status(400).json({ error: 'Only approved claims can be prepared for payout' });
    if (!claim.disbursement.documentsReviewed) return res.status(400).json({ error: 'Review the supporting documents before preparing the payout' });
    if (claim.disbursement.status === 'released') return res.status(400).json({ error: 'This claim has already been paid' });

    const { account = 'bank', fundAccountId, paymentReference } = req.body;
    if (!['cash', 'bank', 'mobile_money'].includes(account)) return res.status(400).json({ error: 'Invalid payout account' });
    const fundAccount = fundAccountId
      ? { _id: fundAccountId }
      : await getDefaultFundAccount(claim.organizationId, 'Welfare Fund');

    claim.disbursement.status = 'prepared';
    claim.disbursement.payoutAccount = account;
    claim.disbursement.fundAccountId = fundAccount._id;
    claim.disbursement.paymentReference = paymentReference;
    claim.disbursement.preparedBy = req.user._id;
    claim.disbursement.preparedAt = new Date();
    pushTimeline(claim, req.user._id, 'Payout prepared, awaiting administrator release');
    await claim.save();
    audit(req, 'claim.prepare_payout', { entityType: 'Claim', entityId: claim._id, detail: { account } });
    res.json({ claim });
  } catch (err) {
    next(err);
  }
});

// POST /api/claims/:id/recall-payout — accountant withdraws a prepared
// (not yet released) payout back to "approved" so it can be revised.
router.post('/:id/recall-payout', requireRoles('admin', 'accountant'), loadClaim, async (req, res, next) => {
  try {
    const claim = req.claim;
    if (claim.disbursement.status !== 'prepared') return res.status(400).json({ error: 'Only a prepared payout can be recalled' });
    claim.disbursement.status = 'none';
    pushTimeline(claim, req.user._id, 'Payout recalled');
    await claim.save();
    audit(req, 'claim.recall_payout', { entityType: 'Claim', entityId: claim._id });
    res.json({ claim });
  } catch (err) {
    next(err);
  }
});

// POST /api/claims/:id/pay — administrator releases the payout; posts to ledger
router.post('/:id/pay', requireRoles('admin'), loadClaim, async (req, res, next) => {
  try {
    const claim = req.claim;
    if (claim.status !== 'approved') return res.status(400).json({ error: 'Only approved claims can be paid' });
    if (claim.disbursement.status === 'released') return res.status(400).json({ error: 'This claim has already been paid' });
    const { paymentReference = claim.disbursement.paymentReference, account = claim.disbursement.payoutAccount || 'bank', fundAccountId = claim.disbursement.fundAccountId } = req.body;
    if (!['cash', 'bank', 'mobile_money'].includes(account)) return res.status(400).json({ error: 'Invalid payout account' });

    const fundAccount = fundAccountId
      ? { _id: fundAccountId }
      : await getDefaultFundAccount(claim.organizationId, 'Welfare Fund');

    claim.status = 'paid';
    claim.paidAt = new Date();
    claim.paymentReference = paymentReference;
    claim.disbursement.status = 'released';
    claim.disbursement.releasedBy = req.user._id;
    claim.disbursement.releasedAt = new Date();
    claim.disbursement.payoutAccount = account;
    claim.disbursement.fundAccountId = fundAccount._id;
    claim.disbursement.paymentReference = paymentReference;
    pushTimeline(claim, req.user._id, 'Benefit paid', paymentReference);
    await claim.save();

    // Only the payout leg (the asset account funds actually left) is tagged
    // with a fundAccountId — see the matching note in contributions.js.
    const amount = claim.amountApproved ?? claim.amountRequested;
    await LedgerEntry.insertMany([
      {
        organizationId: claim.organizationId,
        account: 'claims_payable',
        category: 'claims_payout',
        direction: 'debit',
        amount,
        description: `Claim payout ${claim.claimNumber}`,
        sourceType: 'claim',
        sourceId: claim._id,
        memberId: claim.memberId,
        createdBy: req.user._id,
      },
      {
        organizationId: claim.organizationId,
        account,
        fundAccountId: fundAccount._id,
        category: 'claims_payout',
        direction: 'credit',
        amount,
        description: `Claim payout ${claim.claimNumber}`,
        sourceType: 'claim',
        sourceId: claim._id,
        memberId: claim.memberId,
        createdBy: req.user._id,
      },
    ]);

    // Mirror the payout into the Accounts & Expenditure register (already
    // posted to the ledger above, so the entry is created directly as paid).
    const AccountEntry = require('../models/AccountEntry');
    const type = await ClaimType.findById(claim.claimTypeId).select('name');
    await AccountEntry.create({
      organizationId: claim.organizationId,
      ref: await AccountEntry.nextRef(claim.organizationId),
      title: `Claim payout — ${type ? type.name.toLowerCase() : 'benefit'}`,
      category: 'claims_payout',
      department: 'Welfare Fund',
      amount,
      entryDate: claim.paidAt,
      status: 'paid',
      payoutAccount: account,
      paymentReference,
      preparedBy: req.user._id,
      paidBy: req.user._id,
      paidAt: claim.paidAt,
      sourceClaimId: claim._id,
    });

    notifyMember(claim);
    audit(req, 'claim.pay', { entityType: 'Claim', entityId: claim._id, detail: { amount, account } });
    res.json({ claim });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/claims/:id — members may discard their own drafts
router.delete('/:id', loadClaim, async (req, res, next) => {
  try {
    if (req.claim.status !== 'draft') return res.status(400).json({ error: 'Only draft claims can be deleted' });
    await req.claim.deleteOne();
    res.json({ message: 'Draft deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
// Exported for unit tests — chain construction and step ownership.
module.exports.chainSteps = chainSteps;
module.exports.STEP_ROLE = STEP_ROLE;
