const { userHasPermission } = require("../middleware/auth");

function canAccessWarehouse(user, warehouseId) {
  if (!user) {
    return false;
  }

  if (user.role === "admin" || userHasPermission(user, "warehouses.manage")) {
    return true;
  }

  const assignedIds = user.assigned_warehouse_ids || [];
  return assignedIds.includes(Number(warehouseId));
}

function assignedWarehouseFilter(user, columnName = "warehouse_id") {
  if (!user || user.role === "admin" || userHasPermission(user, "warehouses.manage")) {
    return { clause: "", params: [] };
  }

  const assignedIds = user.assigned_warehouse_ids || [];
  if (assignedIds.length === 0) {
    return { clause: ` AND 1 = 0`, params: [] };
  }

  return {
    clause: ` AND ${columnName} IN (${assignedIds.map(() => "?").join(",")})`,
    params: assignedIds,
  };
}

module.exports = {
  canAccessWarehouse,
  assignedWarehouseFilter,
};
