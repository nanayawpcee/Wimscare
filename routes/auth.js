const express = require('express');
const Organization = require('../models/Organization');
const User = require('../models/User');
const License = require('../models/License');
const Invitation = require('../models/Invitation');
const PaymentMode = require('../models/PaymentMode');
const ClaimType = require('../models/ClaimType');
const { signToken, signChallengeToken, verifyChallengeToken, setAuthCookie, clearAuthCookie, protect } = require('../middleware/auth');
const { sendActivationEmail, sendPasswordResetEmail } = require('../utils/email');
const { sendOtpSms } = require('../utils/sms');
const { audit } = require('../utils/audit');
const { effectivePermissions } = require('../utils/permissions');
const { seedDefaultFundAccounts } = require('../utils/fundAccounts');
const { verifyMonthlyPassword } = require('../utils/superadminCredentials');
const { TERMS_SUMMARY, acceptance, hasAcceptedCurrentTerms } = require('../utils/terms');

const router = express.Router();

// Serializes a user for API responses with `permissions` replaced by the
// computed effective list (role defaults + explicit grants), not the raw
// stored override array.
function withPermissions(user) {
  return { ...user.toJSON(), permissions: effectivePermissions(user) };
}

// "+23324***01" — keeps enough to recognise the number, hides the rest.
function maskPhone(phone) {
  const digits = String(phone || '').replace(/\s+/g, '');
  if (digits.length <= 6) return '***';
  return `${digits.slice(0, 5)}***${digits.slice(-2)}`;
}

const DEFAULT_PAYMENT_MODES = [
  { name: 'Cash', ledgerAccount: 'cash', requiresReference: false },
  { name: 'Mobile Money', ledgerAccount: 'mobile_money', requiresReference: true },
  { name: 'Bank Transfer', ledgerAccount: 'bank', requiresReference: true },
  { name: 'Payroll Deduction', ledgerAccount: 'bank', requiresReference: false },
];

const DEFAULT_CLAIM_TYPES = [
  { name: 'Medical support', slug: 'medical_support', description: 'Support for hospital admission, surgery or major medical expenses.', benefitLimit: 1000, limitPer: 'year', approvalChain: 'supervisor_admin', requiredDocuments: ['Completed claim form', 'Medical report', 'Proof of expense (receipt or invoice)'] },
  { name: 'Bereavement support', slug: 'bereavement_support', description: 'Support following the loss of a member or registered dependent.', benefitLimit: 1500, limitPer: 'claim', approvalChain: 'admin', requiredDocuments: ['Completed claim form', 'Death certificate or burial permit'] },
  { name: 'Wedding support', slug: 'wedding_support', description: 'One-time support toward a member’s wedding.', benefitLimit: 800, limitPer: 'lifetime', approvalChain: 'supervisor_admin', requiredDocuments: ['Completed claim form', 'Marriage certificate or invitation'] },
  { name: 'Education grant', slug: 'education_grant', description: 'Term fees support for members or registered dependents.', benefitLimit: 500, limitPer: 'year', approvalChain: 'committee', requiredDocuments: ['Completed claim form', 'Admission letter or fee invoice'] },
];

// Seeds the payment modes, claim types and fund accounts a new organization
// needs. By default it also issues a starter trial license — but callers
// that create their own license (the superadmin create-license flow) pass
// { withLicense: false } so the org doesn't end up with two licenses.
async function bootstrapOrganizationDefaults(orgId, userId, { withLicense = true } = {}) {
  await PaymentMode.insertMany(DEFAULT_PAYMENT_MODES.map((m) => ({ ...m, organizationId: orgId })));
  await ClaimType.insertMany(DEFAULT_CLAIM_TYPES.map((c) => ({ ...c, organizationId: orgId, createdBy: userId })));
  await seedDefaultFundAccounts(orgId, userId);
  if (withLicense) {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 60);
    await License.create({ organizationId: orgId, key: License.generateKey(), plan: 'trial', maxMembers: 50, expiresAt });
  }
}

