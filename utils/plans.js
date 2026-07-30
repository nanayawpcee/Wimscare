const License = require('../models/License');

// Organization license plans. Every plan carries a default feature set and
// capacity; the superadmin can still hand-toggle individual feature flags on
// a license, which are ADDITIVE on top of the plan defaults (to take a
// feature away, move the organization to a lower plan).
//
// - free:     the entry tier — contributions and claims only, no expiry.
// - standard: adds the accounting workspace and reports.
// - pro:      everything, including interface customization (custom
//             branding) and audit trail.
//
// Plans issued before this catalogue existed (trial/professional/
// enterprise/premium) are grandfathered with every feature enabled so
// nothing an existing organization relies on disappears.
const PLANS = {
  free: {
    label: 'Free',
    maxUsers: 3,
    maxMembers: 100,
    defaultMonths: 120, // effectively no expiry
    features: ['claimsManagement', 'contributionsManagement'],
  },
  standard: {
    label: 'Standard',
    maxUsers: 15,
    maxMembers: 500,
    defaultMonths: 12,
    features: ['claimsManagement', 'contributionsManagement', 'accountsManagement', 'reports'],
  },
  pro: {
    label: 'Pro',
    maxUsers: 100,
    maxMembers: 5000,
    defaultMonths: 12,
    features: License.FEATURE_KEYS.slice(),
  },
};

const LEGACY_PLANS = ['trial', 'professional', 'enterprise', 'premium'];

function planLabel(plan) {
  if (PLANS[plan]) return PLANS[plan].label;
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : '—';
}

// Effective feature map for a license: plan defaults OR-ed with any flags
// the superadmin enabled explicitly. A missing/invalid license behaves like
// the free plan.
function effectiveFeatures(license) {
  const out = {};
  const plan = license && license.plan;
  const grandfathered = LEGACY_PLANS.includes(plan);
  const defaults = PLANS[plan] ? PLANS[plan].features : PLANS.free.features;
  for (const key of License.FEATURE_KEYS) {
    out[key] =
      grandfathered ||
      defaults.includes(key) ||
      !!(license && license.features && license.features[key]);
  }
  return out;
}

// The organization's current license: the most recently expiring one that
// is active (or pending activation) and not past its expiry.
async function currentLicense(organizationId) {
  if (!organizationId) return null;
  return License.findOne({
    organizationId,
    status: { $in: ['active', 'pending'] },
    expiresAt: { $gt: new Date() },
  }).sort({ expiresAt: -1 });
}

// { name, label, features } summary for API responses.
async function planSummary(organizationId) {
  const license = await currentLicense(organizationId);
  const name = license ? license.plan : 'free';
  return {
    name,
    label: planLabel(name),
    features: effectiveFeatures(license),
    expiresAt: license ? license.expiresAt : null,
  };
}

const STAFF_ROLES = ['admin', 'supervisor', 'accountant'];

// Seat-cap check for adding people to an organization. Staff roles consume
// maxUsers seats; members consume maxMembers. Existing accounts (any
// status) and still-open invitations both hold a seat, so a flood of
// invites can't oversubscribe the plan. No valid license = free-plan caps.
async function checkSeat(organizationId, role, adding = 1) {
  const User = require('../models/User');
  const Invitation = require('../models/Invitation');
  const license = await currentLicense(organizationId);
  const isStaff = STAFF_ROLES.includes(role);
  const limit = license
    ? (isStaff ? license.maxUsers ?? PLANS.free.maxUsers : license.maxMembers ?? PLANS.free.maxMembers)
    : (isStaff ? PLANS.free.maxUsers : PLANS.free.maxMembers);
  const roleFilter = isStaff ? { $in: STAFF_ROLES } : 'user';
  const [users, invites] = await Promise.all([
    User.countDocuments({ organizationId, role: roleFilter }),
    Invitation.countDocuments({ organizationId, role: roleFilter, status: 'sent', expiresAt: { $gt: new Date() } }),
  ]);
  const used = users + invites;
  if (used + adding > limit) {
    return {
      ok: false,
      used,
      limit,
      error: `${isStaff ? 'Staff seat' : 'Member'} limit reached (${used}/${limit} used, incl. open invitations) — upgrade your plan to add more ${isStaff ? 'staff' : 'members'}`,
    };
  }
  return { ok: true, used, limit };
}

module.exports = { PLANS, LEGACY_PLANS, STAFF_ROLES, planLabel, effectiveFeatures, currentLicense, planSummary, checkSeat };
