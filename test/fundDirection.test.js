const test = require('node:test');
const assert = require('node:assert/strict');
const { fundDirection } = require('../routes/fundAccounts');

// The fund-account balance rule: source type decides the cash direction for
// system-generated ledger legs; only manual entries trust `direction`.
test('contributions always flow in', () => {
  assert.equal(fundDirection({ sourceType: 'contribution', direction: 'debit' }), 'in');
  assert.equal(fundDirection({ sourceType: 'contribution', direction: 'credit' }), 'in');
});

test('claims, reversals and expenses always flow out', () => {
  assert.equal(fundDirection({ sourceType: 'claim', direction: 'credit' }), 'out');
  assert.equal(fundDirection({ sourceType: 'reversal', direction: 'credit' }), 'out');
  assert.equal(fundDirection({ sourceType: 'claim', direction: 'debit' }), 'out');
  // Office-expense payouts credit the cash account but must read as money OUT.
  assert.equal(fundDirection({ sourceType: 'expense', direction: 'credit' }), 'out');
});

test('manual entries trust the debit/credit direction', () => {
  assert.equal(fundDirection({ sourceType: 'manual', direction: 'credit' }), 'in');
  assert.equal(fundDirection({ sourceType: 'manual', direction: 'debit' }), 'out');
  assert.equal(fundDirection({ direction: 'credit' }), 'in');
});
