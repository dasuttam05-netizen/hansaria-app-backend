const { userHasPermission } = require("../middleware/auth");

function assignedWarehouseIdsForAccess(user) {
  return user?.assigned_warehouse_ids || [];
}

function canAccessWarehouse(user, warehouseId) {
  if (!user) {
    return false;
  }

  if (userHasPermission(user, "all") || userHasPermission(user, "warehouses.manage")) {
    return true;
  }

  const assignedIds = assignedWarehouseIdsForAccess(user);
  const target = String(warehouseId || "");
  return assignedIds.some((id) => String(id) === target || Number(id) === Number(warehouseId));
}

function assignedWarehouseFilter(user, columnName = "warehouse_id") {
  if (!user || userHasPermission(user, "all") || userHasPermission(user, "warehouses.manage")) {
    return { clause: "", params: [] };
  }

  const assignedIds = assignedWarehouseIdsForAccess(user);
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
