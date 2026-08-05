const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { hasPermission } = require('../utils/permissions');

const COOKIE_NAME = process.env.COOKIE_NAME || 'wims_token';

function signToken(user) {
  // organizationId may arrive populated (a full Organization doc, e.g. from
  // the login/2FA flows that fetch org name+status alongside the user) —
  // its real id then lives at ._id, not on the subdocument itself.
  const orgRef = user.organizationId;
  const orgId = orgRef && orgRef._id ? orgRef._id : orgRef;
  return jwt.sign(
    {
      sub: user._id.toString(),
      org: orgId ? orgId.toString() : null,
      role: user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// Short-lived token that carries a user's identity between the password
// step and the OTP step of a 2FA login, without issuing the real session
// cookie until the code is verified. Never set as a cookie — returned to
// the client in the JSON body and round-tripped in the verify/resend calls.
function signChallengeToken(user) {
  return jwt.sign({ sub: user._id.toString(), purpose: 'login_otp' }, process.env.JWT_SECRET, { expiresIn: '10m' });
}

function verifyChallengeToken(token) {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return payload.purpose === 'login_otp' ? payload : null;
  } catch {
    return null;
  }
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    // No maxAge: a session cookie, so closing the browser ends the session.
    // Closing a single *tab* is handled client-side by the per-tab marker in
    // public/js/app.js — the browser gives no server-side signal for that.
    // The JWT's own expiry (JWT_EXPIRES_IN) still caps the token's lifetime.
    path: '/',
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// Org status lookup (maintenance mode + archived/deleted) with a short TTL
// cache so protect() doesn't add an Organization query to every request.
// Callers clear the entry on toggle/archive for an instant effect — this is
// what makes an "organization deletion" actually lock out sessions that are
// already logged in, not just block future logins.
const orgStatusCache = new Map(); // orgId -> { maintenance, archived, at }
const ORG_STATUS_TTL_MS = 30 * 1000;

async function getOrgStatus(orgId) {
  if (!orgId) return { maintenance: false, archived: false };
  const key = String(orgId);
  const hit = orgStatusCache.get(key);
  if (hit && Date.now() - hit.at < ORG_STATUS_TTL_MS) return hit;
  const Organization = require('../models/Organization');
  const org = await Organization.findById(orgId).select('status systemSettings.maintenanceMode').lean();
  const result = {
    maintenance: !!(org && org.systemSettings && org.systemSettings.maintenanceMode),
    archived: !!(org && org.status === 'archived'),
    at: Date.now(),
  };
  orgStatusCache.set(key, result);
  return result;
}

function clearMaintenanceCache(orgId) {
  orgStatusCache.delete(String(orgId));
}

// Requires a valid JWT cookie. Loads the user and pins req.orgId for tenant scoping.
async function protect(req, res, next) {
  try {
    const token = req.cookies[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.sub);
    if (!user || user.status !== 'active') {
      return res.status(401).json({ error: 'Account is not active' });
    }

    req.user = user;
    // Superadmin may act on behalf of an organization via the X-Org-Id header
    // (developer portal). Everyone else is locked to their own organization.
    if (user.role === 'superadmin') {
      req.orgId = req.get('X-Org-Id') || null;
    } else {
      req.orgId = user.organizationId.toString();
    }

    if (req.orgId) {
      const orgStatus = await getOrgStatus(req.orgId);
      // A deleted (archived) organization locks out everyone but the
      // superadmin, immediately — including sessions already signed in.
      if (user.role !== 'superadmin' && orgStatus.archived) {
        return res.status(403).json({ error: 'This organization has been deleted', archived: true });
      }
      // Maintenance mode: only administrators (and superadmin) may work while
      // it is on — everyone else gets a 503 until it's switched off.
      if (!['admin', 'superadmin'].includes(user.role) && orgStatus.maintenance) {
        return res.status(503).json({ error: 'The system is under maintenance — please try again later', maintenance: true });
      }
    }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired, please sign in again' });
  }
}

// Role gate. Superadmin passes every gate.
function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.role === 'superadmin' || roles.includes(req.user.role)) return next();
    return res.status(403).json({ error: 'You do not have permission to perform this action' });
  };
}

// Permission gate — role defaults + any explicit per-user grants (see
// utils/permissions.js). admin/superadmin always pass.
function requirePermission(key) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (hasPermission(req.user, key)) return next();
    return res.status(403).json({ error: 'You do not have permission to perform this action' });
  };
}

// License-plan gate — blocks routes whose module isn't included in the
// organization's plan (see utils/plans.js). Superadmin always passes.
// Loaded lazily to avoid a require cycle (plans → License model → mongoose).
function requireFeature(key) {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
      if (req.user.role === 'superadmin') return next();
      const { currentLicense, effectiveFeatures, planLabel } = require('../utils/plans');
      const license = await currentLicense(req.orgId);
      if (effectiveFeatures(license)[key]) return next();
      return res.status(403).json({
        error: `This feature is not included in your ${planLabel(license ? license.plan : 'free')} plan — ask your provider about upgrading`,
        upgradeRequired: true,
        feature: key,
      });
    } catch (err) {
      next(err);
    }
  };
}

function requireSuperadmin(req, res, next) {
  if (req.user && req.user.role === 'superadmin') return next();
  return res.status(403).json({ error: 'Developer portal access only' });
}

// Guarantees an organization context exists for tenant-scoped routes.
function requireOrg(req, res, next) {
  if (!req.orgId) {
    return res.status(400).json({ error: 'Organization context required (superadmin: pass X-Org-Id header)' });
  }
  next();
}

// Helper: merge the tenant filter into any query object. Use everywhere.
function orgFilter(req, extra = {}) {
  return { organizationId: req.orgId, ...extra };
}

module.exports = {
  COOKIE_NAME,
  signToken,
  signChallengeToken,
  verifyChallengeToken,
  setAuthCookie,
  clearAuthCookie,
  protect,
  requireRoles,
  requirePermission,
  requireFeature,
  requireSuperadmin,
  requireOrg,
  orgFilter,
  clearMaintenanceCache,
};
