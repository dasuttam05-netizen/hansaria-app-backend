require("dotenv").config();

const {
  mongoose,
  Employee,
  Role,
} = require("../db-mongodb");

const {
  normalizeRole,
  parsePermissions,
} = require("../middleware/auth");

function sanitizePermissionList(rawPermissions = []) {
  const list = Array.isArray(rawPermissions)
    ? rawPermissions
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [];

  const unique = [...new Set(list)];
  return unique.includes("all") ? ["all"] : unique;
}

function roleFromEmployee(row) {
  const username = String(row.username || "").trim().toLowerCase();

  if (username === "admin") {
    return "admin";
  }

  return normalizeRole(row.role || "staff");
}

function normalizeEmployeeRow(row) {
  const role = roleFromEmployee(row);
  const permissions = role === "admin"
    ? ["all"]
    : sanitizePermissionList(parsePermissions(row.permissions, role));

  return {
    role,
    permissions,
  };
}

function normalizeRoleRow(row) {
  const rawName = String(row.name || "").trim();
  const name = rawName || `role_${String(row._id)}`;
  const parsedPermissions = sanitizePermissionList(
    parsePermissions(row.permissions, name)
  );
  const isAdmin =
    Number(row.is_admin) === 1 ||
    parsedPermissions.includes("all") ||
    name.toLowerCase() === "admin";

  return {
    name,
    permissions: isAdmin ? ["all"] : parsedPermissions,
    is_admin: isAdmin ? 1 : 0,
  };
}

function arraysEqual(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

async function waitForMongoConnection(timeoutMs = 15000) {
  if (mongoose.connection.readyState === 1) return;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("MongoDB connection timeout"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      mongoose.connection.off("connected", onConnected);
      mongoose.connection.off("error", onError);
    }

    function onConnected() {
      cleanup();
      resolve();
    }

    function onError(err) {
      cleanup();
      reject(err || new Error("MongoDB connection failed"));
    }

    mongoose.connection.on("connected", onConnected);
    mongoose.connection.on("error", onError);
  });
}

async function main() {
  const summary = {
    employeesUpdated: 0,
    rolesUpdated: 0,
    employeeInvalidRoleAfter: 0,
    employeeBlankRoleAfter: 0,
    roleBlankNameAfter: 0,
  };

  await waitForMongoConnection();
  console.log(
    `[access-normalize] MongoDB: ${mongoose.connection.db.databaseName}`
  );

  const employees = await Employee.find(
    {},
    { username: 1, role: 1, permissions: 1 }
  ).lean();

  for (const row of employees) {
    const next = normalizeEmployeeRow(row);
    const currentRole = String(row.role || "");
    const currentPermissions = sanitizePermissionList(row.permissions);

    if (
      currentRole !== next.role ||
      !arraysEqual(currentPermissions, next.permissions)
    ) {
      await Employee.updateOne(
        { _id: row._id },
        {
          $set: {
            role: next.role,
            permissions: next.permissions,
            updated_at: new Date(),
          },
        }
      );
      summary.employeesUpdated += 1;
    }
  }

  const roles = await Role.find(
    {},
    { name: 1, permissions: 1, is_admin: 1 }
  ).lean();

  for (const row of roles) {
    const next = normalizeRoleRow(row);
    const currentName = String(row.name || "");
    const currentPermissions = sanitizePermissionList(row.permissions);
    const currentIsAdmin = Number(row.is_admin) === 1 ? 1 : 0;

    if (
      currentName !== next.name ||
      !arraysEqual(currentPermissions, next.permissions) ||
      currentIsAdmin !== next.is_admin
    ) {
      await Role.updateOne(
        { _id: row._id },
        {
          $set: {
            name: next.name,
            permissions: next.permissions,
            is_admin: next.is_admin,
            updated_at: new Date(),
          },
        }
      );
      summary.rolesUpdated += 1;
    }
  }

  summary.employeeBlankRoleAfter = await Employee.countDocuments({
    $or: [
      { role: { $exists: false } },
      { role: null },
      { role: "" },
    ],
  });

  summary.employeeInvalidRoleAfter = summary.employeeBlankRoleAfter;
  summary.roleBlankNameAfter = await Role.countDocuments({
    $or: [
      { name: { $exists: false } },
      { name: null },
      { name: "" },
    ],
  });

  console.log("[access-normalize] Completed");
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error("[access-normalize] Failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
  });
