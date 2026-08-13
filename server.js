require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

function assertCoreFile(fileName) {
  const filePath = path.join(__dirname, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Startup check failed: missing required file "${fileName}" at ${filePath}. ` +
      "This usually means the deploy is running an older or incomplete source snapshot."
    );
  }
}

["db.js", "db-mongodb.js", "sqliteMongoSync.js", "mongo.js"].forEach(assertCoreFile);

const {
  authenticate,
  authorize,
  userHasPermission,
} = require("./middleware/auth");

require("./mongo");

const db = require("./db");

/*
========================================
SQLITE MIGRATION NOTE
========================================
Schema migrations are centralized in db.js, so this bootstrap file
no longer re-runs ALTER TABLE statements here. This avoids duplicate
column startup failures on older databases.
*/

const app = express();

const allowedOrigins = new Set(
  [
    process.env.FRONTEND_URL,
    process.env.FRONTEND_ORIGIN,
    "https://hansaria-app-frontend.vercel.app",
    "http://localhost:3000",
    "http://localhost:3001",
  ].filter(Boolean).map((origin) => origin.replace(/\/+$/, ""))
);

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  const normalizedOrigin = origin.replace(/\/+$/, "");
  return (
    allowedOrigins.has(normalizedOrigin) ||
    /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(normalizedOrigin)
  );
};

const corsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error(`CORS origin not allowed: ${origin}`));
  },
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "Origin",
    "X-Requested-With",
    "Cache-Control",
    "Pragma",
  ],
  exposedHeaders: ["Authorization"],
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,Accept,Origin,X-Requested-With,Cache-Control,Pragma");
    res.setHeader("Vary", "Origin");
  }
  return next();
});
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    if (!res.getHeader("Access-Control-Allow-Origin")) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    if (!res.getHeader("Access-Control-Allow-Credentials")) {
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (!res.getHeader("Access-Control-Allow-Methods")) {
      res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS");
    }
    if (!res.getHeader("Access-Control-Allow-Headers")) {
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,Accept,Origin,X-Requested-With,Cache-Control,Pragma");
    }
    if (!res.getHeader("Vary")) {
      res.setHeader("Vary", "Origin");
    }
  }
  return next();
});
app.use(express.json());
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    if (req.headers.origin && isAllowedOrigin(req.headers.origin)) {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,Accept,Origin,X-Requested-With,Cache-Control,Pragma");
      res.setHeader("Vary", "Origin");
    }
    return res.sendStatus(204);
  }
  return next();
});

// Fallback: ensure CORS headers are always present on every response
// This helps when other middleware or route handlers send responses
// before headers are set by `cors()` (deployed environments may differ).
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    if (!res.getHeader("Access-Control-Allow-Origin")) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    if (!res.getHeader("Access-Control-Allow-Credentials")) {
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (!res.getHeader("Access-Control-Allow-Methods")) {
      res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS");
    }
    if (!res.getHeader("Access-Control-Allow-Headers")) {
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,Accept,Origin,X-Requested-With,Cache-Control,Pragma");
    }
    if (!res.getHeader("Vary")) {
      res.setHeader("Vary", "Origin");
    }
  }

  // Monkey-patch res.send to ensure headers are present just before sending
  const originalSend = res.send;
  res.send = function sendWithCors(body) {
    const o = req.headers.origin;
    if (o && isAllowedOrigin(o) && !res.getHeader("Access-Control-Allow-Origin")) {
      res.setHeader("Access-Control-Allow-Origin", o);
    }
    return originalSend.call(this, body);
  };

  return next();
});

const authRoutes = require("./routes/auth");

const locationRoutes = require("./routes/location");

const employeeRoutes = require("./routes/employee");

const roleRoutes = require("./routes/roles");

const companiesRoute = require("./routes/companies");

const companyAccountsRoute = require("./routes/companyAccounts");

const warehouseRoutes = require("./routes/warehouses");

const productsRoute = require("./routes/products");

const inwardRoute = require("./routes/inward");

const outwardRoute = require("./routes/outward");

const reportsRoute = require("./routes/reports");

const adjustmentRoutes = require("./routes/adjustmentRoutes");

const buyerAdjustmentRoutes = require("./routes/buyerAdjustment");

let systemRoutes;
try {
  systemRoutes = require("./routes/system");
} catch (err) {
  console.warn("Warning: system route module not loaded:", err.message);
}

const stockRoutes = require("./routes/stockRoutes");

const outwardSettlementRoutes = require("./routes/outwardSettlement");

const transportersRoutes = require("./routes/transporters");

const transportBiltiRoutes = require("./routes/transportBilti");

const expenseRoutes = require("./routes/expenses");

const paltiLorryRoutes = require("./routes/paltiLorry");

const selfLoadingRoutes = require("./routes/selfLoading");

const localSaleRoutes = require("./routes/localSale");

const consigneeNamesRoutes = require("./routes/consigneeNames");

const buyerNamesRoutes = require("./routes/buyerNames");
const farmersRoutes = require("./routes/farmers");
const whVouchersRoutes = require("./routes/whVouchers");

const cashEntriesRoutes = require("./routes/cashEntries");
const { normalizeDashboardList, normalizeDashboardSummary } = require("./helpers/dashboardPayload");
const { Location, Employee, Company, CompanyAccount, Warehouse, Product, Inward, Outward } = require("./db-mongodb");
const { calculateShortageQty } = require("./routes/shortageHelper");

function authorizeConsigneeOrExpense(
  req,
  res,
  next
) {

  if (
    userHasPermission(
      req.user,
      "outward.view"
    ) ||

    userHasPermission(
      req.user,
      "outward.create"
    ) ||

    userHasPermission(
      req.user,
      "outward.edit"
    ) ||

    userHasPermission(
      req.user,
      "adjustment.manage"
    ) ||

    userHasPermission(
      req.user,
      "expense.entry"
    ) ||

    userHasPermission(
      req.user,
      "expense.view"
    ) ||

    userHasPermission(
      req.user,
      "expense.create"
    ) ||

    userHasPermission(
      req.user,
      "expense.edit"
    )
  ) {

    return next();

  }

  return res.status(403).json({
    error:
      "You do not have permission to perform this action",
  });
}

function authorizeCashEntries(
  req,
  res,
  next
) {

  if (
    userHasPermission(
      req.user,
      "cash.view"
    )
  ) {

    return next();

  }

  const canViewPendingExpense =
    userHasPermission(
      req.user,
      "expense.pending"
    );

  const isPendingExpenseListCall =
    req.method === "GET" &&
    (
      req.path === "/" ||
      req.path === ""
    );

  if (
    canViewPendingExpense &&
    isPendingExpenseListCall
  ) {

    return next();

  }

  return res.status(403).json({
    error:
      "You do not have permission to perform this action",
  });
}

app.use(
  "/auth",
  authRoutes
);

app.use(
  "/api/locations",
  authenticate,
  locationRoutes
);

app.use(
  "/api/employees",
  authenticate,
  authorize(["dropdown.view", "employees.view", "expense.entry", "expense.view", "expense.create", "expense.edit"]),
  employeeRoutes
);

app.use(
  "/api/roles",
  authenticate,
  authorize(["dropdown.view", "employees.view", "expense.entry", "expense.view", "expense.create", "expense.edit"]),
  roleRoutes
);

app.use(
  "/api/companies",
  authenticate,
  authorize(["dropdown.view", "companies.view", "companies.manage", "expense.entry", "expense.view", "expense.create", "expense.edit"]),
  companiesRoute
);

app.use(
  "/api/company-accounts",
  authenticate,
  authorize(["dropdown.view", "companyAccounts.view", "companyAccounts.manage", "expense.entry", "expense.view", "expense.create", "expense.edit"]),
  companyAccountsRoute
);

app.use(
  "/api/warehouses",
  authenticate,
  authorize(["dropdown.view", "warehouses.view", "warehouses.manage", "expense.entry", "expense.view", "expense.create", "expense.edit"]),
  warehouseRoutes
);

app.use(
  "/api/products",
  authenticate,
  authorize(["dropdown.view", "products.view", "products.manage", "expense.entry", "expense.view", "expense.create", "expense.edit"]),
  productsRoute
);

app.use(
  "/api/inward",
  authenticate,
  authorize("inward.view"),
  inwardRoute
);

app.use(
  "/api/outward",
  authenticate,
  authorize("outward.view"),
  outwardRoute
);

app.use(
  "/api/consignee-names",
  authenticate,
  authorize(["dropdown.view", "consigneeNames.view", "consigneeNames.create", "consigneeNames.edit", "consigneeNames.delete", "outward.view", "outward.create", "outward.edit", "adjustment.manage", "expense.entry", "expense.view", "expense.create", "expense.edit"]),
  authorizeConsigneeOrExpense,
  consigneeNamesRoutes
);

app.use(
  "/api/buyer-names",
  authenticate,
  authorize(["dropdown.view", "buyerNames.view", "buyerNames.create", "buyerNames.edit", "buyerNames.delete", "outward.view", "outward.create", "outward.edit", "adjustment.manage", "expense.entry", "expense.view", "expense.create", "expense.edit"]),
  authorizeConsigneeOrExpense,
  buyerNamesRoutes
);

app.use(
  "/api/farmers",
  authenticate,
  authorize(["dropdown.view", "farmers.view", "farmers.manage", "expense.view", "expense.create", "expense.edit"]),
  farmersRoutes
);

app.use(
  "/api/wh-vouchers",
  authenticate,
  authorize([
    "warehouse.trading.view",
    "warehouse.trading.manage",
    "warehouse.trading.purchase.view",
    "warehouse.trading.purchase.create",
    "warehouse.trading.purchase.edit",
    "warehouse.trading.purchase.delete",
    "warehouse.trading.sale.view",
    "warehouse.trading.sale.create",
    "warehouse.trading.sale.edit",
    "warehouse.trading.sale.delete",
    "warehouse.trading.payment.view",
    "warehouse.trading.payment.create",
    "warehouse.trading.payment.edit",
    "warehouse.trading.payment.delete",
    "warehouse.trading.receipt.view",
    "warehouse.trading.receipt.create",
    "warehouse.trading.receipt.edit",
    "warehouse.trading.receipt.delete",
    "warehouse.trading.journal.view",
    "warehouse.trading.journal.create",
    "warehouse.trading.journal.edit",
    "warehouse.trading.journal.delete",
    "warehouse.trading.report.sale",
    "warehouse.trading.report.purchase",
    "warehouse.trading.report.profitLoss",
  ]),
  whVouchersRoutes
);

app.use(
  "/api/reports",
  authenticate,
  reportsRoute
);

app.get("/api/dashboard", authenticate, authorize("dashboard.view"), async (req, res) => {
  try {
    const { user } = req;
    const currentMonth = new Date().toISOString().slice(0, 7);
    const currentDate = new Date().toISOString().slice(0, 10);

    const canReadLocations = userHasPermission(user, "dashboard.view") || userHasPermission(user, "locations.manage") || userHasPermission(user, "expense.entry") || userHasPermission(user, "expense.view") || userHasPermission(user, "expense.create") || userHasPermission(user, "expense.edit") || userHasPermission(user, "inward.view") || userHasPermission(user, "inward.create") || userHasPermission(user, "outward.view") || userHasPermission(user, "outward.create") || userHasPermission(user, "employees.view") || userHasPermission(user, "report.partyStock") || userHasPermission(user, "report.warehouseRentLedger") || userHasPermission(user, "report.warehouseRentMonthEnd");
    const canReadEmployees = userHasPermission(user, "dashboard.view") || userHasPermission(user, "employees.view") || userHasPermission(user, "inward.view") || userHasPermission(user, "outward.view") || userHasPermission(user, "expense.entry") || userHasPermission(user, "report.erp");
    const canReadCompanies = userHasPermission(user, "dashboard.view") || userHasPermission(user, "companies.manage") || userHasPermission(user, "inward.view") || userHasPermission(user, "inward.create") || userHasPermission(user, "outward.view") || userHasPermission(user, "outward.create") || userHasPermission(user, "adjustment.manage") || userHasPermission(user, "expense.entry") || userHasPermission(user, "expense.view") || userHasPermission(user, "expense.create") || userHasPermission(user, "cash.view") || userHasPermission(user, "settlement.view") || userHasPermission(user, "report.inward") || userHasPermission(user, "report.erp") || userHasPermission(user, "report.partyLedger") || userHasPermission(user, "report.partyStock") || userHasPermission(user, "report.warehouseRentLedger") || userHasPermission(user, "report.warehouseRentMonthEnd") || userHasPermission(user, "report.outwardSettlement") || userHasPermission(user, "report.expense");
    const canReadCompanyAccounts = userHasPermission(user, "dashboard.view") || userHasPermission(user, "companyAccounts.manage") || userHasPermission(user, "inward.view") || userHasPermission(user, "inward.create") || userHasPermission(user, "outward.view") || userHasPermission(user, "outward.create") || userHasPermission(user, "adjustment.manage") || userHasPermission(user, "expense.entry") || userHasPermission(user, "expense.view") || userHasPermission(user, "expense.create") || userHasPermission(user, "cash.view") || userHasPermission(user, "settlement.view") || userHasPermission(user, "report.inward") || userHasPermission(user, "report.erp") || userHasPermission(user, "report.partyLedger") || userHasPermission(user, "report.partyStock") || userHasPermission(user, "report.warehouseRentLedger") || userHasPermission(user, "report.warehouseRentMonthEnd") || userHasPermission(user, "report.outwardSettlement") || userHasPermission(user, "report.expense");
    const canReadWarehouses = userHasPermission(user, "dashboard.view") || userHasPermission(user, "warehouses.manage") || userHasPermission(user, "warehouse.trading.purchase.view") || userHasPermission(user, "warehouse.trading.sale.view") || userHasPermission(user, "warehouse.trading.payment.view") || userHasPermission(user, "warehouse.trading.receipt.view") || userHasPermission(user, "warehouse.trading.journal.view") || userHasPermission(user, "outward.view") || userHasPermission(user, "inward.view");
    const canReadProducts = userHasPermission(user, "dashboard.view") || userHasPermission(user, "products.manage") || userHasPermission(user, "inward.view") || userHasPermission(user, "inward.create") || userHasPermission(user, "outward.view") || userHasPermission(user, "outward.create") || userHasPermission(user, "adjustment.manage") || userHasPermission(user, "expense.entry") || userHasPermission(user, "expense.view") || userHasPermission(user, "expense.create") || userHasPermission(user, "transport.manage") || userHasPermission(user, "report.inward") || userHasPermission(user, "report.erp") || userHasPermission(user, "report.partyLedger") || userHasPermission(user, "report.partyStock");
    const canReadInwards = userHasPermission(user, "dashboard.view") || userHasPermission(user, "inward.manage") || userHasPermission(user, "inward.view") || userHasPermission(user, "inward.create");
    const canReadOutwards = userHasPermission(user, "dashboard.view") || userHasPermission(user, "outward.manage") || userHasPermission(user, "outward.view") || userHasPermission(user, "outward.create");
    const rentRate = 200;
    const referenceDate = currentDate;

    const queryAll = (sql, params = []) => new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        return resolve(rows || []);
      });
    });

    const calculateMonthSlab = (inwardDateStr, refDateStr) => {
      const inwardDate = new Date(inwardDateStr);
      const refDate = new Date(refDateStr);
      const msPerDay = 1000 * 60 * 60 * 24;
      const daysDiff = Math.floor((refDate - inwardDate) / msPerDay);
      let monthsDiff = Math.floor((daysDiff <= 0 ? 0 : daysDiff - 1) / 30) + 1;
      if (monthsDiff < 1) monthsDiff = 1;
      return { daysDiff: daysDiff < 0 ? 0 : daysDiff, monthsDiff };
    };

    const firstNonEmptyDate = (...values) => {
      for (const value of values) {
        const text = String(value || "").trim();
        if (text && text !== "-" && text.toLowerCase() !== "null" && text.toLowerCase() !== "undefined") {
          return text.slice(0, 10);
        }
      }
      return null;
    };

    const calculateAvailableQty = (weight, inwardDate, alreadyAdjusted, refDate = currentDate, shortagePercent = null) => {
      const gross = Number(weight) || 0;
      const slab = calculateMonthSlab(inwardDate, refDate);
      const shortage = calculateShortageQty(gross, slab.monthsDiff, shortagePercent);
      return gross - shortage - Number(alreadyAdjusted || 0);
    };

    const [
      locations,
      employees,
      companies,
      companyAccounts,
      warehouses,
      products,
      inwardRows,
      outwardRows,
      partyStockRows,
      warehouseStockRows,
      totalStockRows,
      adjustmentRows,
    ] = await Promise.all([
      canReadLocations
        ? queryAll("SELECT id, name, address FROM locations ORDER BY id DESC")
        : Promise.resolve([]),
      canReadEmployees
        ? queryAll("SELECT id, name, mobile, address, username, role, permissions, location_id FROM employees ORDER BY id DESC")
        : Promise.resolve([]),
      canReadCompanies
        ? queryAll("SELECT id, name, address, mobile, shortage_percent FROM companies ORDER BY id DESC")
        : Promise.resolve([]),
      canReadCompanyAccounts
        ? queryAll("SELECT id, account_name, address, company_id, pan_no, mobile, shortage_percent FROM company_accounts ORDER BY id DESC")
        : Promise.resolve([]),
      canReadWarehouses
        ? queryAll("SELECT id, name, address, location_id, employee_id FROM warehouses ORDER BY id DESC")
        : Promise.resolve([]),
      canReadProducts
        ? queryAll("SELECT id, name, hsn_code FROM products ORDER BY id DESC")
        : Promise.resolve([]),
      canReadInwards
        ? queryAll("SELECT id, sl_no, voucher_no, date, employee_id, location_id, warehouse_id, product_id, company_id, company_account_id, lorry_no, weight, remaining_qty, shortage_percent, labour_charges, rent, shortage, narration FROM inward ORDER BY date DESC, id DESC LIMIT 200")
        : Promise.resolve([]),
      canReadOutwards
        ? queryAll("SELECT id, sl_no, voucher_no, date, employee_id, location_id, warehouse_id, product_id, company_id, company_account_id, lorry_no, weight, quantity, rate, amount, buyer_name, consignee_name, inv_no, self_loading, narration, labour_charges, total_freight, rent, shortage, status FROM outward ORDER BY date DESC, id DESC LIMIT 200")
        : Promise.resolve([]),
      true
        ? queryAll(`
            SELECT
              i.id,
              i.date,
              i.company_id,
              i.company_account_id,
              i.location_id,
              i.warehouse_id,
              i.product_id,
              i.weight,
              i.shortage_percent,
              IFNULL((SELECT SUM(a.qty) FROM adjustment a WHERE CAST(a.inward_id AS TEXT) = CAST(i.id AS TEXT)), 0) AS already_adjusted,
              COALESCE(ca.account_name, c.name, 'Unknown') AS party_name,
              COALESCE(w.name, 'Unknown') AS warehouse_name
            FROM inward i
            LEFT JOIN companies c ON c.id = i.company_id
            LEFT JOIN company_accounts ca ON ca.id = i.company_account_id
            LEFT JOIN warehouses w ON w.id = i.warehouse_id
            ORDER BY i.date ASC, i.id ASC
          `)
        : Promise.resolve([]),
      true
        ? queryAll(`
            SELECT
              a.id,
              a.inward_id,
              a.qty,
              a.created_at,
              o.date AS outward_date,
              tb.dispatch_date AS transport_dispatch_date,
              ba.unloading_date AS buyer_unloading_date
            FROM adjustment a
            LEFT JOIN outward o ON CAST(o.id AS TEXT) = CAST(a.outward_id AS TEXT)
            LEFT JOIN (
              SELECT outward_id, MAX(dispatch_date) AS dispatch_date
              FROM transport_bilti
              WHERE COALESCE(dispatch_date, '') != ''
              GROUP BY outward_id
            ) tb ON CAST(tb.outward_id AS TEXT) = CAST(a.outward_id AS TEXT)
            LEFT JOIN (
              SELECT outward_id, MAX(unloading_date) AS unloading_date
              FROM buyer_adjustments
              WHERE COALESCE(unloading_date, '') != ''
              GROUP BY outward_id
            ) ba ON CAST(ba.outward_id AS TEXT) = CAST(a.outward_id AS TEXT)
            WHERE DATE(COALESCE(tb.dispatch_date, ba.unloading_date, o.date, a.created_at)) <= ?
            ORDER BY DATE(COALESCE(tb.dispatch_date, ba.unloading_date, o.date, a.created_at)) ASC, a.id ASC
          `, [referenceDate])
        : Promise.resolve([]),
      true
        ? queryAll("SELECT weight, date, shortage_percent FROM inward")
        : Promise.resolve([]),
      true
        ? queryAll(
            `
            SELECT
              i.id,
              i.date,
              i.voucher_no,
              i.lorry_no,
              i.weight,
              i.company_id,
              i.company_account_id,
              i.warehouse_id,
              i.shortage_percent,
              i.rent,
              COALESCE(ca.account_name, c.name, 'Unknown') AS party_name,
              COALESCE(w.name, 'Unknown') AS warehouse_name
            FROM inward i
            LEFT JOIN companies c ON c.id = i.company_id
            LEFT JOIN company_accounts ca ON ca.id = i.company_account_id
            LEFT JOIN warehouses w ON w.id = i.warehouse_id
            ORDER BY i.date ASC, i.id ASC
          `,
            []
          )
        : Promise.resolve([]),
    ]);

    const listPayload = {
      locations: normalizeDashboardList(locations).map((item) => ({
        ...item,
        id: item.id ?? item._id,
        name: item.name || item.account_name || "",
      })),
      employees: normalizeDashboardList(employees).map((item) => ({
        ...item,
        id: item.id ?? item._id,
        name: item.name || "",
      })),
      companies: normalizeDashboardList(companies).map((item) => ({
        ...item,
        id: item.id ?? item._id,
        name: item.name || "",
      })),
      companyAccounts: normalizeDashboardList(companyAccounts).map((item) => ({
        ...item,
        id: item.id ?? item._id,
        name: item.account_name || item.name || "",
      })),
      warehouses: normalizeDashboardList(warehouses).map((item) => ({
        ...item,
        id: item.id ?? item._id,
        name: item.name || "",
      })),
      products: normalizeDashboardList(products).map((item) => ({
        ...item,
        id: item.id ?? item._id,
        name: item.name || "",
      })),
      inwards: normalizeDashboardList(inwardRows).map((item) => ({
        ...item,
        id: item.id ?? item._id,
        voucher_no: item.voucher_no || item.inward_no || item.inwardNo || item.voucherNo,
        date: item.date ? String(item.date).slice(0, 10) : "",
        company_name: item.company_name || item.company || (typeof item.company_id === "string" ? item.company_id : undefined) || "",
        account_name: item.account_name || item.company_account || item.companyAccount || "",
        weight: item.weight ?? item.quantity ?? 0,
      })),
      outwards: normalizeDashboardList(outwardRows).map((item) => ({
        ...item,
        id: item.id ?? item._id,
        inv_no: item.inv_no || item.outward_no || item.outwardNo || item.invoice_no || item.voucher_no || item.voucherNo,
        date: item.date ? String(item.date).slice(0, 10) : "",
        party_name: item.party_name || item.buyer_name || item.buyer || item.company_name || item.company || "",
        company_name: item.company_name || item.company || "",
        account_name: item.account_name || item.company_account || item.companyAccount || "",
        weight: item.weight ?? item.quantity ?? 0,
      })),
    };

    const adjustmentMap = {};
    (adjustmentRows || []).forEach((item) => {
      const key = String(item.inward_id);
      if (!adjustmentMap[key]) adjustmentMap[key] = [];
      adjustmentMap[key].push(item);
    });

    const rentDetailedRows = [];
    (partyStockRows || []).forEach((row) => {
      const originalWeight = Number(row.weight) || 0;
      const adjustments = adjustmentMap[String(row.id)] || [];
      const slab = calculateMonthSlab(row.date, referenceDate);
      const adjustedQty = Number(row.already_adjusted || 0);
      let adjustedRentAmount = 0;
      let lastDispatchDate = null;

      adjustments.forEach((adj) => {
        const adjustmentDate = firstNonEmptyDate(
          adj.transport_dispatch_date,
          adj.buyer_unloading_date,
          adj.outward_date,
          adj.created_at
        );
        if (!adjustmentDate || adjustmentDate > referenceDate) return;

        const qty = Number(adj.qty) || 0;
        const adjustmentSlab = calculateMonthSlab(row.date, adjustmentDate);
        adjustedRentAmount += qty * rentRate * adjustmentSlab.monthsDiff;
        if (!lastDispatchDate || adjustmentDate > lastDispatchDate) lastDispatchDate = adjustmentDate;
      });

      const shortageQty = calculateShortageQty(originalWeight, slab.monthsDiff, row.shortage_percent);
      const balanceQty = Math.max(calculateAvailableQty(originalWeight, row.date, adjustedQty, referenceDate, row.shortage_percent), 0);
      const balanceRentAmount = balanceQty * rentRate * slab.monthsDiff;

      rentDetailedRows.push({
        id: row.id,
        party_name: row.party_name || "Unknown",
        warehouse_name: row.warehouse_name || "-",
        voucher_no: row.voucher_no || "",
        lorry_no: row.lorry_no || "",
        original_weight: Number(originalWeight.toFixed(4)),
        shortage_qty: Number(shortageQty.toFixed(4)),
        adjusted_qty: Number(adjustedQty.toFixed(4)),
        balance_qty: Number(balanceQty.toFixed(4)),
        total_rent: Number((adjustedRentAmount + balanceRentAmount).toFixed(2)),
        total_entries: 1,
        dispatch_date: lastDispatchDate || null,
      });
    });

    const partyStockSummary = normalizeDashboardSummary({
      summary: rentDetailedRows.map((row) => ({
        party_name: row.party_name,
        warehouse_name: row.warehouse_name,
        gross_qty: row.original_weight,
        shortage_qty: row.shortage_qty,
        net_opening_qty: row.original_weight,
        already_adjusted_qty: row.adjusted_qty,
        available_balance_qty: row.balance_qty,
      })),
    });

    const warehouseStockSummary = normalizeDashboardSummary({
      summary: rentDetailedRows.map((row) => ({
        warehouse: row.warehouse_name,
        party: row.party_name,
        location: "-",
        stock: row.balance_qty,
      })),
    });

    const totalStockValue = rentDetailedRows.reduce((sum, row) => sum + Number(row.balance_qty || 0), 0);
    const totalRentValue = Number(
      rentDetailedRows.reduce((sum, row) => sum + Number(row.total_rent || 0), 0).toFixed(2)
    );

    const monthEndRentSummary = normalizeDashboardSummary({
      summary: rentDetailedRows.map((row) => ({
        party_name: row.party_name,
        warehouse_name: row.warehouse_name,
        total_rent: row.total_rent,
        total_entries: row.total_entries,
        voucher_no: row.voucher_no,
        lorry_no: row.lorry_no,
        original_weight: row.original_weight,
        adjusted_qty: row.adjusted_qty,
        shortage_qty: row.shortage_qty,
        balance_qty: row.balance_qty,
      })),
    });

    res.json({
      ...listPayload,
      partyStock: partyStockSummary,
      warehouseStock: warehouseStockSummary,
      totalStock: totalStockValue,
      totalRent: totalRentValue,
      monthEndRentSummary,
      meta: {
        currentMonth,
        currentDate,
      },
    });
  } catch (error) {
    console.error("Failed to load dashboard payload:", error);
    res.status(500).json({ error: error.message });
  }
});

if (systemRoutes) {
  app.use(
    "/api/system",
    authenticate,
    systemRoutes
  );
}

app.use(
  "/api/adjustment",
  authenticate,
  authorize("adjustment.manage"),
  adjustmentRoutes
);

app.use(
  "/api/buyer-adjustment",
  authenticate,
  authorize(["outward.view", "outward.create", "outward.edit", "adjustment.manage"]),
  buyerAdjustmentRoutes
);

app.use(
  "/api/stock",
  authenticate,
  authorize("dashboard.view"),
  stockRoutes
);

app.use(
  "/api/outward-settlement",
  authenticate,
  authorize("settlement.view"),
  outwardSettlementRoutes
);

app.use(
  "/api/transporters",
  authenticate,
  authorize("transport.manage"),
  transportersRoutes
);

app.use(
  "/api/transport-bilti",
  authenticate,
  authorize("transport.manage"),
  transportBiltiRoutes
);

app.use(
  "/api/expenses",
  authenticate,
  expenseRoutes
);

app.use(
  "/api/palti-lorry",
  authenticate,
  authorize("expense.palti"),
  paltiLorryRoutes
);

app.use(
  "/api/self-loading",
  authenticate,
  authorize("expense.selfLoading"),
  selfLoadingRoutes
);

app.use(
  "/api/local-sale",
  authenticate,
  authorize("expense.localSale"),
  localSaleRoutes
);

app.use(
  "/api/cash-entries",
  authenticate,
  authorizeCashEntries,
  cashEntriesRoutes
);

app.get("/", (req, res) => {

  res.send(
    "Backend Running OK"
  );

});

app.use(
  (
    err,
    req,
    res,
    next
  ) => {

    console.error(
      "Server Error:",
      err.stack
    );

    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,Accept,Origin,X-Requested-With,Cache-Control,Pragma");
      res.setHeader("Vary", "Origin");
    }

    res.status(500).json({
      error:
        "Something went wrong",
    });

  }
);

const PORT = Number(
  process.env.PORT || 4001
);

const HOST =
  process.env.HOST ||
  "0.0.0.0";

app.listen(
  PORT,
  HOST,
  () => {

    console.log(
      `Backend running at http://${
        HOST === "0.0.0.0"
          ? "localhost"
          : HOST
      }:${PORT}`
    );

  }
);
