const jwt = require("jsonwebtoken");

const db = require("../db");

const { mongoose, Employee, Warehouse, Location } = require("../mongo");

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

  bm: [
    "dashboard.view",
    "employees.view",
    "employees.edit.non_admin",
    "companies.view",
    "companies.create",
    "companies.edit",
    "companies.delete",
    "companyAccounts.view",
    "companyAccounts.create",
    "companyAccounts.edit",
    "companyAccounts.delete",
    "locations.view",
    "locations.create",
    "locations.edit",
    "locations.delete",
    "warehouses.view",
    "warehouses.create",
    "warehouses.edit",
    "warehouses.delete",
    "products.view",
    "products.create",
    "products.edit",
    "products.delete",
    "farmers.view",
    "farmers.create",
    "farmers.edit",
    "farmers.delete",
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
    "settlement.companyRate",
    "expense.entry",
    "expense.view",
    "expense.create",
    "expense.edit",
    "expense.delete",
    "buyerNames.view",
    "buyerNames.create",
    "buyerNames.edit",
    "buyerNames.delete",
    "consigneeNames.view",
    "consigneeNames.create",
    "consigneeNames.edit",
    "consigneeNames.delete",
    "expense.postedInward",
    "expense.palti",
    "expense.selfLoading",
    "expense.localSale",
    "expense.pending",
    "cash.pending.post",
    "cash.view",
    "cash.create",
    "cash.edit",
    "cash.delete",
    "cash.mainBook.view",
    "cash.mainBook.create",
    "cash.mainBook.edit",
    "cash.mainBook.delete",
    "cash.partiesBook.view",
    "cash.partiesBook.create",
    "cash.partiesBook.edit",
    "cash.partiesBook.delete",
    "cash.employeeBook.view",
    "cash.employeeBook.create",
    "cash.employeeBook.edit",
    "cash.employeeBook.delete",
    "warehouse.trading.view",
    "warehouse.trading.purchase.view",
    "warehouse.trading.purchase.manage",
    "warehouse.trading.sale.view",
    "warehouse.trading.sale.manage",
    "warehouse.trading.payment.view",
    "warehouse.trading.payment.manage",
    "warehouse.trading.receipt.view",
    "warehouse.trading.receipt.manage",
    "warehouse.trading.journal.view",
    "warehouse.trading.journal.manage",
    "warehouse.trading.report.sale",
    "warehouse.trading.report.purchase",
    "warehouse.trading.report.profitLoss",
    "report.inward",
    "report.erp",
    "report.partyLedger",
    "report.partyStock",
    "report.warehouseRentLedger",
    "report.warehouseRentMonthEnd",
    "report.outwardSettlement",
    "report.expense",
    "report.cash",
    "report.paltiLorryAdjustment",
    "transport.manage",
  ],
  ho: [
    "dashboard.view",
    "employees.view",
    "employees.edit.non_admin",
    "companies.view",
    "companies.create",
    "companies.edit",
    "companies.delete",
    "companyAccounts.view",
    "companyAccounts.create",
    "companyAccounts.edit",
    "companyAccounts.delete",
    "locations.view",
    "locations.create",
    "locations.edit",
    "locations.delete",
    "warehouses.view",
    "warehouses.create",
    "warehouses.edit",
    "warehouses.delete",
    "products.view",
    "products.create",
    "products.edit",
    "products.delete",
    "farmers.view",
    "farmers.create",
    "farmers.edit",
    "farmers.delete",
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
    "settlement.companyRate",
    "expense.entry",
    "expense.view",
    "expense.create",
    "expense.edit",
    "expense.delete",
    "buyerNames.view",
    "buyerNames.create",
    "buyerNames.edit",
    "buyerNames.delete",
    "consigneeNames.view",
    "consigneeNames.create",
    "consigneeNames.edit",
    "consigneeNames.delete",
    "expense.postedInward",
    "expense.palti",
    "expense.selfLoading",
    "expense.localSale",
    "expense.pending",
    "cash.pending.post",
    "cash.view",
    "cash.create",
    "cash.edit",
    "cash.delete",
    "cash.mainBook.view",
    "cash.mainBook.create",
    "cash.mainBook.edit",
    "cash.mainBook.delete",
    "cash.partiesBook.view",
    "cash.partiesBook.create",
    "cash.partiesBook.edit",
    "cash.partiesBook.delete",
    "cash.employeeBook.view",
    "cash.employeeBook.create",
    "cash.employeeBook.edit",
    "cash.employeeBook.delete",
    "warehouse.trading.view",
    "warehouse.trading.purchase.view",
    "warehouse.trading.purchase.manage",
    "warehouse.trading.sale.view",
    "warehouse.trading.sale.manage",
    "warehouse.trading.payment.view",
    "warehouse.trading.payment.manage",
    "warehouse.trading.receipt.view",
    "warehouse.trading.receipt.manage",
    "warehouse.trading.journal.view",
    "warehouse.trading.journal.manage",
    "warehouse.trading.report.sale",
    "warehouse.trading.report.purchase",
    "warehouse.trading.report.profitLoss",
    "report.inward",
    "report.erp",
    "report.partyLedger",
    "report.partyStock",
    "report.warehouseRentLedger",
    "report.warehouseRentMonthEnd",
    "report.outwardSettlement",
    "report.expense",
    "report.cash",
    "report.paltiLorryAdjustment",
    "transport.manage",
  ],

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
    "settlement.companyRate",
    "expense.entry",
    "expense.view",
    "expense.create",
    "expense.edit",
    "expense.delete",
    "buyerNames.view",
    "buyerNames.create",
    "buyerNames.edit",
    "buyerNames.delete",
    "consigneeNames.view",
    "consigneeNames.create",
    "consigneeNames.edit",
    "consigneeNames.delete",
    "expense.postedInward",
    "expense.palti",
    "expense.selfLoading",
    "expense.localSale",
    "expense.pending",
    "cash.pending.post",
    "cash.mainBook.view",
    "cash.mainBook.create",
    "cash.mainBook.edit",
    "cash.mainBook.delete",
    "cash.partiesBook.view",
    "cash.partiesBook.create",
    "cash.partiesBook.edit",
    "cash.partiesBook.delete",
    "cash.employeeBook.view",
    "cash.employeeBook.create",
    "cash.employeeBook.edit",
    "cash.employeeBook.delete",
    "warehouse.trading.purchase.view",
    "warehouse.trading.purchase.manage",
    "warehouse.trading.sale.view",
    "warehouse.trading.sale.manage",
    "warehouse.trading.payment.view",
    "warehouse.trading.payment.manage",
    "warehouse.trading.receipt.view",
    "warehouse.trading.receipt.manage",
    "warehouse.trading.journal.view",
    "warehouse.trading.journal.manage",
    "warehouse.trading.report.sale",
    "warehouse.trading.report.purchase",
    "warehouse.trading.report.profitLoss",
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
    "cash.view",
    "warehouse.trading.view",
    "report.inward",
    "report.outwardSettlement",
  ],

  viewer: [
    "dashboard.view",
    "report.inward",
    "dropdown.view",
    "employees.view",
    "companies.view",
    "companyAccounts.view",
    "warehouses.view",
    "products.view",
    "consigneeNames.view",
    "buyerNames.view",
    "farmers.view",
  ],
};

