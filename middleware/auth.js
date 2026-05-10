const jwt = require("jsonwebtoken");

const db = require("../db");

const { Employee } = require("../mongo");

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

  if (
    Array.isArray(
      permissions
    )
  ) {
    return permissions;
  }

  return [];
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

  return (
    permissions.includes(
      "all"
    ) ||
    permissions.includes(
      permission
    )
  );
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
      buildUserPayload(
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
