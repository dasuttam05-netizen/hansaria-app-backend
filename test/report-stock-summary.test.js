const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildWarehouseStockSummary,
  buildTotalStock,
} = require('../helpers/reportStockSummary');

const availableQty = (row) => row.remaining - (row.shortage || 0);

test('builds warehouse stock using the existing grouping and labels', () => {
  const rows = [
    { warehouse_name: 'North', company_name: 'Alpha', location_name: 'A', remaining: 10 },
    { warehouse_name: 'North', company_name: 'Alpha', location_name: 'A', remaining: 5, shortage: 1 },
    { warehouse_id: 'w2', company: 'Beta', location_id: 'l2', remaining: 4 },
  ];

  assert.deepEqual(buildWarehouseStockSummary(rows, availableQty), [
    { warehouse: 'North', party: 'Alpha', location: 'A', stock: 24 },
    { warehouse: 'Unknown', party: 'Beta', location: 'Unknown', stock: 8 },
  ]);
});

test('rounds the overall stock total to four decimal places', () => {
  const rows = [{ remaining: 1.23456 }, { remaining: 2.34567 }];

  assert.equal(buildTotalStock(rows, availableQty), 3.5802);
});
