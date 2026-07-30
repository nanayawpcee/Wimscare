const fs = require('fs');
const express = require('express');
const Organization = require('../models/Organization');
const License = require('../models/License');
const { protect, requireRoles, requireOrg, requireFeature } = require('../middleware/auth');
const { logoUpload, processLogo, resolveUploadPath } = require('../middleware/upload');
const { audit } = require('../utils/audit');

const router = express.Router();

router.use(protect, requireOrg);

const PROFILE_FIELDS = 'name code contactEmail contactPhone address currency settings claimSettings facility systemSettings status deletionRequestedAt deletionRequestReason deletionRequestedBy';

// GET /api/organization — current organization incl. claim settings + facility
router.get('/', async (req, res, next) => {
  try {
    const organization = await Organization.findById(req.orgId).select(PROFILE_FIELDS);
    if (!organization) return res.status(404).json({ error: 'Organization not found' });
    res.json({ organization });
  } catch (err) {
    next(err);
  }
});

// GET /api/organization/license — the license currently in force (valid,
// active/pending, latest expiry). A revoked or cancelled license must never
// shadow the live one, whatever its expiry date; only when nothing is in
// force do we fall back to the most recently issued license so the page can
// still show what expired.
router.get('/license', async (req, res, next) => {
  try {
    const { currentLicense, planLabel } = require('../utils/plans');
    let license = await currentLicense(req.orgId);
    if (!license) license = await License.findOne({ organizationId: req.orgId, status: { $nin: ['revoked'] } }).sort({ createdAt: -1 });
    res.json({ license, planLabel: license ? planLabel(license.plan) : null });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/organization/facility — identity, legal, address, contact,
// branding and social fields (admin only — see Facility Profile page).
router.patch('/facility', requireRoles('admin'), async (req, res, next) => {
  try {
    const { name, contactEmail, contactPhone, address, facility = {} } = req.body;
    const $set = {};
    if (name !== undefined) $set.name = name;
    if (contactEmail !== undefined) $set.contactEmail = contactEmail;
    if (contactPhone !== undefined) $set.contactPhone = contactPhone;
    if (address !== undefined) $set.address = address;
    // supportEmail is deliberately excluded — it's the organization's
    // professional notification address, assigned by the superadmin when
    // the license is issued (kept separate from any admin's personal login
    // email) and changeable only from the developer portal.
    const allowedFacilityKeys = [
      'shortName', 'tagline', 'website', 'overview', 'legalName', 'registrationNumber', 'taxId',
      'vatStatus', 'complianceNotes', 'addressLine1', 'addressLine2', 'city', 'region', 'postalCode',
      'country', 'supportHotline', 'whatsapp', 'primaryColor', 'accentColor',
      'backgroundColor', 'facebook', 'twitter', 'instagram', 'linkedin',
    ];
    for (const key of allowedFacilityKeys) {
      if (facility[key] !== undefined) $set[`facility.${key}`] = facility[key];
    }

    // Interface customization (brand colours) is a Pro plan feature.
    const changesBranding = ['primaryColor', 'accentColor', 'backgroundColor'].some(
      (key) => facility[key] !== undefined && facility[key] !== ''
    );
    if (changesBranding && req.user.role !== 'superadmin') {
      const { currentLicense, effectiveFeatures } = require('../utils/plans');
      if (!effectiveFeatures(await currentLicense(req.orgId)).customBranding) {
        return res.status(403).json({
          error: 'Interface customization is a Pro plan feature — ask your provider about upgrading',
          upgradeRequired: true,
          feature: 'customBranding',
        });
      }
    }

    const organization = await Organization.findByIdAndUpdate(req.orgId, { $set }, { new: true, runValidators: true }).select(PROFILE_FIELDS);
    audit(req, 'organization.facility_update', { entityType: 'Organization', entityId: organization._id });
    res.json({ organization });
  } catch (err) {
    next(err);
  }
});

// --- Organization logo (Pro branding) ---

// GET /api/organization/logo — serves the uploaded logo to signed-in users
// of the org (img tags send the auth cookie on same-origin requests).
router.get('/logo', async (req, res, next) => {
  try {
    const org = await Organization.findById(req.orgId).select('facility.logoPath');
    if (!org || !org.facility || !org.facility.logoPath) return res.status(404).json({ error: 'No logo uploaded' });
    res.sendFile(resolveUploadPath(org.facility.logoPath));
  } catch (err) {
    next(err);
  }
});

// POST /api/organization/logo — upload/replace (admin, Pro plan).
router.post(
  '/logo',
  requireRoles('admin'),
  requireFeature('customBranding'),
  logoUpload.single('logo'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Attach an image file as "logo"' });
      const relPath = await processLogo(req);
      const org = await Organization.findById(req.orgId).select('facility');
      const old = org.facility && org.facility.logoPath;
      org.set('facility.logoPath', relPath);
      await org.save();
      if (old) fs.unlink(resolveUploadPath(old), () => {});
      audit(req, 'organization.logo_update', { entityType: 'Organization', entityId: org._id });
      res.json({ logoPath: relPath });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/organization/logo — back to the stock WIMScare mark.
router.delete('/logo', requireRoles('admin'), requireFeature('customBranding'), async (req, res, next) => {
  try {
    const org = await Organization.findById(req.orgId).select('facility');
    const old = org.facility && org.facility.logoPath;
    org.set('facility.logoPath', undefined);
    await org.save();
    if (old) fs.unlink(resolveUploadPath(old), () => {});
    audit(req, 'organization.logo_remove', { entityType: 'Organization', entityId: org._id });
    res.json({ message: 'Logo removed' });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/organization/system-settings — console-wide behaviour (admin only)
router.patch('/system-settings', requireRoles('admin'), async (req, res, next) => {
  try {
    const $set = {};
    if (req.body.sessionTimeoutMinutes !== undefined) {
      const n = Number(req.body.sessionTimeoutMinutes);
      if (!(n >= 5 && n <= 480)) return res.status(400).json({ error: 'Session timeout must be between 5 and 480 minutes' });
      $set['systemSettings.sessionTimeoutMinutes'] = n;
    }
    for (const key of ['auditLogEnabled', 'maintenanceMode', 'emailAlerts', 'strictEligibility']) {
      if (typeof req.body[key] === 'boolean') $set[`systemSettings.${key}`] = req.body[key];
    }
    const organization = await Organization.findByIdAndUpdate(req.orgId, { $set }, { new: true, runValidators: true }).select(PROFILE_FIELDS);
    // Maintenance toggle takes effect immediately, not after the cache TTL.
    require('../middleware/auth').clearMaintenanceCache(req.orgId);
    audit(req, 'organization.system_settings', { entityType: 'Organization', entityId: organization._id, detail: $set });
    res.json({ organization });
  } catch (err) {
    next(err);
  }
});

// POST /api/organization/request-license-renewal — notifies the developer
// portal via the audit trail; plan changes are self-serve REQUESTS only —
// the superadmin applies them from the developer portal (see
// request-plan-upgrade below and POST /api/developer/licenses/:id/change-plan).
router.post('/request-license-renewal', requireRoles('admin'), async (req, res, next) => {
  try {
    const license = await License.findOne({ organizationId: req.orgId }).sort({ expiresAt: -1 });
    if (!license) return res.status(404).json({ error: 'No license on file to renew' });
    // Flag the license so the superadmin console shows a pending renewal
    // request; cleared automatically when the superadmin renews it.
    license.renewalRequestedAt = new Date();
    license.renewalRequestNote = (req.body.note || '').trim() || undefined;
    license.renewalRequestedBy = req.user._id;
    await license.save();
    audit(req, 'organization.license_renewal_request', {
      entityType: 'License',
      entityId: license._id,
      detail: { note: req.body.note, currentPlan: license.plan, expiresAt: license.expiresAt },
    });
    res.json({ message: 'Renewal request sent — the WIMScare team will follow up on this license.' });
  } catch (err) {
    next(err);
  }
});

// POST /api/organization/request-plan-upgrade — admin asks the superadmin
// to move the organization to a different plan; the superadmin applies it
// from the developer portal, same "requested -> fulfilled" pattern as
// renewals above.
router.post('/request-plan-upgrade', requireRoles('admin'), async (req, res, next) => {
  try {
    const { PLANS, planLabel } = require('../utils/plans');
    const plan = String(req.body.plan || '').toLowerCase();
    if (!PLANS[plan]) return res.status(400).json({ error: 'Choose a valid plan (Free, Standard or Pro)' });
    const license = await License.findOne({ organizationId: req.orgId }).sort({ expiresAt: -1 });
    if (!license) return res.status(404).json({ error: 'No license on file' });
    if (plan === license.plan) return res.status(400).json({ error: `Already on the ${planLabel(plan)} plan` });
    license.requestedPlan = plan;
    license.planRequestedAt = new Date();
    license.planRequestNote = (req.body.note || '').trim() || undefined;
    license.planRequestedBy = req.user._id;
    await license.save();
    audit(req, 'organization.plan_upgrade_request', {
      entityType: 'License',
      entityId: license._id,
      detail: { note: req.body.note, currentPlan: license.plan, requestedPlan: plan },
    });
    res.json({ message: `${planLabel(plan)} plan request sent — the WIMScare team will follow up.` });
  } catch (err) {
    next(err);
  }
});

// POST /api/organization/request-deletion — admin asks the superadmin to
// delete (archive) the whole organization. Same request/fulfil shape as
// license renewals above; the superadmin applies it from the developer
// portal (POST /api/developer/organizations/:id/approve-deletion).
router.post('/request-deletion', requireRoles('admin'), async (req, res, next) => {
  try {
    const organization = await Organization.findById(req.orgId);
    if (organization.deletionRequestedAt) {
      return res.status(400).json({ error: 'A deletion request is already pending for this organization' });
    }
    organization.deletionRequestedAt = new Date();
    organization.deletionRequestReason = (req.body.reason || '').trim() || undefined;
    organization.deletionRequestedBy = req.user._id;
    await organization.save();
    audit(req, 'organization.request_deletion', {
      entityType: 'Organization',
      entityId: organization._id,
      detail: { reason: req.body.reason },
    });
    res.json({ message: 'Deletion request sent — the WIMScare team will follow up.' });
  } catch (err) {
    next(err);
  }
});

// POST /api/organization/cancel-deletion-request — withdraw a pending request.
router.post('/cancel-deletion-request', requireRoles('admin'), async (req, res, next) => {
  try {
    const organization = await Organization.findByIdAndUpdate(
      req.orgId,
      { $unset: { deletionRequestedAt: '', deletionRequestReason: '', deletionRequestedBy: '' } },
      { new: true }
    );
    audit(req, 'organization.cancel_deletion_request', { entityType: 'Organization', entityId: organization._id });
    res.json({ message: 'Deletion request withdrawn' });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/organization/claim-settings — global eligibility rules (admin)
router.patch('/claim-settings', requireRoles('admin'), async (req, res, next) => {
  try {
    const $set = {};
    const { minMembershipMonths, standingRule, maxClaimsPerYear, autoAck, allowDrafts, notifyChain } = req.body;
    if (minMembershipMonths !== undefined) {
      const n = Number(minMembershipMonths);
      if (!(n >= 0 && n <= 60)) return res.status(400).json({ error: 'Invalid minimum membership period' });
      $set['claimSettings.minMembershipMonths'] = n;
    }
    if (standingRule !== undefined) {
      if (!['no_arrears_2m', 'fully_paid', 'none'].includes(standingRule)) {
        return res.status(400).json({ error: 'Invalid contribution standing rule' });
      }
      $set['claimSettings.standingRule'] = standingRule;
    }
    if (maxClaimsPerYear !== undefined) {
      const n = Number(maxClaimsPerYear);
      if (!(n >= 1 && n <= 50)) return res.status(400).json({ error: 'Max claims per year must be between 1 and 50' });
      $set['claimSettings.maxClaimsPerYear'] = n;
    }
    for (const key of ['autoAck', 'allowDrafts', 'notifyChain']) {
      if (typeof req.body[key] === 'boolean') $set[`claimSettings.${key}`] = req.body[key];
    }

    const organization = await Organization.findByIdAndUpdate(req.orgId, { $set }, { new: true, runValidators: true }).select(PROFILE_FIELDS);
    audit(req, 'organization.claim_settings', { entityType: 'Organization', entityId: organization._id, detail: $set });
    res.json({ organization });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
