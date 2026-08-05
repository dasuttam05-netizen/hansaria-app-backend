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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,Accept,Origin,X-Requested-With");
    res.setHeader("Vary", "Origin");
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
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,Accept,Origin,X-Requested-With");
      res.setHeader("Vary", "Origin");
    }
    return res.sendStatus(204);
  }
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
    const canLoadPartyStockInsights = userHasPermission(user, "report.partyStock");
    const canLoadWarehouseRentInsights = userHasPermission(user, "report.warehouseRentMonthEnd");
    const canReadInwards = userHasPermission(user, "dashboard.view") || userHasPermission(user, "inward.manage") || userHasPermission(user, "inward.view") || userHasPermission(user, "inward.create");
    const canReadOutwards = userHasPermission(user, "dashboard.view") || userHasPermission(user, "outward.manage") || userHasPermission(user, "outward.view") || userHasPermission(user, "outward.create");

    const queryAll = (sql, params = []) => new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        return resolve(rows || []);
      });
    });

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
      monthEndRentRows,
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
      canLoadPartyStockInsights
        ? queryAll("SELECT id, date, company_id, location_id, warehouse_id, product_id, company_account_id, weight, shortage_percent FROM inward ORDER BY date ASC, id ASC")
        : Promise.resolve([]),
      canLoadWarehouseRentInsights
        ? queryAll("SELECT id, date, voucher_no, lorry_no, weight, company_id, company_account_id, warehouse_id, shortage_percent FROM inward ORDER BY date ASC, id ASC")
        : Promise.resolve([]),
      canLoadPartyStockInsights
        ? queryAll("SELECT weight, date, shortage_percent FROM inward")
        : Promise.resolve([]),
      canLoadWarehouseRentInsights
        ? queryAll("SELECT id, date, voucher_no, lorry_no, weight, company_id, company_account_id, warehouse_id, shortage_percent FROM inward ORDER BY date ASC, id ASC")
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

    const partyStockSummary = normalizeDashboardSummary({
      summary: (partyStockRows || []).map((row) => ({
        party_name: row.company_id || row.company_account_id ? `Party ${row.company_id || row.company_account_id}` : "Unknown",
        warehouse_name: row.warehouse_id ? `Warehouse ${row.warehouse_id}` : "-",
        gross_qty: Number(row.weight || 0),
        shortage_qty: 0,
        net_opening_qty: Number(row.weight || 0),
        already_adjusted_qty: 0,
        available_balance_qty: Number(row.weight || 0),
      })),
    });

    const warehouseStockSummary = normalizeDashboardSummary({
      summary: (warehouseStockRows || []).map((row) => ({
        warehouse: row.warehouse_id ? `Warehouse ${row.warehouse_id}` : "Unknown",
        party: row.company_id || row.company_account_id ? `Party ${row.company_id || row.company_account_id}` : "Unknown",
        location: row.location_id ? `Location ${row.location_id}` : "-",
        stock: Number(row.weight || 0),
      })),
    });

    const totalStockValue = (totalStockRows || []).reduce((sum, row) => sum + Number(row.weight || 0), 0);

    const monthEndRentSummary = normalizeDashboardSummary({
      summary: (monthEndRentRows || []).map((row) => ({
        party_name: row.company_id || row.company_account_id ? `Party ${row.company_id || row.company_account_id}` : "Unknown",
        warehouse_name: row.warehouse_id ? `Warehouse ${row.warehouse_id}` : "-",
        total_rent: 0,
        total_entries: 1,
      })),
    });

    res.json({
      ...listPayload,
      partyStock: partyStockSummary,
      warehouseStock: warehouseStockSummary,
      totalStock: totalStockValue,
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
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,Accept,Origin,X-Requested-With");
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
