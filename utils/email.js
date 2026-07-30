const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { resolveUploadPath } = require('../middleware/upload');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (process.env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  } else {
    // Dev fallback: print emails to the console instead of sending.
    transporter = nodemailer.createTransport({ jsonTransport: true });
  }
  return transporter;
}

// logoCid: every caller embeds its logo as a CID attachment (see
// resolveLogo() below) rather than a remote <img src> — most mail clients
// block remote images by default, and a remote URL pointing at a
// non-public APP_URL (e.g. localhost in dev) can never load at all.
function layout({ title, bodyHtml, ctaLabel, ctaUrl, footer, logoCid, brandName }) {
  const button = ctaUrl
    ? `<a href="${ctaUrl}" style="display:inline-block; padding:13px 26px; border-radius:10px; background:#1d6fae; color:#ffffff; font-weight:700; text-decoration:none; font-size:15px;">${ctaLabel}</a>`
    : '';
  const name = brandName || 'WIMScare';
  const logoImg = `<img src="cid:${logoCid}" alt="${name}" style="display:block; margin:0 auto 18px; max-height:64px; width:auto;">`;
  return `<!DOCTYPE html>
<html><body style="margin:0; padding:0; background:#f4f7f8; font-family:'Instrument Sans', 'Segoe UI', system-ui, sans-serif; color:#12242e;">
  <div style="max-width:560px; margin:0 auto; padding:32px 20px;">
    ${logoImg}
    <div style="text-align:center; padding-bottom:18px;">
      <span style="font-size:1.2rem; font-weight:700; color:#0f2c3f;">${name}</span>
    </div>
    <div style="background:#ffffff; border:1px solid #e2e9ec; border-radius:14px; padding:32px;">
      <h1 style="margin:0 0 14px; font-size:1.35rem; letter-spacing:-0.02em; color:#12242e;">${title}</h1>
      <div style="color:#5a6b75; font-size:15px; line-height:1.6;">${bodyHtml}</div>
      ${button ? `<div style="padding-top:22px;">${button}</div>` : ''}
    </div>
    <p style="text-align:center; color:#8a98a1; font-size:12px; line-height:1.6; padding-top:18px;">
      ${footer || 'You received this email because an account was created for you on WIMScare.'}
    </p>
  </div>
</body></html>`;
}

// The actual sending address always stays the platform's own verified
// SMTP identity — swapping in an arbitrary org domain would fail SPF/DKIM
// checks on most providers. What CAN safely vary per organization is the
// display name (so recipients see "St. Eliza Welfare via WIMScare" rather
// than a generic sender) and the Reply-To (so a reply reaches the org's own
// desk, not the platform's). See orgMailIdentity() below.
function baseFromAddress() {
  const raw = process.env.MAIL_FROM || 'WIMScare <no-reply@wimscare.app>';
  const match = raw.match(/<([^>]+)>/);
  return match ? match[1] : raw;
}

async function send({ to, subject, html, attachments, fromName, replyTo }) {
  const info = await getTransporter().sendMail({
    from: fromName ? `"${fromName.replace(/"/g, '')}" <${baseFromAddress()}>` : (process.env.MAIL_FROM || 'WIMScare <no-reply@wimscare.app>'),
    replyTo: replyTo || undefined,
    to,
    subject,
    html,
    attachments,
  });
  if (!process.env.SMTP_HOST) {
    // jsonTransport: surface the activation/reset links in the server log for dev.
    const urls = (html.match(/href="([^"]+)"/g) || []).map((m) => m.slice(6, -1));
    console.log(`[mail] (dev, not sent) to=${to} subject="${subject}"${urls.length ? ` link=${urls[0]}` : ''}`);
  }
  return info;
}

const appUrl = () => (process.env.APP_URL || 'http://localhost:5000').replace(/\/$/, '');

// Sender display name + Reply-To for an organization's outbound mail —
// available on every plan (unlike the Pro-only logo/colour branding below).
// facility.supportEmail is the org's own notification address, editable by
// any admin from Facility profile → Contact, independent of any admin's
// personal login email; contactEmail is the fallback for orgs that haven't
// set one yet.
function orgMailIdentity(org) {
  if (!org) return {};
  const name = (org.facility && org.facility.shortName) || org.name;
  const replyTo = (org.facility && org.facility.supportEmail) || org.contactEmail || undefined;
  return { fromName: name ? `${name} via WIMScare` : undefined, replyTo };
}

// Builds a nodemailer CID attachment for an organization's uploaded logo
// (Pro plan "interface customization" — see facility.logoPath). Returns
// null when the org has no logo, so callers fall back to the stock header.
function orgLogoAttachment(org) {
  const logoPath = org && org.facility && org.facility.logoPath;
  if (!logoPath) return null;
  try {
    const abs = resolveUploadPath(logoPath);
    if (!fs.existsSync(abs)) return null;
    const cid = 'orgLogo';
    return { cid, attachment: { filename: 'logo.webp', path: abs, cid } };
  } catch (err) {
    return null;
  }
}

const STOCK_LOGO_PATH = path.join(__dirname, '..', 'public', 'assets', 'logo.png');

function stockLogoAttachment() {
  const cid = 'wimscareLogo';
  return { cid, attachment: { filename: 'logo.png', path: STOCK_LOGO_PATH, cid } };
}

// An organization's uploaded logo when it has one (Pro plan), otherwise the
// stock WIMScare mark — either way, a CID attachment ready for send().
function resolveLogo(org) {
  return orgLogoAttachment(org) || stockLogoAttachment();
}

