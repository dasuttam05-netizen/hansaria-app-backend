const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDashboardList, normalizeDashboardSummary } = require('../helpers/dashboardPayload');

test('normalizes dashboard lists into arrays', () => {
  assert.deepEqual(normalizeDashboardList(undefined), []);
  assert.deepEqual(normalizeDashboardList([{ id: 1, name: 'A' }]), [{ id: 1, name: 'A' }]);
});

test('normalizes dashboard report summaries into predictable arrays', () => {
  assert.deepEqual(normalizeDashboardSummary({ summary: [{ party_name: 'Alpha' }] }), [{ party_name: 'Alpha' }]);
  assert.deepEqual(normalizeDashboardSummary([{ party_name: 'Beta' }]), [{ party_name: 'Beta' }]);
  assert.deepEqual(normalizeDashboardSummary(null), []);
});
