const express = require('express');
const Invitation = require('../models/Invitation');
const Organization = require('../models/Organization');
const User = require('../models/User');
const { protect, requirePermission, requireOrg, orgFilter } = require('../middleware/auth');
const { sendInvitationEmail } = require('../utils/email');
const { audit } = require('../utils/audit');

const router = express.Router();

// Public: validate an invite token so register.html can prefill email/org.
router.get('/lookup', async (req, res, next) => {
  try {
    const { token, org } = req.query;
    if (!token || !org) return res.status(400).json({ error: 'Missing invitation token' });
    const invite = await Invitation.findOne({
      organizationId: org,
      tokenHash: Invitation.hashToken(token),
      status: 'sent',
      expiresAt: { $gt: new Date() },
    });
    if (!invite) return res.status(404).json({ error: 'Invitation is invalid or has expired' });
    const organization = await Organization.findById(org).select('name');
    res.json({ email: invite.email, role: invite.role, organizationName: organization?.name });
  } catch (err) {
    next(err);
  }
});

router.use(protect, requireOrg, requirePermission('invite_users'));

// GET /api/invitations
router.get('/', async (req, res, next) => {
  try {
    const { status, page = 1, limit = 15 } = req.query;
    const filter = orgFilter(req);
    if (status) filter.status = status;
    const perPage = Math.min(Number(limit) || 15, 100);
    const [items, total] = await Promise.all([
      Invitation.find(filter)
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * perPage)
        .limit(perPage)
        .populate('invitedBy', 'firstName lastName'),
      Invitation.countDocuments(filter),
    ]);
    res.json({ items, total, page: Number(page), pages: Math.ceil(total / perPage) });
  } catch (err) {
    next(err);
  }
});

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/invitations — send invite links. Accepts a single `email` or a
// bulk `emails` value (array, or one string separated by commas/semicolons/
// whitespace/newlines). All invitations share the same `role`.
router.post('/', async (req, res, next) => {
  try {
    const { email, emails, role = 'user' } = req.body;
    if (!['admin', 'supervisor', 'accountant', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    // Inviting a new administrator is a privilege grant — restrict to actual
    // admins even if the caller only has a granted 'invite_users' permission.
    if (role === 'admin' && !['admin', 'superadmin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only an administrator can invite another administrator' });
    }

    const rawList = Array.isArray(emails) ? emails : String(emails || email || '').split(/[\s,;]+/);
    const list = [...new Set(rawList.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
    if (!list.length) return res.status(400).json({ error: 'At least one email address is required' });
    if (list.length > 50) return res.status(400).json({ error: 'Maximum 50 invitations per batch' });

    const org = await Organization.findById(req.orgId);
    const results = [];
    for (const addr of list) {
      if (!EMAIL_RX.test(addr)) {
        results.push({ email: addr, status: 'invalid', reason: 'Not a valid email address' });
        continue;
      }
      const existingUser = await User.findOne(orgFilter(req, { email: addr }));
      if (existingUser) {
        results.push({ email: addr, status: 'skipped', reason: 'Already has an account in this organization' });
        continue;
      }
      // A fresh invite supersedes any still-pending one for the same
      // address. A superseded token has no ongoing value (it's a one-time
      // link, not a financial record needing an audit trail), so it's
      // removed outright rather than kept around as a stale "revoked" row.
      await Invitation.deleteMany(
        orgFilter(req, { email: addr, status: 'sent' }),
      );
      // Plan seat check per address, after the supersede so re-inviting the
      // same person is seat-neutral. Each invitation created in this batch
      // occupies a seat; the count is re-read every iteration.
      const seat = await require('../utils/plans').checkSeat(req.orgId, role);
      if (!seat.ok) {
        results.push({ email: addr, status: 'skipped', reason: seat.error });
        continue;
      }
      const { raw, hash } = Invitation.issue();
      const invite = await Invitation.create({
        organizationId: req.orgId,
        email: addr,
        role,
        tokenHash: hash,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        invitedBy: req.user._id,
      });
      // A rejected recipient (typo, full mailbox, non-existent domain) is a
      // normal occurrence in a batch — it shouldn't abort the whole request
      // and leave a phantom "sent" invitation behind for an email that was
      // never delivered, so the failed address is removed and reported
      // rather than left in the database.
      let url;
      try {
        url = await sendInvitationEmail(invite, org, raw);
      } catch (err) {
        await Invitation.deleteOne({ _id: invite._id });
        console.error('[invitations] send failed:', addr, err.message);
        results.push({ email: addr, status: 'failed', reason: err.message || 'The mail server rejected this address' });
        continue;
      }
      audit(req, 'invitation.send', { entityType: 'Invitation', entityId: invite._id, detail: { email: addr, role } });
      // Without SMTP configured the email is only logged, so hand the link to the admin.
      results.push({ email: addr, status: 'sent', ...(process.env.SMTP_HOST ? {} : { inviteUrl: url }) });
    }

    const sent = results.filter((r) => r.status === 'sent').length;
    const skipped = results.length - sent;
    res.status(sent ? 201 : 400).json({
      results,
      sent,
      skipped,
      message: sent
        ? `${sent} invitation${sent === 1 ? '' : 's'} sent${skipped ? `, ${skipped} skipped` : ''}`
        : 'No invitations were sent',
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/invitations/:id/resend — fresh token + 7 more days, re-email
router.post('/:id/resend', async (req, res, next) => {
  try {
    const invite = await Invitation.findOne(orgFilter(req, { _id: req.params.id, status: { $in: ['sent', 'expired'] } })).select('+tokenHash');
    if (!invite) return res.status(404).json({ error: 'Invitation not found or already used' });

    const { raw, hash } = Invitation.issue();
    invite.tokenHash = hash;
    invite.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    invite.status = 'sent';
    await invite.save();

    const org = await Organization.findById(req.orgId);
    let url;
    try {
      url = await sendInvitationEmail(invite, org, raw);
    } catch (err) {
      console.error('[invitations] resend failed:', invite.email, err.message);
      return res.status(502).json({ error: `Could not send the invitation email (${err.message || 'the mail server rejected it'}) — check the address and try again` });
    }
    audit(req, 'invitation.resend', { entityType: 'Invitation', entityId: invite._id });
    res.json({
      invitation: invite,
      message: 'Invitation re-sent',
      ...(process.env.SMTP_HOST ? {} : { inviteUrl: url }),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/invitations/:id/revoke
router.post('/:id/revoke', async (req, res, next) => {
  try {
    const invite = await Invitation.findOne(orgFilter(req, { _id: req.params.id, status: 'sent' }));
    if (!invite) return res.status(404).json({ error: 'Active invitation not found' });
    // A revoked token has no ongoing value, so it's removed outright rather
    // than kept around as a stale row the list would otherwise accumulate.
    await Invitation.deleteOne({ _id: invite._id });
    audit(req, 'invitation.revoke', { entityType: 'Invitation', entityId: invite._id, detail: { email: invite.email } });
    res.json({ email: invite.email });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
