const test = require('node:test');
const assert = require('node:assert/strict');
const { monthKey, GRACE_DAYS } = require('../utils/superadminCredentials');

test('monthKey formats and rolls over correctly', () => {
  assert.equal(monthKey(new Date(2026, 6, 18)), '2026-07');
  assert.equal(monthKey(new Date(2026, 0, 1)), '2026-01');
  assert.equal(monthKey(new Date(2026, 11, 31)), '2026-12');
});

test('grace period is a small positive number of days', () => {
  assert.ok(GRACE_DAYS >= 1 && GRACE_DAYS <= 10);
});
