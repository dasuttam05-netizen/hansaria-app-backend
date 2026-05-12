const jwt = require("jsonwebtoken");

const db = require("../db");

const { Employee, Warehouse } = require("../mongo");

const SECRET =
  process.env.JWT_SECRET ||
  "supersecret";

const REPORT_PERMISSION_KEYS = [
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
];

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
    ...REPORT_PERMISSION_KEYS,
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

  viewer: [
    "dashboard.view",
    "report.inward",
  ],
};

const LEGACY_PERMISSION_MAP = {
  "employees.create": ["employees.manage"],
  "employees.edit": ["employees.manage"],
  "employees.delete": ["employees.manage"],
  "inward.view": ["inward.manage"],
  "inward.create": ["inward.manage"],
  "inward.edit": ["inward.manage"],
  "inward.delete": ["inward.manage"],
  "outward.view": ["outward.manage"],
  "outward.create": ["outward.manage"],
  "outward.edit": ["outward.manage"],
  "outward.delete": ["outward.manage"],
  "expense.view": ["expense.manage", "expense.entry"],
  "expense.create": ["expense.manage", "expense.entry"],
  "expense.edit": ["expense.manage"],
  "expense.delete": ["expense.manage"],
  "expense.entry": ["expense.view", "expense.manage"],
  "expense.postedInward": ["expense.view", "inward.view"],
  "expense.palti": ["expense.view", "report.expense"],
  "expense.selfLoading": ["expense.view", "report.expense", "outward.view"],
  "expense.localSale": ["expense.view", "report.expense"],
  "expense.pending": ["cash.view"],
  "settlement.view": ["reports.view"],
  "report.inward": ["reports.view"],
  "report.erp": ["reports.view"],
  "report.partyLedger": ["reports.view"],
  "report.partyStock": ["reports.view"],
  "report.warehouseRentLedger": ["reports.view"],
  "report.warehouseRentMonthEnd": ["reports.view"],
  "report.outwardSettlement": ["reports.view"],
  "report.expense": ["reports.view"],
  "report.paltiLorryAdjustment": ["report.expense", "reports.view"],
  "report.cash": ["reports.view"],
  "warehouses.view": ["warehouses.manage"],
};

function normalizeRole(
  role = "staff"
) {

  const normalized =
    String(role || "")
      .trim()
      .toLowerCase();

  return ROLE_DEFAULT_PERMISSIONS[
    normalized
  ]
    ? normalized
    : "staff";
}

function parsePermissions(
  permissions = [],
  role = "staff"
) {

  if (
    role === "admin"
  ) {
    return ["all"];
  }

  if (Array.isArray(permissions)) {
    return permissions
      .map((item) =>
        String(item || "")
          .trim()
      )
      .filter((item) => item);
  }

  if (typeof permissions === "string") {
    const raw = permissions.trim();
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) =>
            String(item || "")
              .trim()
          )
          .filter((item) => item);
      }
    } catch (_err) {
      // Fall back to comma-separated parsing.
    }

    return raw
      .split(",")
      .map((item) =>
        String(item || "")
          .trim()
      )
      .filter((item) => item);
  }

  return [];
}

async function loadAssignedWarehouseIds(userId) {
  if (!userId) return [];

  const warehouses = await Warehouse.find(
    { employee_id: userId },
    { _id: 1 }
  );

  return (warehouses || [])
    .map((row) =>
      row?._id
        ? String(row._id)
        : ""
    )
    .filter((item) => item);
}

function buildUserPayload(
  user
) {

  return {
    id:
      user._id ||
      user.id,

    username:
      user.username,

    name: user.name,

    role:
      normalizeRole(
        user.role
      ),

    permissions:
      parsePermissions(
        user.permissions,
        user.role
      ),

    location_id:
      user.location_id ||
      null,
  };
}

function userHasPermission(
  user,
  permission
) {

  if (
    !user ||
    !permission
  ) {
    return false;
  }

  const permissions =
    parsePermissions(
      user.permissions,
      user.role
    );

  const legacyMatches =
    (LEGACY_PERMISSION_MAP[permission] || [])
      .some((item) =>
        permissions.includes(item)
      );

  return (
    permissions.includes(
      "all"
    ) ||
    permissions.includes(
      permission
    ) ||
    legacyMatches
  );
}

async function buildAuthenticatedUserPayload(user) {
  const payload = buildUserPayload(user);
  payload.assigned_warehouse_ids =
    await loadAssignedWarehouseIds(payload.id);
  return payload;
}

function isAdminUser(
  user
) {

  return (
    normalizeRole(
      user?.role
    ) === "admin"
  );
}

function signUserToken(
  user
) {

  return jwt.sign(
    buildUserPayload(
      user
    ),
    SECRET,
    {
      expiresIn: "8h",
    }
  );
}

async function authenticate(
  req,
  res,
  next
) {

  try {

    const authHeader =
      req.headers
        .authorization || "";

    const token =
      authHeader.startsWith(
        "Bearer "
      )
        ? authHeader.slice(
            7
          )
        : authHeader;

    if (!token) {

      return res.status(401)
        .json({
          error:
            "Authentication required",
        });
    }

    const decoded =
      jwt.verify(
        token,
        SECRET
      );

    if (
      !decoded?.id
    ) {

      return res.status(401)
        .json({
          error:
            "Invalid token",
        });
    }

    const user =
      await Employee.findById(
        decoded.id
      );

    if (!user) {

      return res.status(401)
        .json({
          error:
            "User account not found",
        });
    }

    req.user =
      await buildAuthenticatedUserPayload(
        user
      );

    next();

  } catch (err) {

    console.error(
      "AUTH ERROR:",
      err.message
    );

    return res.status(401)
      .json({
        error:
          "Invalid or expired token",
      });
  }
}

function authorize(
  permissions = []
) {

  const required =
    Array.isArray(
      permissions
    )
      ? permissions
      : [permissions];

  return (
    req,
    res,
    next
  ) => {

    if (!req.user) {

      return res.status(401)
        .json({
          error:
            "Authentication required",
        });
    }

    const allowed =
      required.every(
        (
          permission
        ) =>
          userHasPermission(
            req.user,
            permission
          )
      );

    if (!allowed) {

      return res.status(403)
        .json({
          error:
            "Permission denied",
        });
    }

    next();
  };
}

module.exports = {
  SECRET,

  normalizeRole,

  parsePermissions,

  buildUserPayload,

  userHasPermission,

  isAdminUser,

  signUserToken,

  authenticate,

  authorize,
};
