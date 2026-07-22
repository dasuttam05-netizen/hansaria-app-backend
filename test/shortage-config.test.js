const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateShortageQty, getAutoShortageRate, resolveShortageRate } = require('../routes/shortageHelper');

test('default shortage remains automatic for month slabs', () => {
  const qty = calculateShortageQty(100, 1);
  assert.equal(qty, 2);
});

test('automatic shortage scales by day slab', () => {
  assert.equal(getAutoShortageRate(1), 0.02);
  assert.equal(getAutoShortageRate(2), 0.04);
});

test('manual company shortage percentage overrides the default automatic rate', () => {
  const qty = calculateShortageQty(100, 2, 0.75);
  assert.equal(qty, 0.75);
});

test('resolveShortageRate returns null when manual percentage is not supplied', () => {
  assert.equal(resolveShortageRate(null), null);
});

test('zero percentage is treated as a valid manual override', () => {
  assert.equal(resolveShortageRate(0), 0);
  assert.equal(calculateShortageQty(100, 2, 0), 0);
});