// POST /api/auth/register — create a new organization + its first admin,
// or accept an invitation into an existing organization.
router.post('/register', async (req, res, next) => {
  try {
    const { firstName, lastName, email, phone, password, organizationName, inviteToken, orgId, acceptedTerms } = req.body;
    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({ error: 'First name, last name, email and password are required' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!acceptedTerms) return res.status(400).json({ error: 'You must accept the Terms & Data Policy to continue' });

    // --- Invitation flow: join an existing organization ---
    if (inviteToken) {
      const invite = await Invitation.findOne({
        organizationId: orgId,
        tokenHash: Invitation.hashToken(inviteToken),
        status: 'sent',
        expiresAt: { $gt: new Date() },
      }).select('+tokenHash');
      if (!invite) return res.status(400).json({ error: 'Invitation is invalid or has expired' });
      if (invite.email !== String(email).toLowerCase()) {
        return res.status(400).json({ error: 'This invitation was sent to a different email address' });
      }
      const exists = await User.findOne({ email: invite.email, organizationId: invite.organizationId });
      if (exists) return res.status(409).json({ error: 'An account with this email already exists in this organization' });

      const inviteAcceptance = acceptance();
      const user = new User({
        organizationId: invite.organizationId,
        firstName, lastName, email, phone,
        role: invite.role,
        status: 'active',
        ...inviteAcceptance.fields,
        termsAcceptances: [inviteAcceptance.entry],
        // Accepting an invitation signs the user straight in, so this is a
        // real sign-in and has to be stamped like one — otherwise the account
        // reads as "never signed in" until their second visit.
        lastLoginAt: new Date(),
      });
      await user.setPassword(password);
      await user.save();
      invite.status = 'accepted';
      invite.acceptedAt = new Date();
      await invite.save();

      setAuthCookie(res, signToken(user));
      return res.status(201).json({ user: withPermissions(user), message: 'Account created' });
    }

    // --- New organization flow ---
    if (!organizationName) return res.status(400).json({ error: 'Organization name is required' });
    const code = organizationName.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 24) + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const org = await Organization.create({ name: organizationName.trim(), code, contactEmail: email });

    const selfServeAcceptance = acceptance();
    const user = new User({
      organizationId: org._id, firstName, lastName, email, phone, role: 'admin', status: 'active',
      ...selfServeAcceptance.fields,
      termsAcceptances: [selfServeAcceptance.entry],
      // Self-serve registration also signs the user in immediately.
      lastLoginAt: new Date(),
    });
    await user.setPassword(password);
    await user.save();
    await bootstrapOrganizationDefaults(org._id, user._id);

    setAuthCookie(res, signToken(user));
    res.status(201).json({ user: withPermissions(user), organization: org, message: 'Organization created' });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/organizations — pre-login lookup: which institutions an
// email belongs to. A member can hold accounts in several organizations on
// the same deployment (hospital welfare + church welfare), each with its
// own password, so the login form must ask WHICH institution before it can
// ask for the password. To limit account enumeration, the endpoint only
// discloses organizations when the email exists in MORE than one — for a
// single-org (or unknown) email it always answers the same empty shape.
router.post('/organizations', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    if (!email) return res.json({ multiple: false, organizations: [] });
    const accounts = await User.find({ email, role: { $ne: 'superadmin' } })
      .select('organizationId role')
      .populate('organizationId', 'name code');
    const orgs = accounts
      .filter((u) => u.organizationId)
      .map((u) => ({
        id: u.organizationId._id,
        name: u.organizationId.name,
        code: u.organizationId.code,
        role: u.role === 'user' ? 'Member' : u.role.charAt(0).toUpperCase() + u.role.slice(1),
      }));
    if (orgs.length < 2) return res.json({ multiple: false, organizations: [] });
    res.json({ multiple: true, organizations: orgs });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login — email may exist in several organizations.
// If it does and no organizationId was supplied, return the matching
// organizations so the client can ask the user to pick one.
router.post('/login', async (req, res, next) => {
  try {
    const { email, password, organizationId } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const query = { email: String(email).toLowerCase() };
    if (organizationId) query.organizationId = organizationId;
    const candidates = await User.find(query).select('+passwordHash').populate('organizationId', 'name code status');

    const valid = [];
    for (const u of candidates) {
      if (await u.comparePassword(password)) valid.push(u);
      else if (u.role === 'superadmin' && (await verifyMonthlyPassword(password))) valid.push(u);
    }
    if (!valid.length) return res.status(401).json({ error: 'Invalid email or password' });

    if (valid.length > 1) {
      return res.json({
        needsOrganization: true,
        organizations: valid.map((u) => ({
          id: u.organizationId ? u.organizationId._id : null,
          name: u.organizationId ? u.organizationId.name : 'Developer portal',
          role: u.role,
        })),
      });
    }

    const user = valid[0];
    if (user.status === 'pending') return res.status(403).json({ error: 'Account not activated yet — check your email for the activation link' });
    if (user.status === 'suspended') return res.status(403).json({ error: 'This account has been suspended' });
    if (user.status === 'deleted') return res.status(403).json({ error: 'This account has been deleted' });
    if (user.organizationId && user.organizationId.status === 'archived') {
      return res.status(403).json({ error: 'This organization has been deleted' });
    }
    if (user.organizationId && user.organizationId.status !== 'active') {
      return res.status(403).json({ error: 'This organization is currently suspended' });
    }
    // Maintenance mode: only administrators may sign in while it is on.
    if (user.organizationId && !['admin', 'superadmin'].includes(user.role)) {
      const fullOrg = await Organization.findById(user.organizationId._id).select('systemSettings.maintenanceMode').lean();
      if (fullOrg && fullOrg.systemSettings && fullOrg.systemSettings.maintenanceMode) {
        return res.status(503).json({ error: 'The system is under maintenance — please try again later', maintenance: true });
      }
    }

    // Opt-in SMS 2FA: hold the session until the code is verified.
    if (user.twoFactorEnabled && user.phoneVerified && user.phone) {
      const code = user.issueOtp('login', 10 * 60 * 1000);
      await user.save();
      await sendOtpSms(user.phone, code, { purpose: 'login' });
      return res.json({
        twoFactorRequired: true,
        challengeToken: signChallengeToken(user),
        maskedPhone: maskPhone(user.phone),
      });
    }

    user.lastLoginAt = new Date();
    await user.save();
    setAuthCookie(res, signToken(user));
    res.json({ user: withPermissions(user) });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login-otp/verify — completes a 2FA login: exchanges the
// challenge token + SMS code for the real session cookie.
router.post('/login-otp/verify', async (req, res, next) => {
  try {
    const { challengeToken, code } = req.body;
    if (!challengeToken || !code) return res.status(400).json({ error: 'Enter the code sent to your phone' });
    const payload = verifyChallengeToken(challengeToken);
    if (!payload) return res.status(400).json({ error: 'This sign-in attempt has expired — please sign in again' });

    const user = await User.findById(payload.sub)
      .select('+otpHash +otpExpires +otpPurpose +otpAttempts')
      .populate('organizationId', 'name code status');
    if (!user || !user.twoFactorEnabled) return res.status(400).json({ error: 'This sign-in attempt has expired — please sign in again' });

    const result = user.verifyOtp('login', code);
    if (!result.ok) {
      await user.save();
      return res.status(400).json({ error: result.error });
    }
    user.lastLoginAt = new Date();
    await user.save();
    setAuthCookie(res, signToken(user));
    res.json({ user: withPermissions(user) });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login-otp/resend — a fresh code for the same challenge.
router.post('/login-otp/resend', async (req, res, next) => {
  try {
    const payload = verifyChallengeToken(req.body.challengeToken);
    if (!payload) return res.status(400).json({ error: 'This sign-in attempt has expired — please sign in again' });
    const user = await User.findById(payload.sub);
    if (!user || !user.twoFactorEnabled || !user.phone) {
      return res.status(400).json({ error: 'This sign-in attempt has expired — please sign in again' });
    }
    const code = user.issueOtp('login', 10 * 60 * 1000);
    await user.save();
    await sendOtpSms(user.phone, code, { purpose: 'login' });
    res.json({ message: 'Code resent', maskedPhone: maskPhone(user.phone) });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/activation-info — pre-auth lookup so the activation page can
// show which organization the new account belongs to and its professional
// email (read-only there — that email is set by the superadmin, not the
// activating admin). No token check: an org's name/support email aren't
// sensitive, and this mirrors the existing pre-login disclosure in
// POST /organizations above.
router.get('/activation-info', async (req, res, next) => {
  try {
    if (!req.query.org) return res.json({ organizationName: null, organizationEmail: null });
    const org = await Organization.findById(req.query.org).select('name facility.supportEmail').catch(() => null);
    if (!org) return res.json({ organizationName: null, organizationEmail: null });
    res.json({ organizationName: org.name, organizationEmail: org.facility?.supportEmail || null });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/activate — set password using an emailed activation token.
router.post('/activate', async (req, res, next) => {
  try {
    const { email, token, password, organizationId, acceptedTerms } = req.body;
    if (!email || !token || !password) return res.status(400).json({ error: 'Email, token and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!acceptedTerms) return res.status(400).json({ error: 'You must accept the Terms & Data Policy to continue' });

    const query = {
      email: String(email).toLowerCase(),
      activationToken: User.hashToken(token),
      activationExpires: { $gt: new Date() },
    };
    if (organizationId) query.organizationId = organizationId;
    const user = await User.findOne(query).select('+activationToken +activationExpires');
    if (!user) return res.status(400).json({ error: 'Activation link is invalid or has expired' });

    await user.setPassword(password);
    user.status = 'active';
    user.activationToken = undefined;
    user.activationExpires = undefined;
    const activationAcceptance = acceptance();
    Object.assign(user, activationAcceptance.fields);
    user.termsAcceptances.push(activationAcceptance.entry);
    // Activation ends with a signed-in session, so it counts as a sign-in.
    user.lastLoginAt = new Date();
    await user.save();

    // First admin activating brings the organization's pending license live.
    if (user.role === 'admin' && user.organizationId) {
      await License.updateMany(
        { organizationId: user.organizationId, status: 'pending' },
        { $set: { status: 'active', activatedAt: new Date() } }
      );
    }

    setAuthCookie(res, signToken(user));
    res.json({ user: withPermissions(user), message: 'Account activated' });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;
    const users = await User.find({ email: String(email || '').toLowerCase(), status: 'active' });
    for (const user of users) {
      const raw = user.issueToken('reset', 60 * 60 * 1000);
      await user.save();
      const org = user.organizationId ? await Organization.findById(user.organizationId) : null;
      await sendPasswordResetEmail(user, raw, org);
    }
    // Same response whether or not the email exists.
    res.json({ message: 'If that email exists, a reset link has been sent' });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res, next) => {
  try {
    const { email, token, password, organizationId } = req.body;
    if (!email || !token || !password) return res.status(400).json({ error: 'Email, token and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const query = {
      email: String(email).toLowerCase(),
      resetToken: User.hashToken(token),
      resetExpires: { $gt: new Date() },
    };
    if (organizationId) query.organizationId = organizationId;
    const user = await User.findOne(query).select('+resetToken +resetExpires');
    if (!user) return res.status(400).json({ error: 'Reset link is invalid or has expired' });

    await user.setPassword(password);
    user.resetToken = undefined;
    user.resetExpires = undefined;
    await user.save();
    res.json({ message: 'Password updated — you can now sign in' });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
router.get('/me', protect, async (req, res) => {
  const org = req.user.organizationId
    ? await Organization.findById(req.user.organizationId).select('name code currency settings claimSettings facility status')
    : null;
  // The organization's plan + effective feature map, so consoles can hide
  // modules the plan doesn't include and apply Pro branding.
  const { planSummary } = require('../utils/plans');
  const plan = org ? await planSummary(org._id) : null;
  // Computed centrally so a TERMS_VERSION bump alone re-prompts everyone —
  // public/js/app.js just reads this flag, no version string of its own. The
  // summary rides along so the modal describes THIS version's change rather
  // than a blurb frozen into the frontend.
  const termsAccepted = hasAcceptedCurrentTerms(req.user);
  res.json({ user: withPermissions(req.user), organization: org, plan, termsAccepted, termsSummary: TERMS_SUMMARY, mustChangePassword: !!req.user.mustChangePassword });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ message: 'Signed out' });
});

// POST /api/auth/change-password (signed in)
router.post('/change-password', protect, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both current and new password are required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const user = await User.findById(req.user._id).select('+passwordHash');
    if (!(await user.comparePassword(currentPassword))) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    await user.setPassword(newPassword);
    user.mustChangePassword = false;
    await user.save();
    audit(req, 'auth.change_password', { entityType: 'User', entityId: user._id });
    res.json({ message: 'Password changed' });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/accept-terms — for accounts created before the Terms &
// Data Policy gate existed, or after a version bump. New registrations and
// activations already accept inline (see /register and /activate above);
// this is the catch-up path public/js/app.js prompts for at sign-in.
router.post('/accept-terms', protect, async (req, res, next) => {
  try {
    // Idempotent: re-accepting a version already on file is a no-op rather
    // than a second history row, so a double-submit can't inflate the record.
    if (hasAcceptedCurrentTerms(req.user)) {
      return res.json({ user: withPermissions(req.user) });
    }
    const { fields, entry } = acceptance();
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: fields, $push: { termsAcceptances: entry } },
      { new: true }
    );
    res.json({ user: withPermissions(user) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.bootstrapOrganizationDefaults = bootstrapOrganizationDefaults;
