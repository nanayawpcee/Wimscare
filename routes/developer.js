const express = require('express');
const mongoose = require('mongoose');
const Organization = require('../models/Organization');
const User = require('../models/User');
const License = require('../models/License');
const Backup = require('../models/Backup');
const SystemUpdate = require('../models/SystemUpdate');
const AuditLog = require('../models/AuditLog');
const Contribution = require('../models/Contribution');
const Claim = require('../models/Claim');
const { protect, requireSuperadmin } = require('../middleware/auth');
const { createOrgBackup } = require('../utils/backupService');
const { sendActivationEmail } = require('../utils/email');
const { audit } = require('../utils/audit');
const { getCurrent, GRACE_DAYS } = require('../utils/superadminCredentials');
const { schedulerState } = require('../jobs/scheduler');

const router = express.Router();

// Published updates are visible to any signed-in admin console.
router.get('/updates', protect, async (req, res, next) => {
  try {
    const items = await SystemUpdate.find({ status: 'published' }).sort({ publishedAt: -1 }).limit(20);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

router.use(protect, requireSuperadmin);

// GET /api/developer/overview — stats, license status bars, system health
// and the latest superadmin activity, in one call.
router.get('/overview', async (req, res, next) => {
  try {
    const soon = new Date();
    soon.setDate(soon.getDate() + 30);
    const [orgs, users, admins, allLicenses, recent, renewals, planRequests, adminDeletions, orgDeletions] = await Promise.all([
      Organization.countDocuments(),
      User.countDocuments({ role: { $ne: 'superadmin' } }),
      User.countDocuments({ role: 'admin' }),
      License.find().select('plan status expiresAt organizationId').populate('organizationId', 'name').lean(),
      AuditLog.find({ action: /^developer\./ })
        .sort({ createdAt: -1 })
        .limit(6)
        .populate('actorId', 'firstName lastName email')
        .lean(),
      // Admin-initiated renewal requests still awaiting the superadmin.
      License.find({ renewalRequestedAt: { $ne: null } })
        .sort({ renewalRequestedAt: -1 })
        .select('plan status expiresAt organizationId renewalRequestedAt renewalRequestNote')
        .populate('organizationId', 'name')
        .lean(),
      // Admin-initiated plan-upgrade requests still awaiting the superadmin.
      License.find({ planRequestedAt: { $ne: null } })
        .sort({ planRequestedAt: -1 })
        .select('plan requestedPlan status organizationId planRequestedAt planRequestNote')
        .populate('organizationId', 'name')
        .lean(),
      // Admins who requested deletion of their own account.
      User.find({ role: 'admin', deletionRequestedAt: { $ne: null } })
        .sort({ deletionRequestedAt: -1 })
        .select('firstName lastName email organizationId deletionRequestedAt deletionRequestReason')
        .populate('organizationId', 'name')
        .lean(),
      // Admins who requested deletion of their whole organization.
      Organization.find({ deletionRequestedAt: { $ne: null } })
        .sort({ deletionRequestedAt: -1 })
        .select('name deletionRequestedAt deletionRequestReason deletionRequestedBy')
        .populate('deletionRequestedBy', 'firstName lastName email')
        .lean(),
    ]);

    const byStatus = { active: 0, trial: 0, pending: 0, expired: 0, suspended: 0 };
    const expiring = [];
    for (const lic of allLicenses) {
      if (lic.status === 'active' && lic.plan === 'trial') byStatus.trial += 1;
      else if (byStatus[lic.status] !== undefined) byStatus[lic.status] += 1;
      if (lic.status === 'active' && lic.expiresAt && lic.expiresAt <= soon && lic.expiresAt > new Date()) {
        expiring.push({ org: lic.organizationId ? lic.organizationId.name : '—', plan: lic.plan, expiresAt: lic.expiresAt });
      }
    }

    const smtpConfigured = !!process.env.SMTP_HOST;
    const health = [
      { name: 'API server', status: 'operational' },
      { name: 'MongoDB', status: mongoose.connection.readyState === 1 ? 'operational' : 'down' },
      { name: 'Backup scheduler', status: schedulerState.started ? 'operational' : 'down' },
      { name: 'Email service', status: smtpConfigured ? 'operational' : 'degraded', note: smtpConfigured ? undefined : 'SMTP not configured — emails print to the server console' },
    ];

    res.json({
      stats: {
        totalLicenses: allLicenses.length,
        activeLicenses: byStatus.active + byStatus.trial,
        trialLicenses: byStatus.trial,
        organizations: orgs,
        users,
        admins,
        expiringSoon: expiring.length,
      },
      byStatus,
      expiring,
      health,
      recent,
      renewalRequests: renewals.map((l) => ({
        licenseId: l._id,
        org: l.organizationId ? l.organizationId.name : '—',
        plan: l.plan,
        status: l.status,
        expiresAt: l.expiresAt,
        requestedAt: l.renewalRequestedAt,
        note: l.renewalRequestNote,
      })),
      planRequests: planRequests.map((l) => ({
        licenseId: l._id,
        org: l.organizationId ? l.organizationId.name : '—',
        plan: l.plan,
        requestedPlan: l.requestedPlan,
        status: l.status,
        requestedAt: l.planRequestedAt,
        note: l.planRequestNote,
      })),
      deletionRequests: {
        admins: adminDeletions.map((u) => ({
          userId: u._id,
          name: `${u.firstName} ${u.lastName}`.trim(),
          email: u.email,
          org: u.organizationId ? u.organizationId.name : '—',
          requestedAt: u.deletionRequestedAt,
          reason: u.deletionRequestReason,
        })),
        organizations: orgDeletions.map((o) => ({
          organizationId: o._id,
          org: o.name,
          requestedAt: o.deletionRequestedAt,
          reason: o.deletionRequestReason,
          requestedBy: o.deletionRequestedBy ? `${o.deletionRequestedBy.firstName} ${o.deletionRequestedBy.lastName}`.trim() : '—',
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/developer/credentials — this month's rotating password and the
// enforced security policy, for the console's Credentials section.
router.get('/credentials', async (req, res, next) => {
  try {
    const cred = await getCurrent();
    audit(req, 'developer.credentials_view', { detail: { month: cred.month } });
    res.json({
      username: req.user.email,
      month: cred.month,
      password: cred.password,
      validThrough: cred.validThrough,
      graceEnds: cred.graceEnds,
      policies: [
        { label: 'Password rotation', value: 'Monthly' },
        { label: 'Grace period', value: `First ${GRACE_DAYS} days of new month` },
        { label: 'Fallback password', value: 'Seeded credential always valid' },
        { label: 'Session timeout', value: process.env.JWT_EXPIRES_IN || '7 days' },
        { label: 'Audit logging', value: 'All superadmin actions' },
      ],
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/developer/organizations
router.get('/organizations', async (req, res, next) => {
  try {
    const orgs = await Organization.find().sort({ createdAt: -1 }).lean();
    const enriched = await Promise.all(
      orgs.map(async (org) => {
        const [staffCount, memberCount, license, lastBackup] = await Promise.all([
          User.countDocuments({ organizationId: org._id, role: { $ne: 'user' } }),
          User.countDocuments({ organizationId: org._id, role: 'user' }),
          License.findOne({ organizationId: org._id }).sort({ expiresAt: -1 }).lean(),
          Backup.findOne({ organizationId: org._id, status: 'completed' }).sort({ createdAt: -1 }).select('createdAt').lean(),
        ]);
        return { ...org, staffCount, memberCount, license, lastBackupAt: lastBackup ? lastBackup.createdAt : null };
      })
    );
    res.json({ items: enriched });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/developer/organizations/:id — suspend/reactivate/edit
router.patch('/organizations/:id', async (req, res, next) => {
  try {
    const org = await Organization.findById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    for (const key of ['name', 'status', 'contactEmail', 'contactPhone', 'address']) {
      if (req.body[key] !== undefined) org[key] = req.body[key];
    }
    // The organization's professional email — locked to superadmin-only
    // editing (see routes/organization.js PATCH /facility).
    if (req.body.organizationEmail !== undefined) {
      org.set('facility.supportEmail', String(req.body.organizationEmail).trim().toLowerCase());
    }
    await org.save();
    audit(req, 'developer.org_update', { entityType: 'Organization', entityId: org._id, detail: req.body });
    res.json({ organization: org });
  } catch (err) {
    next(err);
  }
});

// POST /api/developer/organizations/:id/approve-deletion — carries out an
// admin's request to delete the organization. Archives it (status stays
// queryable, not erased — every member/claim/contribution/ledger entry it
// owns is kept intact for audit) and locks every session out immediately
// (middleware/auth.js checks org status on every request, not just login).
router.post('/organizations/:id/approve-deletion', async (req, res, next) => {
  try {
    const org = await Organization.findById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    if (!org.deletionRequestedAt) return res.status(400).json({ error: 'This organization has no pending deletion request' });

    org.status = 'archived';
    org.archivedAt = new Date();
    org.archivedBy = req.user._id;
    org.deletionRequestedAt = undefined;
    org.deletionRequestReason = undefined;
    org.deletionRequestedBy = undefined;
    await org.save();
    require('../middleware/auth').clearMaintenanceCache(org._id);
    audit(req, 'developer.org_approve_deletion', { entityType: 'Organization', entityId: org._id, detail: { name: org.name } });
    res.json({ organization: org, message: 'Organization deleted' });
  } catch (err) {
    next(err);
  }
});

// POST /api/developer/organizations/:id/reject-deletion
router.post('/organizations/:id/reject-deletion', async (req, res, next) => {
  try {
    const org = await Organization.findById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    org.deletionRequestedAt = undefined;
    org.deletionRequestReason = undefined;
    org.deletionRequestedBy = undefined;
    await org.save();
    audit(req, 'developer.org_reject_deletion', { entityType: 'Organization', entityId: org._id });
    res.json({ organization: org, message: 'Deletion request declined' });
  } catch (err) {
    next(err);
  }
});

// POST /api/developer/users/:id/approve-deletion — carries out an admin's
// request to delete their own account. Scoped to role:'admin' — deletion
// requests from any other role are approved by their org admin instead
// (see routes/users.js).
router.post('/users/:id/approve-deletion', async (req, res, next) => {
  try {
    const user = await User.findOne({ _id: req.params.id, role: 'admin' });
    if (!user) return res.status(404).json({ error: 'Admin not found' });
    if (!user.deletionRequestedAt) return res.status(400).json({ error: 'This account has no pending deletion request' });

    user.status = 'deleted';
    user.deletedAt = new Date();
    user.deletedBy = req.user._id;
    user.deletionRequestedAt = undefined;
    user.deletionRequestReason = undefined;
    user.deletionRequestedBy = undefined;
    await user.save();
    audit(req, 'developer.user_approve_deletion', { entityType: 'User', entityId: user._id, detail: { email: user.email } });
    res.json({ user, message: 'Account deleted' });
  } catch (err) {
    next(err);
  }
});

// POST /api/developer/users/:id/reject-deletion
router.post('/users/:id/reject-deletion', async (req, res, next) => {
  try {
    const user = await User.findOne({ _id: req.params.id, role: 'admin' });
    if (!user) return res.status(404).json({ error: 'Admin not found' });
    user.deletionRequestedAt = undefined;
    user.deletionRequestReason = undefined;
    user.deletionRequestedBy = undefined;
    await user.save();
    audit(req, 'developer.user_reject_deletion', { entityType: 'User', entityId: user._id });
    res.json({ user, message: 'Deletion request declined' });
  } catch (err) {
    next(err);
  }
});

// POST /api/developer/organizations — provision a new tenant with its first admin
router.post('/organizations', async (req, res, next) => {
  try {
    const { name, adminFirstName, adminLastName, adminEmail } = req.body;
    if (!name || !adminEmail || !adminFirstName) return res.status(400).json({ error: 'Organization name and admin details are required' });

    const code = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 24) + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const org = await Organization.create({ name: name.trim(), code, contactEmail: adminEmail });

    const admin = new User({
      organizationId: org._id,
      firstName: adminFirstName,
      lastName: adminLastName || '',
      email: adminEmail,
      role: 'admin',
      status: 'pending',
    });
    const raw = admin.issueToken('activation', 72 * 60 * 60 * 1000);
    await admin.save();
    const { bootstrapOrganizationDefaults } = require('./auth');
    await bootstrapOrganizationDefaults(org._id, admin._id);
    // The org/admin are already committed at this point — a failed send
    // (bad domain, SMTP hiccup) shouldn't roll the whole provisioning
    // request back into a 500 and leave the superadmin unsure whether the
    // organization was actually created.
    try {
      await sendActivationEmail(admin, org, raw);
    } catch (err) {
      console.error('[developer] activation email failed:', err.message);
    }

    audit(req, 'developer.org_create', { entityType: 'Organization', entityId: org._id });
    res.status(201).json({ organization: org, admin });
  } catch (err) {
    next(err);
  }
});

// --- Licenses ---

router.get('/licenses', async (req, res, next) => {
  try {
    const items = await License.find().sort({ createdAt: -1 }).populate('organizationId', 'name code');
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// POST /api/developer/licenses — issue a license. Two modes:
//  - { organizationId }: a fresh license for an existing tenant, active
//    immediately and superseding its current one.
//  - { organizationName, contactName, contactEmail }: provisions the tenant
//    and its first admin (activation email sent); the license stays
//    'pending' until that admin activates.
router.post('/licenses', async (req, res, next) => {
  try {
    const { PLANS } = require('../utils/plans');
    const {
      organizationId, organizationName, organizationEmail, contactName, contactEmail,
      plan = 'free', months, notes, features,
    } = req.body;
    const catalog = PLANS[plan];
    const maxUsers = req.body.maxUsers ?? (catalog ? catalog.maxUsers : 5);
    const maxMembers = req.body.maxMembers ?? (catalog ? catalog.maxMembers : 400);

    // Explicit flags win; otherwise the plan's defaults apply.
    const cleanFeatures = {};
    const defaults = catalog ? catalog.features : [];
    for (const key of License.FEATURE_KEYS) {
      cleanFeatures[key] = features ? !!features[key] : defaults.includes(key);
    }

    const term = Number(months) || (catalog ? catalog.defaultMonths : plan === 'trial' ? 1 : 12);
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + term);

    let org;
    let status = 'active';
    let activatedAt = new Date();
    if (organizationId) {
      org = await Organization.findById(organizationId);
      if (!org) return res.status(404).json({ error: 'Organization not found' });
      // A new license supersedes the current active one.
      await License.updateMany({ organizationId, status: { $in: ['active', 'pending'] } }, { $set: { status: 'revoked' } });
    } else {
      if (!organizationName || !organizationEmail || !contactName || !contactEmail) {
        return res.status(400).json({ error: 'Organization name, organization email, contact name and contact email are required' });
      }
      if (organizationEmail.trim().toLowerCase() === contactEmail.trim().toLowerCase()) {
        return res.status(400).json({ error: "The organization email must be different from the admin's own contact email" });
      }
      const code = organizationName.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 24) + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
      // The organization's own professional email — separate from the
      // admin's personal login/invitation email, and editable only from
      // this portal (see routes/organization.js PATCH /facility).
      org = await Organization.create({
        name: organizationName.trim(),
        code,
        contactEmail,
        facility: { supportEmail: organizationEmail.trim().toLowerCase() },
      });

      const [adminFirst, ...adminRest] = contactName.trim().split(/\s+/);
      const admin = new User({
        organizationId: org._id,
        firstName: adminFirst,
        lastName: adminRest.join(' '),
        email: contactEmail,
        role: 'admin',
        status: 'pending',
      });
      const raw = admin.issueToken('activation', 72 * 60 * 60 * 1000);
      await admin.save();
      const { bootstrapOrganizationDefaults } = require('./auth');
      // Skip the default trial license — this endpoint issues the requested
      // license below, so seeding one here would create two.
      await bootstrapOrganizationDefaults(org._id, admin._id, { withLicense: false });
      // The org/admin/license are already committed at this point — a
      // failed send (bad domain, SMTP hiccup) shouldn't roll the whole
      // provisioning request back into a 500 and leave the superadmin
      // unsure whether the organization was actually created.
      try {
        await sendActivationEmail(admin, org, raw);
      } catch (err) {
        console.error('[developer] activation email failed:', err.message);
      }
      status = 'pending';
      activatedAt = undefined;
      audit(req, 'developer.org_create', { entityType: 'Organization', entityId: org._id });
    }

    const license = await License.create({
      organizationId: org._id,
      key: License.generateKey(),
      plan,
      maxUsers: Number(maxUsers),
      maxMembers: Number(maxMembers),
      features: cleanFeatures,
      contactName: contactName || undefined,
      contactEmail: contactEmail || org.contactEmail,
      expiresAt,
      status,
      activatedAt,
      issuedBy: req.user._id,
      notes,
    });
    audit(req, 'developer.license_issue', { entityType: 'License', entityId: license._id, detail: { plan, months: term, org: org.name } });
    res.status(201).json({ license });
  } catch (err) {
    next(err);
  }
});

// POST /api/developer/licenses/:id/renew — extend by N months (from expiry
// if still in the future, otherwise from today) and reactivate if expired.
router.post('/licenses/:id/renew', async (req, res, next) => {
  try {
    const license = await License.findById(req.params.id).populate('organizationId', 'name');
    if (!license) return res.status(404).json({ error: 'License not found' });
    const months = Number(req.body.months) || 12;
    if (!(months >= 1 && months <= 60)) return res.status(400).json({ error: 'Renewal term must be between 1 and 60 months' });
    const previousExpiresAt = license.expiresAt ? new Date(license.expiresAt) : null;
    const base = license.expiresAt > new Date() ? new Date(license.expiresAt) : new Date();
    base.setMonth(base.getMonth() + months);
    license.expiresAt = base;
    if (license.status === 'expired') license.status = 'active';
    // Log this renewal so the organization's history is preserved.
    license.renewals.push({
      at: new Date(),
      months,
      previousExpiresAt,
      newExpiresAt: base,
      by: req.user._id,
      note: (req.body.note || '').trim() || undefined,
    });
    // Renewing clears any pending admin renewal request.
    license.renewalRequestedAt = undefined;
    license.renewalRequestNote = undefined;
    license.renewalRequestedBy = undefined;
    await license.save();
    audit(req, 'developer.license_renew', { entityType: 'License', entityId: license._id, detail: { months, newExpiry: base } });
    res.json({ license });
  } catch (err) {
    next(err);
  }
});

// POST /api/developer/licenses/:id/change-plan — move a license to a
// different tier (upgrade or downgrade). Capacity and feature flags reset to
// the new plan's defaults, same as issuing a fresh license; fulfils any
// pending admin plan-upgrade request.
router.post('/licenses/:id/change-plan', async (req, res, next) => {
  try {
    const { PLANS, planLabel } = require('../utils/plans');
    const license = await License.findById(req.params.id).populate('organizationId', 'name');
    if (!license) return res.status(404).json({ error: 'License not found' });
    const plan = String(req.body.plan || '').toLowerCase();
    const catalog = PLANS[plan];
    if (!catalog) return res.status(400).json({ error: 'Choose a valid plan (Free, Standard or Pro)' });
    const previousPlan = license.plan;
    if (plan === previousPlan) return res.status(400).json({ error: `Already on the ${planLabel(plan)} plan` });

    license.plan = plan;
    license.maxUsers = catalog.maxUsers;
    license.maxMembers = catalog.maxMembers;
    const cleanFeatures = {};
    for (const key of License.FEATURE_KEYS) cleanFeatures[key] = catalog.features.includes(key);
    license.features = cleanFeatures;
    // Fulfils any pending request from the organization admin.
    license.requestedPlan = undefined;
    license.planRequestedAt = undefined;
    license.planRequestNote = undefined;
    license.planRequestedBy = undefined;
    await license.save();
    audit(req, 'developer.license_change_plan', {
      entityType: 'License',
      entityId: license._id,
      detail: { org: license.organizationId ? license.organizationId.name : undefined, previousPlan, plan },
    });
    res.json({ license });
  } catch (err) {
    next(err);
  }
});

// Suspend / reactivate / cancel — simple status transitions, all audited.
for (const [action, from, to] of [
  ['suspend', ['active', 'pending'], 'suspended'],
  ['reactivate', ['suspended'], 'active'],
  ['cancel', ['active', 'pending', 'suspended', 'expired'], 'cancelled'],
]) {
  router.post(`/licenses/:id/${action}`, async (req, res, next) => {
    try {
      const license = await License.findById(req.params.id);
      if (!license) return res.status(404).json({ error: 'License not found' });
      if (!from.includes(license.status)) {
        return res.status(400).json({ error: `Cannot ${action} a ${license.status} license` });
      }
      license.status = to;
      await license.save();
      audit(req, `developer.license_${action}`, { entityType: 'License', entityId: license._id });
      res.json({ license });
    } catch (err) {
      next(err);
    }
  });
}

router.post('/licenses/:id/revoke', async (req, res, next) => {
  try {
    const license = await License.findById(req.params.id);
    if (!license) return res.status(404).json({ error: 'License not found' });
    license.status = 'revoked';
    await license.save();
    audit(req, 'developer.license_revoke', { entityType: 'License', entityId: license._id });
    res.json({ license });
  } catch (err) {
    next(err);
  }
});

// --- Backups (any org, from the developer portal) ---

router.get('/backups', async (req, res, next) => {
  try {
    const items = await Backup.find().sort({ createdAt: -1 }).limit(100).populate('organizationId', 'name code');
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// GET /api/developer/backups/:id/download — cross-org, superadmin only.
router.get('/backups/:id/download', async (req, res, next) => {
  try {
    const backup = await Backup.findById(req.params.id);
    if (!backup) return res.status(404).json({ error: 'Backup not found' });
    audit(req, 'developer.backup_download', { entityType: 'Backup', entityId: backup._id });
    res.download(backup.filePath, backup.fileName);
  } catch (err) {
    next(err);
  }
});

// POST /api/developer/backups/:id/restore — destructive; requires confirm.
router.post('/backups/:id/restore', async (req, res, next) => {
  try {
    if (req.body.confirm !== 'RESTORE') {
      return res.status(400).json({ error: 'Type RESTORE to confirm — this replaces all current organization data' });
    }
    const backup = await Backup.findById(req.params.id);
    if (!backup || backup.status !== 'completed') return res.status(404).json({ error: 'Backup not found' });
    if (!backup.organizationId) return res.status(400).json({ error: 'System-scope backups cannot be restored from here' });
    const { restoreOrgBackup } = require('../utils/backupService');
    const restored = await restoreOrgBackup(backup, backup.organizationId);
    audit(req, 'developer.backup_restore', { entityType: 'Backup', entityId: backup._id, detail: { restored } });
    res.json({ message: 'Restore completed — all users of that organization must sign in again', restored });
  } catch (err) {
    next(err);
  }
});

router.post('/backups/:orgId', async (req, res, next) => {
  try {
    const backup = await createOrgBackup(req.params.orgId, { trigger: 'manual', createdBy: req.user._id });
    audit(req, 'developer.backup_create', { entityType: 'Backup', entityId: backup._id });
    res.status(201).json({ backup });
  } catch (err) {
    next(err);
  }
});

// --- System updates (release notes) ---

router.post('/updates', async (req, res, next) => {
  try {
    const { version, title, body, kind = 'release', status = 'published' } = req.body;
    if (!version || !title) return res.status(400).json({ error: 'Version and title are required' });
    const update = await SystemUpdate.create({ version, title, body, kind, status, publishedBy: req.user._id });
    audit(req, 'developer.update_publish', { entityType: 'SystemUpdate', entityId: update._id });
    res.status(201).json({ update });
  } catch (err) {
    next(err);
  }
});

// --- Audit trail ---

router.get('/audit', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.org) filter.organizationId = req.query.org;
    if (req.query.action) filter.action = new RegExp(String(req.query.action), 'i');
    const items = await AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(200)
      .populate('actorId', 'firstName lastName email role')
      .populate('organizationId', 'name');
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
