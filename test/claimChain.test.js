const test = require('node:test');
const assert = require('node:assert/strict');
const { chainSteps, STEP_ROLE } = require('../routes/claims');

test('default chain is the 3-step supervisor → accountant → admin', () => {
  assert.deepEqual(chainSteps('supervisor_admin'), ['supervisor', 'accountant', 'admin']);
  assert.deepEqual(chainSteps(undefined), ['supervisor', 'accountant', 'admin']);
});

test('short chains: admin-only and committee', () => {
  assert.deepEqual(chainSteps('admin'), ['admin']);
  assert.deepEqual(chainSteps('committee'), ['committee']);
});

test('every step maps to an owning role; committee is decided by an admin', () => {
  for (const steps of [chainSteps('admin'), chainSteps('committee'), chainSteps('supervisor_admin')]) {
    for (const step of steps) assert.ok(STEP_ROLE[step], `role for ${step}`);
  }
  assert.equal(STEP_ROLE.committee, 'admin');
});

test('the first pending step decides whose turn it is', () => {
  const approvals = [
    { step: 'supervisor', decision: 'approved' },
    { step: 'accountant', decision: 'pending' },
    { step: 'admin', decision: 'pending' },
  ];
  const current = approvals.find((a) => a.decision === 'pending');
  assert.equal(STEP_ROLE[current.step], 'accountant');
});