const LEGACY_PERMISSION_MAP = {
  "employees.create": ["employees.manage"],
  "employees.edit": ["employees.manage"],
  "employees.delete": ["employees.manage"],
  "locations.view": ["locations.manage"],
  "locations.create": ["locations.manage"],
  "locations.edit": ["locations.manage"],
  "locations.delete": ["locations.manage"],
  "warehouses.view": ["warehouses.manage"],
  "warehouses.create": ["warehouses.manage"],
  "warehouses.edit": ["warehouses.manage"],
  "warehouses.delete": ["warehouses.manage"],
  "companies.view": ["companies.manage"],
  "companies.create": ["companies.manage"],
  "companies.edit": ["companies.manage"],
  "companies.delete": ["companies.manage"],
  "companyAccounts.view": ["companyAccounts.manage"],
  "companyAccounts.create": ["companyAccounts.manage"],
  "companyAccounts.edit": ["companyAccounts.manage"],
  "companyAccounts.delete": ["companyAccounts.manage"],
  "products.view": ["products.manage"],
  "products.create": ["products.manage"],
  "products.edit": ["products.manage"],
  "products.delete": ["products.manage"],
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
  "buyerNames.view": ["outward.view", "outward.create", "outward.edit", "adjustment.manage", "expense.view", "expense.create", "expense.edit", "expense.entry"],
  "buyerNames.create": ["buyerNames.view"],
  "buyerNames.edit": ["buyerNames.view"],
  "buyerNames.delete": ["buyerNames.view"],
  "consigneeNames.view": ["outward.view", "outward.create", "outward.edit", "adjustment.manage", "expense.view", "expense.create", "expense.edit", "expense.entry"],
  "consigneeNames.create": ["consigneeNames.view"],
  "consigneeNames.edit": ["consigneeNames.view"],
  "consigneeNames.delete": ["consigneeNames.view"],
  "expense.postedInward": ["expense.view", "inward.view"],
  "expense.palti": ["expense.view", "report.expense"],
  "expense.selfLoading": ["expense.view", "report.expense", "outward.view"],
  "expense.localSale": ["expense.view", "report.expense"],
  "expense.pending": ["cash.mainBook.view"],
  "cash.pending.post": [],
  "settlement.view": ["reports.view"],
  "settlement.companyRate": ["settlement.view"],
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
  // Backward compatibility for old cash permissions
  "cash.view": ["cash.mainBook.view", "cash.partiesBook.view", "cash.employeeBook.view"],
  "cash.create": ["cash.mainBook.create", "cash.partiesBook.create", "cash.employeeBook.create"],
  "cash.edit": ["cash.mainBook.edit", "cash.partiesBook.edit", "cash.employeeBook.edit"],
  "cash.delete": ["cash.mainBook.delete", "cash.partiesBook.delete", "cash.employeeBook.delete"],
  "cash.mainBook.view": ["cash.view"],
  "cash.mainBook.create": ["cash.create"],
  "cash.mainBook.edit": ["cash.edit"],
  "cash.mainBook.delete": ["cash.delete"],
  "cash.partiesBook.view": ["cash.view"],
  "cash.partiesBook.create": ["cash.create"],
  "cash.partiesBook.edit": ["cash.edit"],
  "cash.partiesBook.delete": ["cash.delete"],
  "cash.employeeBook.view": ["cash.view"],
  "cash.employeeBook.create": ["cash.create"],
  "cash.employeeBook.edit": ["cash.edit"],
  "cash.employeeBook.delete": ["cash.delete"],
  "farmers.view": ["farmers.manage"],
  "farmers.create": ["farmers.manage"],
  "farmers.edit": ["farmers.manage"],
  "farmers.delete": ["farmers.manage"],
  "warehouse.trading.view": [
    "warehouse.trading.manage",
    "warehouse.trading.purchase.view",
    "warehouse.trading.sale.view",
    "warehouse.trading.payment.view",
    "warehouse.trading.receipt.view",
    "warehouse.trading.journal.view",
    "warehouse.trading.report.sale",
    "warehouse.trading.report.purchase",
    "warehouse.trading.report.profitLoss",
  ],
  "warehouse.trading.manage": [
    "warehouse.trading.purchase.manage",
    "warehouse.trading.sale.manage",
    "warehouse.trading.payment.manage",
    "warehouse.trading.receipt.manage",
    "warehouse.trading.journal.manage",
  ],
  "warehouse.trading.purchase.view": ["warehouse.trading.purchase.manage", "warehouse.trading.view", "warehouse.trading.manage"],
  "warehouse.trading.sale.view": ["warehouse.trading.sale.manage", "warehouse.trading.view", "warehouse.trading.manage"],
  "warehouse.trading.payment.view": ["warehouse.trading.payment.manage", "warehouse.trading.view", "warehouse.trading.manage"],
  "warehouse.trading.receipt.view": ["warehouse.trading.receipt.manage", "warehouse.trading.view", "warehouse.trading.manage"],
  "warehouse.trading.journal.view": ["warehouse.trading.journal.manage", "warehouse.trading.view", "warehouse.trading.manage"],
  "warehouse.trading.report.sale": ["warehouse.trading.view", "warehouse.trading.manage", "warehouse.trading.sale.view", "warehouse.trading.sale.manage"],
  "warehouse.trading.report.purchase": ["warehouse.trading.view", "warehouse.trading.manage", "warehouse.trading.purchase.view", "warehouse.trading.purchase.manage"],
  "warehouse.trading.report.profitLoss": ["warehouse.trading.view", "warehouse.trading.manage", "warehouse.trading.purchase.view", "warehouse.trading.purchase.manage", "warehouse.trading.sale.view", "warehouse.trading.sale.manage"],
  "warehouse.trading.purchase.manage": ["warehouse.trading.manage"],
  "warehouse.trading.sale.manage": ["warehouse.trading.manage"],
  "warehouse.trading.payment.manage": ["warehouse.trading.manage"],
  "warehouse.trading.receipt.manage": ["warehouse.trading.manage"],
  "warehouse.trading.journal.manage": ["warehouse.trading.manage"],
};

