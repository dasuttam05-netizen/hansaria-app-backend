const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const DB_PATH = path.join(__dirname, "..", "database.sqlite");
const KNOWN_ROLES = new Set(["admin", "manager", "staff", "viewer"]);

const ROLE_DEFAULT_PERMISSIONS = {
  admin: ["all"],
  manager: [
    "dashboard.view",
    "employees.view",
    "employees.edit.non_admin",
    "companies.manage",
    "companyAccounts.manage",
    "locations.manage",
    "warehouses.manage",
    "products.manage",
    "inward.view",
    "inward.create",
    "inward.edit",
    "inward.delete",
    "outward.view",
    "outward.create",
    "outward.edit",
    "outward.delete",
    "adjustment.manage",
    "settlement.view",
    "expense.entry",
    "expense.view",
    "expense.create",
    "expense.edit",
    "expense.delete",
    "expense.postedInward",
    "expense.palti",
    "expense.selfLoading",
    "expense.localSale",
    "expense.pending",
    "cash.view",
    "cash.create",
    "cash.edit",
    "cash.delete",
    "transport.manage",
    "report.inward",
    "report.erp",
    "report.partyLedger",
    "report.partyStock",
    "report.warehouseRentLedger",
    "report.warehouseRentMonthEnd",
    "report.outwardSettlement",
    "report.expense",
    "report.paltiLorryAdjustment",
    "report.cash",
  ],
  staff: [
    "dashboard.view",
    "inward.view",
    "inward.create",
    "outward.view",
    "outward.create",
    "adjustment.manage",
    "settlement.view",
    "report.inward",
    "report.outwardSettlement",
  ],
  viewer: ["dashboard.view", "report.inward"],
};

function normalizeRole(role = "staff") {
  const normalized = String(role || "").trim().toLowerCase();
  return KNOWN_ROLES.has(normalized) ? normalized : "staff";
}

function sanitizePermissionList(rawPermissions = []) {
  const list = Array.isArray(rawPermissions)
    ? rawPermissions
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [];

  const unique = [...new Set(list)];
  if (unique.includes("all")) {
    return ["all"];
  }
  return unique;
}

function parsePermissionList(rawPermissions) {
  if (rawPermissions == null || rawPermissions === "") {
    return [];
  }

  if (Array.isArray(rawPermissions)) {
    return sanitizePermissionList(rawPermissions);
  }

  try {
    const parsed = JSON.parse(String(rawPermissions));
    if (Array.isArray(parsed)) {
      return sanitizePermissionList(parsed);
    }
  } catch (error) {
    const commaSeparated = String(rawPermissions)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return sanitizePermissionList(commaSeparated);
  }

  return [];
}

function allAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function runAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function closeAsync(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function normalizeEmployeeRow(row) {
  const username = String(row.username || "").trim().toLowerCase();
  const parsedPermissions = parsePermissionList(row.permissions);

  let role = normalizeRole(row.role || "staff");
  if (username === "admin") {
    role = "admin";
  }

  const permissions = (() => {
    if (role === "admin") return ["all"];
    if (parsedPermissions.includes("all")) return ["all"];
    if (parsedPermissions.length > 0) return parsedPermissions;
    return ROLE_DEFAULT_PERMISSIONS[role] || ROLE_DEFAULT_PERMISSIONS.staff;
  })();

  return {
    role,
    permissions: JSON.stringify(permissions),
  };
}

function normalizeRoleRow(row) {
  const rawName = String(row.name || "").trim();
  const name = rawName || `role_${row.id}`;
  const parsedPermissions = parsePermissionList(row.permissions);
  const isAdmin = Number(row.is_admin) === 1 || parsedPermissions.includes("all") || name.toLowerCase() === "admin";
  const permissions = isAdmin ? ["all"] : parsedPermissions;

  return {
    name,
    permissions: JSON.stringify(permissions),
    is_admin: isAdmin ? 1 : 0,
  };
}

async function main() {
  const db = new sqlite3.Database(DB_PATH);
  const summary = {
    employeesUpdated: 0,
    rolesUpdated: 0,
    employeeInvalidRoleAfter: 0,
    employeeBlankRoleAfter: 0,
    roleBlankNameAfter: 0,
  };

  try {
    console.log(`[access-normalize] DB: ${DB_PATH}`);
    await runAsync(db, "BEGIN IMMEDIATE TRANSACTION");

    const employees = await allAsync(
      db,
      "SELECT id, username, role, permissions FROM employees ORDER BY id ASC"
    );

    for (const row of employees) {
      const next = normalizeEmployeeRow(row);
      const currentRole = String(row.role || "");
      const currentPermissions = String(row.permissions || "");

      if (currentRole !== next.role || currentPermissions !== next.permissions) {
        await runAsync(
          db,
          "UPDATE employees SET role = ?, permissions = ? WHERE id = ?",
          [next.role, next.permissions, row.id]
        );
        summary.employeesUpdated += 1;
      }
    }

    const roles = await allAsync(
      db,
      "SELECT id, name, permissions, is_admin FROM roles ORDER BY id ASC"
    );

    for (const row of roles) {
      const next = normalizeRoleRow(row);
      const currentName = String(row.name || "");
      const currentPermissions = String(row.permissions || "");
      const currentIsAdmin = Number(row.is_admin) === 1 ? 1 : 0;

      if (
        currentName !== next.name ||
        currentPermissions !== next.permissions ||
        currentIsAdmin !== next.is_admin
      ) {
        await runAsync(
          db,
          "UPDATE roles SET name = ?, permissions = ?, is_admin = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [next.name, next.permissions, next.is_admin, row.id]
        );
        summary.rolesUpdated += 1;
      }
    }

    await runAsync(db, "COMMIT");

    const invalidRoleRows = await allAsync(
      db,
      `
      SELECT id FROM employees
      WHERE role IS NULL
        OR TRIM(role) = ''
        OR LOWER(TRIM(role)) NOT IN ('admin','manager','staff','viewer')
      `
    );
    summary.employeeInvalidRoleAfter = invalidRoleRows.length;

    const blankRoleRows = await allAsync(
      db,
      "SELECT id FROM employees WHERE role IS NULL OR TRIM(role) = ''"
    );
    summary.employeeBlankRoleAfter = blankRoleRows.length;

    const blankRoleNameRows = await allAsync(
      db,
      "SELECT id FROM roles WHERE name IS NULL OR TRIM(name) = ''"
    );
    summary.roleBlankNameAfter = blankRoleNameRows.length;

    console.log("[access-normalize] Completed");
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    try {
      await runAsync(db, "ROLLBACK");
    } catch (rollbackError) {
      console.error("[access-normalize] Rollback failed:", rollbackError.message);
    }
    console.error("[access-normalize] Failed:", error.message);
    process.exitCode = 1;
  } finally {
    await closeAsync(db);
  }
}

main();
