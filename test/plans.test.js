const test = require('node:test');
const assert = require('node:assert/strict');
const { PLANS, LEGACY_PLANS, planLabel, effectiveFeatures } = require('../utils/plans');
const License = require('../models/License');

test('plan catalogue has the three current tiers with sane caps', () => {
  assert.deepEqual(Object.keys(PLANS), ['free', 'standard', 'pro']);
  assert.ok(PLANS.free.maxUsers < PLANS.standard.maxUsers);
  assert.ok(PLANS.standard.maxUsers < PLANS.pro.maxUsers);
  assert.ok(PLANS.free.maxMembers < PLANS.standard.maxMembers);
  assert.equal(PLANS.pro.features.length, License.FEATURE_KEYS.length, 'pro includes every feature');
});

test('planLabel maps tiers and falls back to capitalized name', () => {
  assert.equal(planLabel('free'), 'Free');
  assert.equal(planLabel('pro'), 'Pro');
  assert.equal(planLabel('trial'), 'Trial');
  assert.equal(planLabel(null), '—');
});

test('effectiveFeatures: free plan and missing license behave identically', () => {
  const none = effectiveFeatures(null);
  const free = effectiveFeatures({ plan: 'free', features: {} });
  assert.deepEqual(none, free);
  assert.equal(none.claimsManagement, true);
  assert.equal(none.contributionsManagement, true);
  assert.equal(none.reports, false);
  assert.equal(none.customBranding, false);
});

test('effectiveFeatures: standard adds accounts + reports, not branding', () => {
  const f = effectiveFeatures({ plan: 'standard', features: {} });
  assert.equal(f.accountsManagement, true);
  assert.equal(f.reports, true);
  assert.equal(f.auditTrail, false);
  assert.equal(f.customBranding, false);
});

test('effectiveFeatures: pro has everything on', () => {
  const f = effectiveFeatures({ plan: 'pro', features: {} });
  for (const key of License.FEATURE_KEYS) assert.equal(f[key], true, key);
});

test('effectiveFeatures: explicit license flags are additive on lower plans', () => {
  const f = effectiveFeatures({ plan: 'free', features: { reports: true } });
  assert.equal(f.reports, true, 'superadmin-granted extra');
  assert.equal(f.accountsManagement, false, 'others stay off');
});

test('effectiveFeatures: legacy plans are grandfathered with all features', () => {
  for (const plan of LEGACY_PLANS) {
    const f = effectiveFeatures({ plan, features: {} });
    for (const key of License.FEATURE_KEYS) assert.equal(f[key], true, `${plan}:${key}`);
  }
});