function normalizeRole(
  role = "staff"
) {

  const normalized =
    String(role || "")
      .trim()
      .toLowerCase();

  if (ROLE_DEFAULT_PERMISSIONS[normalized]) {
    return normalized;
  }

  return String(role || "staff").trim() || "staff";
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

function normalizeObjectIdArray(input) {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((item) => {
          if (!item) return "";
          if (item._id) return String(item._id);
          return String(item);
        })
        .filter((item) => item)
    )
  );
}

async function loadAssignedWarehouseAccess(user) {
  const userId = user?._id ? String(user._id) : String(user?.id || "");

  if (!userId) {
    return {
      assigned_warehouse_ids: [],
      assigned_sqlite_warehouse_ids: [],
      location_ids: [],
    };
  }

  let assignedWarehouseIds =
    normalizeObjectIdArray(
      user?.assigned_warehouse_ids
    );

  let warehouses = [];

  if (user?.all_warehouse_access) {
    warehouses = await Warehouse.find(
      {},
      { _id: 1, name: 1, location_id: 1 }
    ).lean();

    assignedWarehouseIds = (warehouses || [])
      .map((row) => (row?._id ? String(row._id) : ""))
      .filter((item) => item);
  } else if (!assignedWarehouseIds.length) {
    const legacyRows = await Warehouse.find(
      {
        $or: [
          { employee_id: userId },
          { employee_ids: userId },
        ],
      },
      { _id: 1 }
    ).lean();

    assignedWarehouseIds = (legacyRows || [])
      .map((row) => (row?._id ? String(row._id) : ""))
      .filter((item) => item);
  }

  if (!assignedWarehouseIds.length && !user?.all_location_access) {
    return {
      assigned_warehouse_ids: [],
      assigned_sqlite_warehouse_ids: [],
      location_ids: [],
    };
  }

  if (!warehouses.length && assignedWarehouseIds.length) {
    warehouses = await Warehouse.find(
      { _id: { $in: assignedWarehouseIds } },
      { _id: 1, name: 1, location_id: 1 }
    ).lean();
  }

  assignedWarehouseIds = (warehouses || [])
    .map((row) => (row?._id ? String(row._id) : ""))
    .filter((item) => item);

  const assignedSqliteWarehouseIds = [];
  for (const row of warehouses || []) {
    const warehouseName = String(row?.name || "").trim();
    if (!warehouseName) continue;

    const sqliteRow = await new Promise((resolve) => {
      db.get(
        "SELECT id FROM warehouses WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) ORDER BY id ASC LIMIT 1",
        [warehouseName],
        (err, result) => resolve(err ? null : result || null)
      );
    });

    if (sqliteRow?.id) {
      assignedSqliteWarehouseIds.push(Number(sqliteRow.id));
    }
  }

  let locationIds = Array.from(
    new Set(
      (warehouses || [])
        .map((row) => {
          const location = row?.location_id;
          if (!location) return "";
          return location._id ? String(location._id) : String(location);
        })
        .filter((item) => item)
    )
  );

  if (user?.all_location_access) {
    const allLocations = await Location.find({}, { _id: 1 }).lean();
    locationIds = Array.from(
      new Set([
        ...locationIds,
        ...(allLocations || [])
          .map((row) => (row?._id ? String(row._id) : ""))
          .filter((item) => item),
      ])
    );
  }

  return {
    assigned_warehouse_ids: assignedWarehouseIds,
    assigned_sqlite_warehouse_ids: Array.from(new Set(assignedSqliteWarehouseIds)),
    location_ids: locationIds,
  };
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
      user.location_id?._id
        ? String(user.location_id._id)
        : user.location_id
        ? String(user.location_id)
        : null,

    assigned_warehouse_ids:
      normalizeObjectIdArray(
        user.assigned_warehouse_ids
      ),

    all_location_access:
      !!user.all_location_access,

    all_warehouse_access:
      !!user.all_warehouse_access,
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

async function buildAuthenticatedUserPayload(user) {
  const payload = buildUserPayload(user);
  const access =
    await loadAssignedWarehouseAccess(user);

  // Merge warehouse location IDs with employee's own location_ids
  const employeeLocationIds = Array.isArray(user.location_ids)
    ? user.location_ids
      .map((id) => (id?._id ? String(id._id) : String(id)))
      .filter((id) => id)
    : [];

  const mergedLocationIds = Array.from(
    new Set([
      ...access.location_ids,
      ...employeeLocationIds,
    ])
  );

  payload.assigned_warehouse_ids =
    access.assigned_warehouse_ids;
  payload.assigned_sqlite_warehouse_ids =
    access.assigned_sqlite_warehouse_ids;
  payload.location_ids =
    mergedLocationIds;

  if (!payload.location_id && mergedLocationIds.length) {
    payload.location_id = mergedLocationIds[0];
  }

  return payload;
}

function isAdminUser(
  user
) {
  if (!user) {
    return false;
  }

  const permissions = parsePermissions(
    user?.permissions,
    user?.role
  );

  return (
    ["admin"].includes(
      normalizeRole(
        user?.role
      )
    ) || permissions.includes("all")
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

    // If MongoDB is unavailable, fall back to the token payload so the app can
    // keep serving read-only requests instead of timing out at the gateway.
    if (mongoose.connection.readyState !== 1) {
      req.user = decoded;
      return next();
    }

    const user =
      await Employee.findById(
        decoded.id
      );

    if (!user) {
      console.warn(
        "AUTH WARNING: user not found in MongoDB, falling back to token payload for",
        decoded.id
      );
      req.user = decoded;
      return next();
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
      required.some(
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
