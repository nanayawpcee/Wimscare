const express = require('express');
const ClaimType = require('../models/ClaimType');
const Claim = require('../models/Claim');
const { protect, requireRoles, requireOrg, orgFilter } = require('../middleware/auth');
const { audit } = require('../utils/audit');

const router = express.Router();

router.use(protect, requireOrg);

function slugify(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'claim_type';
}

// GET /api/claim-types — members see active only; staff see everything
router.get('/', async (req, res, next) => {
  try {
    const filter = orgFilter(req);
    const isStaff = ['admin', 'supervisor', 'accountant', 'superadmin'].includes(req.user.role);
    if (!isStaff) filter.status = 'active';
    else if (req.query.status) filter.status = req.query.status;
    const items = await ClaimType.find(filter).sort({ name: 1 });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// POST /api/claim-types — admin creates a claim type (mirrors the Add Claim Type screen)
router.post('/', requireRoles('admin'), async (req, res, next) => {
  try {
    const {
      name, description, benefitLimit, amountMode, limitPer, waitingPeriodMonths,
      maxClaimsPerYear, approvalChain, requiredDocuments, status,
    } = req.body;
    if (!name || benefitLimit === undefined) return res.status(400).json({ error: 'Name and benefit limit are required' });

    const claimType = await ClaimType.create({
      organizationId: req.orgId,
      name: String(name).trim(),
      slug: slugify(name),
      description,
      benefitLimit: Number(benefitLimit),
      amountMode: amountMode === 'capped' ? 'capped' : 'fixed',
      limitPer,
      waitingPeriodMonths: Number(waitingPeriodMonths) || 0,
      maxClaimsPerYear: Number(maxClaimsPerYear) || 1,
      approvalChain,
      requiredDocuments: [].concat(requiredDocuments || []).filter(Boolean),
      status: status === 'draft' ? 'draft' : 'active',
      createdBy: req.user._id,
    });
    audit(req, 'claim_type.create', { entityType: 'ClaimType', entityId: claimType._id, detail: { name } });
    res.status(201).json({ claimType });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/claim-types/:id
router.patch('/:id', requireRoles('admin'), async (req, res, next) => {
  try {
    const claimType = await ClaimType.findOne(orgFilter(req, { _id: req.params.id }));
    if (!claimType) return res.status(404).json({ error: 'Claim type not found' });

    const editable = ['name', 'description', 'benefitLimit', 'amountMode', 'limitPer', 'waitingPeriodMonths', 'maxClaimsPerYear', 'approvalChain', 'status'];
    for (const key of editable) if (req.body[key] !== undefined) claimType[key] = req.body[key];
    if (req.body.name) claimType.slug = slugify(req.body.name);
    if (req.body.requiredDocuments !== undefined) {
      claimType.requiredDocuments = [].concat(req.body.requiredDocuments || []).filter(Boolean);
    }
    await claimType.save();
    audit(req, 'claim_type.update', { entityType: 'ClaimType', entityId: claimType._id });
    res.json({ claimType });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/claim-types/:id — archive (never hard-delete; claims reference it)
router.delete('/:id', requireRoles('admin'), async (req, res, next) => {
  try {
    const claimType = await ClaimType.findOne(orgFilter(req, { _id: req.params.id }));
    if (!claimType) return res.status(404).json({ error: 'Claim type not found' });
    const inFlight = await Claim.countDocuments(orgFilter(req, {
      claimTypeId: claimType._id,
      status: { $in: ['submitted', 'under_review', 'approved'] },
    }));
    if (inFlight) return res.status(400).json({ error: `Cannot archive: ${inFlight} claim(s) of this type are still in progress` });
    claimType.status = 'archived';
    await claimType.save();
    audit(req, 'claim_type.archive', { entityType: 'ClaimType', entityId: claimType._id });
    res.json({ claimType });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
