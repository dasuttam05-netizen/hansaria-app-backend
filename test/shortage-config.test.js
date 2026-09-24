const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateShortageQty, getAutoShortageRate, resolveShortageRate } = require('../routes/shortageHelper');

test('default shortage remains automatic for month slabs', () => {
  const qty = calculateShortageQty(100, 1);
  assert.equal(qty, 2);
});

test('automatic shortage scales by month slab', () => {
  assert.equal(getAutoShortageRate(1), 0.02);
  assert.equal(getAutoShortageRate(2), 0.04);
  assert.equal(calculateShortageQty(100, 2), 4);
  assert.equal(calculateShortageQty(100, 3), 6);
});

test('manual shortage percentage scales by month slab', () => {
  // 0.75% per slab: 2 slabs -> 1.50% on 100 qty = 1.50 qty
  const qty = calculateShortageQty(100, 2, 0.75);
  assert.equal(qty, 1.5);
});

test('manual 1 percent becomes 1%, 2%, 3%, 4% by slab', () => {
  assert.equal(calculateShortageQty(10, 1, 1), 0.1);
  assert.equal(calculateShortageQty(10, 2, 1), 0.2);
  assert.equal(calculateShortageQty(10, 3, 1), 0.3);
  assert.equal(calculateShortageQty(10, 4, 1), 0.4);
});

test('resolveShortageRate returns null when manual percentage is not supplied', () => {
  assert.equal(resolveShortageRate(null), null);
});

test('zero percentage is treated as a valid manual override', () => {
  assert.equal(resolveShortageRate(0), 0);
  assert.equal(calculateShortageQty(100, 2, 0), 0);
});
