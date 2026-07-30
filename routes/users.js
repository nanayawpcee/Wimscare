const express = require('express');
const User = require('../models/User');
const Organization = require('../models/Organization');
const Profile = require('../models/Profile');
const License = require('../models/License');
const { protect, requireRoles, requirePermission, requireOrg, orgFilter } = require('../middleware/auth');
const { sendActivationEmail } = require('../utils/email');
const { audit } = require('../utils/audit');
const { PERMISSIONS, ROLE_DEFAULTS, hasPermission, effectivePermissions } = require('../utils/permissions');

const router = express.Router();

router.use(protect, requireOrg);

// GET /api/users — admin list with search, role/status filters, pagination
router.get('/', requireRoles('admin', 'supervisor', 'accountant'), async (req, res, next) => {
  try {
    const { q, role, status, hasDeletionRequest, page = 1, limit = 20 } = req.query;
    const filter = orgFilter(req);
    if (role) filter.role = role;
    // Deleted accounts are hidden from the default list — kept for
    // reporting/audit, not for day-to-day user management. Pass
    // ?status=deleted explicitly to see them.
    if (status) filter.status = status;
    else filter.status = { $ne: 'deleted' };
    if (hasDeletionRequest) filter.deletionRequestedAt = { $ne: null };
    if (q) {
      const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }, { memberNumber: rx }];
    }
    const perPage = Math.min(Number(limit) || 20, 100);
    const [items, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip((Number(page) - 1) * perPage).limit(perPage),
      User.countDocuments(filter),
    ]);
    res.json({ items, total, page: Number(page), pages: Math.ceil(total / perPage) });
  } catch (err) {
    next(err);
  }
});

