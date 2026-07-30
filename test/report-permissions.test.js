const test = require('node:test');
const assert = require('node:assert/strict');
const { userHasPermission } = require('../middleware/auth');

test('treats generic report.expense access as sufficient for other report routes', () => {
  const user = {
    role: 'staff',
    permissions: ['report.expense'],
  };

  assert.equal(userHasPermission(user, 'report.partyLedger'), true);
  assert.equal(userHasPermission(user, 'report.partyStock'), true);
  assert.equal(userHasPermission(user, 'report.warehouseRentLedger'), true);
  assert.equal(userHasPermission(user, 'report.warehouseRentMonthEnd'), true);
});

test('still allows explicit reports.view access', () => {
  const user = {
    role: 'staff',
    permissions: ['reports.view'],
  };

  assert.equal(userHasPermission(user, 'report.partyLedger'), true);
  assert.equal(userHasPermission(user, 'report.partyStock'), true);
});
