function buildWarehouseStockSummary(rows, getAvailableQty) {
  const map = new Map();
  rows.forEach((row) => {
    const key = `${row.warehouse_name || row.warehouse_id || "Unknown"}::${row.company_name || row.company || "Unknown"}::${row.location_name || row.location_id || "Unknown"}`;
    const stock = getAvailableQty(row);
    if (!map.has(key)) {
      map.set(key, {
        warehouse: row.warehouse_name || "Unknown",
        party: row.company_name || row.company || "Unknown",
        location: row.location_name || "Unknown",
        stock: Number(stock || 0),
      });
    }
    if (typeof stock === "number") map.get(key).stock += stock;
  });
  return [...map.values()];
}

function buildTotalStock(rows, getAvailableQty) {
  return Number(rows.reduce((sum, row) => sum + getAvailableQty(row), 0).toFixed(4));
}

module.exports = {
  buildWarehouseStockSummary,
  buildTotalStock,
};