// POST /api/users — admin creates a member; activation email is sent
router.post('/', requirePermission('manage_users'), async (req, res, next) => {
  try {
    const { firstName, lastName, email, phone, role = 'user', memberNumber, department } = req.body;
    if (!firstName || !lastName || !email) return res.status(400).json({ error: 'First name, last name and email are required' });
    if (!['admin', 'supervisor', 'accountant', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

    // Plan seat check — staff roles draw from maxUsers, members from
    // maxMembers; open invitations count too (utils/plans.js).
    const seat = await require('../utils/plans').checkSeat(req.orgId, role);
    if (!seat.ok) return res.status(403).json({ error: seat.error, upgradeRequired: true });

    const exists = await User.findOne(orgFilter(req, { email: String(email).toLowerCase() }));
    if (exists) return res.status(409).json({ error: 'A user with this email already exists in this organization' });

    const user = new User({
      organizationId: req.orgId,
      firstName, lastName, email, phone, role, memberNumber, department,
      status: 'pending',
    });
    const raw = user.issueToken('activation', 72 * 60 * 60 * 1000);
    await user.save();
    await Profile.create({ organizationId: req.orgId, userId: user._id });

    const org = await Organization.findById(req.orgId);
    // The user/profile are already committed at this point — a failed send
    // (bad domain, SMTP hiccup) shouldn't roll the whole request back into a
    // 500 and leave the admin unsure whether the account was actually
    // created; they can use "resend activation" once the address is fixed.
    let emailSent = true;
    try {
      await sendActivationEmail(user, org, raw);
    } catch (err) {
      emailSent = false;
      console.error('[users] activation email failed:', err.message);
    }
    audit(req, 'user.create', { entityType: 'User', entityId: user._id, detail: { email: user.email, role } });
    res.status(201).json({
      user,
      message: emailSent ? 'User created — activation email sent' : 'User created, but the activation email failed to send — use "resend activation" once the address is fixed',
      emailSent,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/users/:id
router.get('/:id', requireRoles('admin', 'supervisor', 'accountant'), async (req, res, next) => {
  try {
    const user = await User.findOne(orgFilter(req, { _id: req.params.id }));
    if (!user) return res.status(404).json({ error: 'User not found' });
    const profile = await Profile.findOne(orgFilter(req, { userId: user._id }));
    res.json({ user, profile });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/users/:id — admin (or a user granted manage_users) edits identity/status.
// Role changes stay admin-only — that's a privilege change, handled by the
// dedicated Permissions & Roles endpoint below so it's always audited together
// with the permission grants.
router.patch('/:id', requirePermission('manage_users'), async (req, res, next) => {
  try {
    const user = await User.findOne(orgFilter(req, { _id: req.params.id }));
    if (!user) return res.status(404).json({ error: 'User not found' });

    const allowed = ['firstName', 'lastName', 'phone', 'memberNumber', 'department'];
    for (const key of allowed) if (req.body[key] !== undefined) user[key] = req.body[key];

    if (req.body.role !== undefined) {
      // Changing role is a privilege change — only an actual administrator
      // may do it, even if the caller was let in via a granted 'manage_users'
      // permission. Prevents permission escalation through a granted flag.
      if (!['admin', 'superadmin'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Only an administrator can change a user\'s role' });
      }
      if (!['admin', 'supervisor', 'accountant', 'user'].includes(req.body.role)) {
        return res.status(400).json({ error: 'Invalid role' });
      }
      if (String(user._id) === String(req.user._id) && req.body.role !== 'admin') {
        return res.status(400).json({ error: 'You cannot demote your own account' });
      }
      user.role = req.body.role;
    }
    if (req.body.status !== undefined) {
      if (!['pending', 'active', 'suspended'].includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
      if (String(user._id) === String(req.user._id) && req.body.status !== 'active') {
        return res.status(400).json({ error: 'You cannot suspend your own account' });
      }
      user.status = req.body.status;
    }

    await user.save();
    audit(req, 'user.update', { entityType: 'User', entityId: user._id, detail: req.body });
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// POST /api/users/:id/approve-deletion — carries out a member/staff
// deletion request. Admin accounts are excluded here on purpose: an admin's
// own deletion (or the organization's) can only be approved by the
// superadmin (see routes/developer.js) — there's no one above an admin
// within the org itself.
router.post('/:id/approve-deletion', requirePermission('manage_users'), async (req, res, next) => {
  try {
    const user = await User.findOne(orgFilter(req, { _id: req.params.id, role: { $ne: 'admin' } }));
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.deletionRequestedAt) return res.status(400).json({ error: 'This account has no pending deletion request' });

    user.status = 'deleted';
    user.deletedAt = new Date();
    user.deletedBy = req.user._id;
    user.deletionRequestedAt = undefined;
    user.deletionRequestReason = undefined;
    user.deletionRequestedBy = undefined;
    await user.save();
    audit(req, 'user.approve_deletion', { entityType: 'User', entityId: user._id, detail: { email: user.email } });
    res.json({ user, message: 'Account deleted' });
  } catch (err) {
    next(err);
  }
});

// POST /api/users/:id/reject-deletion — declines the request; the account
// is left untouched and active.
router.post('/:id/reject-deletion', requirePermission('manage_users'), async (req, res, next) => {
  try {
    const user = await User.findOne(orgFilter(req, { _id: req.params.id, role: { $ne: 'admin' } }));
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.deletionRequestedAt = undefined;
    user.deletionRequestReason = undefined;
    user.deletionRequestedBy = undefined;
    await user.save();
    audit(req, 'user.reject_deletion', { entityType: 'User', entityId: user._id });
    res.json({ user, message: 'Deletion request declined' });
  } catch (err) {
    next(err);
  }
});

// POST /api/users/:id/reset-password — superadmin only, and only while
// acting inside an organization via the developer portal's "Open as
// superadmin" access (X-Org-Id). Resets the account to a known shared
// password so the superadmin can hand it back to a locked-out user for
// support purposes; the account is then blocked behind a forced
// password-change prompt (public/js/app.js requireSession) until the user
// sets their own, so the shared value is never left standing.
const DEFAULT_RESET_PASSWORD = 'defaultuser';
router.post('/:id/reset-password', async (req, res, next) => {
  try {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Only the superadmin can reset a password to the default' });
    const user = await User.findOne(orgFilter(req, { _id: req.params.id }));
    if (!user) return res.status(404).json({ error: 'User not found' });
    await user.setPassword(DEFAULT_RESET_PASSWORD);
    user.mustChangePassword = true;
    // A locked-out user asking for a password reset may also have lost
    // access to the phone their SMS code goes to — leaving 2FA on would
    // just trade one lockout for another, so it's turned off here too.
    // phoneVerified/phone are left alone; only the login *requirement* is
    // cleared. They can re-enable it once they're back in.
    const hadTwoFactor = user.twoFactorEnabled;
    user.twoFactorEnabled = false;
    await user.save();
    audit(req, 'user.reset_password', { entityType: 'User', entityId: user._id, detail: { email: user.email, twoFactorDisabled: hadTwoFactor } });
    res.json({
      message: hadTwoFactor
        ? `Password reset to "${DEFAULT_RESET_PASSWORD}" and SMS two-factor turned off — they'll be asked to set a new password at their next sign-in`
        : `Password reset to "${DEFAULT_RESET_PASSWORD}" — they'll be asked to set a new one at their next sign-in`,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/users/:id/resend-activation
router.post('/:id/resend-activation', requirePermission('invite_users'), async (req, res, next) => {
  try {
    const user = await User.findOne(orgFilter(req, { _id: req.params.id, status: 'pending' }));
    if (!user) return res.status(404).json({ error: 'Pending user not found' });
    const raw = user.issueToken('activation', 72 * 60 * 60 * 1000);
    await user.save();
    const org = await Organization.findById(req.orgId);
    try {
      await sendActivationEmail(user, org, raw);
    } catch (err) {
      console.error('[users] resend activation email failed:', err.message);
      return res.status(502).json({ error: `Could not send the activation email (${err.message || 'the mail server rejected it'}) — check the address and try again` });
    }
    audit(req, 'user.resend_activation', { entityType: 'User', entityId: user._id });
    res.json({ message: 'Activation email re-sent' });
  } catch (err) {
    next(err);
  }
});

// Only an actual administrator may view/change another user's permissions
// or role — matches the design's "Permissions & Roles" page, which is
// reachable only when the viewer already has manage_permissions (default:
// admin only, but grantable).
function requireManagePermissions(req, res, next) {
  if (['admin', 'superadmin'].includes(req.user.role) || hasPermission(req.user, 'manage_permissions')) return next();
  return res.status(403).json({ error: 'You do not have permission to manage user permissions' });
}

// GET /api/users/:id/permissions — role, explicit grants, effective list and
// the full catalogue (with role-default flags) so the UI can render toggles.
router.get('/:id/permissions', requireManagePermissions, async (req, res, next) => {
  try {
    const user = await User.findOne(orgFilter(req, { _id: req.params.id }));
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      user: { _id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email, memberNumber: user.memberNumber, role: user.role },
      permissions: user.permissions || [],
      effective: effectivePermissions(user),
      catalogue: PERMISSIONS,
      roleDefaults: ROLE_DEFAULTS,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/users/:id/permissions — set role + explicit permission grants.
router.patch('/:id/permissions', requireManagePermissions, async (req, res, next) => {
  try {
    const user = await User.findOne(orgFilter(req, { _id: req.params.id }));
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (req.body.role !== undefined) {
      if (!['admin', 'supervisor', 'accountant', 'user'].includes(req.body.role)) {
        return res.status(400).json({ error: 'Invalid role' });
      }
      if (String(user._id) === String(req.user._id) && req.body.role !== 'admin') {
        return res.status(400).json({ error: 'You cannot demote your own account' });
      }
      user.role = req.body.role;
    }
    if (req.body.permissions !== undefined) {
      const list = Array.isArray(req.body.permissions) ? req.body.permissions : [];
      const invalid = list.filter((p) => !PERMISSIONS.includes(p));
      if (invalid.length) return res.status(400).json({ error: `Unknown permission(s): ${invalid.join(', ')}` });
      user.permissions = [...new Set(list)];
    }

    await user.save();
    audit(req, 'user.permissions_update', { entityType: 'User', entityId: user._id, detail: { role: user.role, permissions: user.permissions } });
    res.json({ user: { _id: user._id, role: user.role, permissions: user.permissions, effective: effectivePermissions(user) } });
  } catch (err) {
    next(err);
  }
});

// POST /api/users/:id/permissions/reset — clear explicit grants back to role defaults.
router.post('/:id/permissions/reset', requireManagePermissions, async (req, res, next) => {
  try {
    const user = await User.findOne(orgFilter(req, { _id: req.params.id }));
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.permissions = [];
    await user.save();
    audit(req, 'user.permissions_reset', { entityType: 'User', entityId: user._id });
    res.json({ user: { _id: user._id, role: user.role, permissions: [], effective: effectivePermissions(user) } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
