const express = require('express');
const Profile = require('../models/Profile');
const User = require('../models/User');
const { protect, requireOrg, orgFilter } = require('../middleware/auth');
const { avatarUpload, processAvatar } = require('../middleware/upload');
const { sendOtpSms } = require('../utils/sms');
const { audit } = require('../utils/audit');

const router = express.Router();

router.use(protect, requireOrg);

// GET /api/profile — the signed-in user's profile
router.get('/', async (req, res, next) => {
  try {
    let profile = await Profile.findOne(orgFilter(req, { userId: req.user._id }));
    if (!profile) {
      profile = await Profile.create({ organizationId: req.orgId, userId: req.user._id });
    }
    res.json({ user: req.user, profile });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/profile — update own personal / bank / emergency details
router.patch('/', async (req, res, next) => {
  try {
    const profile = await Profile.findOneAndUpdate(
      orgFilter(req, { userId: req.user._id }),
      {
        $set: {
          ...(req.body.personal ? Object.fromEntries(Object.entries(req.body.personal).map(([k, v]) => [`personal.${k}`, v])) : {}),
          ...(req.body.bank ? Object.fromEntries(Object.entries(req.body.bank).map(([k, v]) => [`bank.${k}`, v])) : {}),
          ...(req.body.emergencyContact ? Object.fromEntries(Object.entries(req.body.emergencyContact).map(([k, v]) => [`emergencyContact.${k}`, v])) : {}),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    );

    // A few identity fields live on the user document.
    const userEdits = {};
    for (const key of ['firstName', 'lastName', 'phone']) {
      if (req.body[key] !== undefined) userEdits[key] = req.body[key];
    }
    let user = req.user;
    if (Object.keys(userEdits).length) {
      // A changed number invalidates any prior verification and can't keep
      // requiring an SMS code at login until it's re-verified.
      if (userEdits.phone !== undefined && String(userEdits.phone).trim() !== (req.user.phone || '')) {
        userEdits.phoneVerified = false;
        userEdits.twoFactorEnabled = false;
      }
      user = await User.findByIdAndUpdate(req.user._id, { $set: userEdits }, { new: true, runValidators: true });
    }
    audit(req, 'profile.update', { entityType: 'Profile', entityId: profile._id });
    res.json({ user, profile });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/profile/preferences — notification toggles (Member Preferences screen)
router.patch('/preferences', async (req, res, next) => {
  try {
    const allowed = ['emailNotifications', 'claimUpdates', 'contributionReceipts', 'monthlyStatement'];
    const $set = {};
    for (const key of allowed) {
      if (typeof req.body[key] === 'boolean') $set[`preferences.${key}`] = req.body[key];
    }
    const user = await User.findByIdAndUpdate(req.user._id, { $set }, { new: true });
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// --- Phone verification + SMS 2FA ---
// Reused from two entry points in the UI: right after registration (if a
// phone was given) and from Preferences when the user wants SMS alerts /
// login codes. Both are just this same authenticated flow.

// POST /api/profile/phone/send-otp — (re)send a verification code to the
// signed-in user's phone. An optional `phone` in the body updates the
// number on file first (e.g. entering one for the first time in
// Preferences) and resets any prior verification.
router.post('/phone/send-otp', async (req, res, next) => {
  try {
    const phone = String(req.body.phone ?? req.user.phone ?? '').trim();
    if (!phone) return res.status(400).json({ error: 'Enter a phone number first' });
    const user = await User.findById(req.user._id);
    if (phone !== (user.phone || '')) {
      user.phone = phone;
      user.phoneVerified = false;
      user.twoFactorEnabled = false;
    }
    const code = user.issueOtp('phone_verify', 10 * 60 * 1000);
    await user.save();
    await sendOtpSms(phone, code, { purpose: 'phone_verify' });
    res.json({ message: `Verification code sent to ${phone}` });
  } catch (err) {
    next(err);
  }
});

// POST /api/profile/phone/verify-otp — confirm the code just sent.
router.post('/phone/verify-otp', async (req, res, next) => {
  try {
    const code = String(req.body.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Enter the code sent to your phone' });
    const user = await User.findById(req.user._id).select('+otpHash +otpExpires +otpPurpose +otpAttempts');
    const result = user.verifyOtp('phone_verify', code);
    if (!result.ok) {
      await user.save();
      return res.status(400).json({ error: result.error });
    }
    user.phoneVerified = true;
    user.phoneVerifiedAt = new Date();
    await user.save();
    audit(req, 'profile.phone_verified', { entityType: 'User', entityId: user._id });
    res.json({ user, message: 'Phone number verified' });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/profile/two-factor — opt in/out of an SMS code at login.
// Requires a verified phone before it can be turned on.
router.patch('/two-factor', async (req, res, next) => {
  try {
    const enabled = !!req.body.enabled;
    if (enabled && !req.user.phoneVerified) {
      return res.status(400).json({ error: 'Verify your phone number first' });
    }
    const user = await User.findByIdAndUpdate(req.user._id, { $set: { twoFactorEnabled: enabled } }, { new: true });
    audit(req, 'profile.two_factor_toggle', { entityType: 'User', entityId: user._id, detail: { enabled } });
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// --- Account deletion request ---
// A member's request is fulfilled by their org admin (routes/users.js);
// an admin's request is fulfilled by the superadmin (routes/developer.js) —
// same endpoint either way, since it just flags the requester's own record.

// POST /api/profile/request-deletion
router.post('/request-deletion', async (req, res, next) => {
  try {
    if (req.user.deletionRequestedAt) {
      return res.status(400).json({ error: 'A deletion request is already pending' });
    }
    const user = await User.findByIdAndUpdate(
      req.user._id,
      {
        $set: {
          deletionRequestedAt: new Date(),
          deletionRequestReason: (req.body.reason || '').trim() || undefined,
          deletionRequestedBy: req.user._id,
        },
      },
      { new: true }
    );
    audit(req, 'profile.request_deletion', { entityType: 'User', entityId: user._id, detail: { reason: req.body.reason } });
    res.json({
      user,
      message: req.user.role === 'admin'
        ? 'Deletion request sent — the WIMScare team will follow up.'
        : 'Deletion request sent to your organization administrator.',
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/profile/cancel-deletion-request — withdraw a pending request.
router.post('/cancel-deletion-request', async (req, res, next) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $unset: { deletionRequestedAt: '', deletionRequestReason: '', deletionRequestedBy: '' } },
      { new: true }
    );
    audit(req, 'profile.cancel_deletion_request', { entityType: 'User', entityId: user._id });
    res.json({ user, message: 'Deletion request withdrawn' });
  } catch (err) {
    next(err);
  }
});

// POST /api/profile/avatar — upload + resize profile photo
router.post('/avatar', avatarUpload.single('avatar'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const relPath = await processAvatar(req);
    const user = await User.findByIdAndUpdate(req.user._id, { $set: { avatarPath: relPath } }, { new: true });
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// --- Family members ---

router.post('/family', async (req, res, next) => {
  try {
    const { name, relationship, dateOfBirth, phone, isBeneficiary } = req.body;
    if (!name || !relationship) return res.status(400).json({ error: 'Name and relationship are required' });
    const profile = await Profile.findOneAndUpdate(
      orgFilter(req, { userId: req.user._id }),
      { $push: { family: { name, relationship, dateOfBirth, phone, isBeneficiary: !!isBeneficiary } } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.status(201).json({ profile });
  } catch (err) {
    next(err);
  }
});

router.delete('/family/:memberId', async (req, res, next) => {
  try {
    const profile = await Profile.findOneAndUpdate(
      orgFilter(req, { userId: req.user._id }),
      { $pull: { family: { _id: req.params.memberId } } },
      { new: true }
    );
    res.json({ profile });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