async function sendActivationEmail(user, org, rawToken) {
  const url = `${appUrl()}/activate.html?token=${rawToken}&email=${encodeURIComponent(user.email)}&org=${org ? org._id : ''}`;
  const logo = resolveLogo(org);
  await send({
    to: user.email,
    subject: `Activate your ${org ? org.name : 'WIMScare'} account`,
    html: layout({
      title: 'Welcome to WIMScare',
      bodyHtml: `<p>Hi ${user.firstName},</p><p>An account has been created for you${org ? ` in <strong>${org.name}</strong>` : ''}. Click the button below to set your password and activate your account. The link expires in 72 hours.</p>`,
      ctaLabel: 'Activate account',
      ctaUrl: url,
      logoCid: logo.cid,
    }),
    attachments: [logo.attachment],
    ...orgMailIdentity(org),
  });
  return url;
}

async function sendInvitationEmail(invite, org, rawToken) {
  const url = `${appUrl()}/register.html?invite=${rawToken}&org=${org._id}`;
  const logo = resolveLogo(org);
  await send({
    to: invite.email,
    subject: `You are invited to join ${org.name} on WIMScare`,
    html: layout({
      title: `Join ${org.name}`,
      bodyHtml: `<p>You have been invited to join <strong>${org.name}</strong> as <strong>${invite.role}</strong>. Click below to create your account. The invitation expires in 7 days.</p>`,
      ctaLabel: 'Accept invitation',
      ctaUrl: url,
      logoCid: logo.cid,
      brandName: orgLogoAttachment(org) ? (org.facility?.shortName || org.name) : undefined,
    }),
    attachments: [logo.attachment],
    ...orgMailIdentity(org),
  });
  return url;
}

async function sendPasswordResetEmail(user, rawToken, org) {
  const url = `${appUrl()}/reset-password.html?token=${rawToken}&email=${encodeURIComponent(user.email)}&org=${user.organizationId || ''}`;
  const logo = resolveLogo(org);
  await send({
    to: user.email,
    subject: 'Reset your WIMScare password',
    html: layout({
      title: 'Password reset',
      bodyHtml: `<p>Hi ${user.firstName},</p><p>We received a request to reset your password. Click below to choose a new one. The link expires in 1 hour. If you didn't request this, you can ignore this email.</p>`,
      ctaLabel: 'Reset password',
      ctaUrl: url,
      logoCid: logo.cid,
    }),
    attachments: [logo.attachment],
    ...orgMailIdentity(org),
  });
  return url;
}

async function sendClaimStatusEmail(user, claim, claimTypeName, org) {
  const labels = {
    submitted: 'has been received and is awaiting review',
    under_review: 'is now under review',
    approved: 'has been approved',
    rejected: 'was not approved',
    paid: 'has been paid',
  };
  const logo = resolveLogo(org);
  await send({
    to: user.email,
    subject: `Claim ${claim.claimNumber} update`,
    html: layout({
      title: `Claim ${labels[claim.status] || 'was updated'}`,
      bodyHtml: `<p>Hi ${user.firstName},</p><p>Your <strong>${claimTypeName}</strong> claim <strong>${claim.claimNumber}</strong> ${labels[claim.status] || 'was updated'}.${claim.rejectionReason ? `<br>Reason: ${claim.rejectionReason}` : ''}</p>`,
      ctaLabel: 'View claim',
      ctaUrl: `${appUrl()}/member/claim-status.html?id=${claim._id}`,
      logoCid: logo.cid,
    }),
    attachments: [logo.attachment],
    ...orgMailIdentity(org),
  });
}


async function sendClaimInfoRequestEmail(user, claim, message, org) {
  const logo = resolveLogo(org);
  await send({
    to: user.email,
    subject: `Claim ${claim.claimNumber} — more information needed`,
    html: layout({
      title: 'Additional information needed',
      bodyHtml: `<p>Hi ${user.firstName},</p><p>The reviewer of your claim <strong>${claim.claimNumber}</strong> needs more information before it can proceed:</p><blockquote style="border-left:3px solid #1d6fae; margin:16px 0; padding:4px 16px; color:#5a6b75;">${message}</blockquote><p>Please upload the requested documents or respond from your member portal.</p>`,
      ctaLabel: 'Upload documents',
      ctaUrl: `${appUrl()}/member/claim-status.html?id=${claim._id}`,
      logoCid: logo.cid,
    }),
    attachments: [logo.attachment],
    ...orgMailIdentity(org),
  });
}

async function sendContributionReceiptEmail(user, contribution, org) {
  const orgName = org ? org.name : 'WIMScare';
  const amount = `GH₵ ${Number(contribution.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  const logo = resolveLogo(org);
  await send({
    to: user.email,
    subject: `Contribution receipt ${contribution.receiptNumber}`,
    html: layout({
      title: 'Contribution recorded',
      bodyHtml: `<p>Hi ${user.firstName},</p><p>A contribution of <strong>${amount}</strong> (${contribution.method}) was recorded on your ${orgName} account. Receipt number: <strong>${contribution.receiptNumber}</strong>.</p>`,
      ctaLabel: 'View contributions',
      ctaUrl: `${appUrl()}/member/dashboard.html?panel=contributions`,
      logoCid: logo.cid,
    }),
    attachments: [logo.attachment],
    ...orgMailIdentity(org),
  });
}

module.exports = {
  send,
  sendActivationEmail,
  sendInvitationEmail,
  sendPasswordResetEmail,
  sendClaimStatusEmail,
  sendClaimInfoRequestEmail,
  sendContributionReceiptEmail,
};
