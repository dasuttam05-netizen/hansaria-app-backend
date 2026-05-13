const { userHasPermission } = require("../middleware/auth");

function assignedWarehouseIdsForSql(user) {
  const sqliteIds = user?.assigned_sqlite_warehouse_ids || [];
  return sqliteIds.length > 0 ? sqliteIds : user?.assigned_warehouse_ids || [];
}

function canAccessWarehouse(user, warehouseId) {
  if (!user) {
    return false;
  }

  if (user.role === "admin" || userHasPermission(user, "warehouses.manage")) {
    return true;
  }

  const assignedIds = assignedWarehouseIdsForSql(user);
  const target = String(warehouseId || "");
  return assignedIds.some((id) => String(id) === target || Number(id) === Number(warehouseId));
}

function assignedWarehouseFilter(user, columnName = "warehouse_id") {
  if (!user || user.role === "admin" || userHasPermission(user, "warehouses.manage")) {
    return { clause: "", params: [] };
  }

  const assignedIds = assignedWarehouseIdsForSql(user);
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
