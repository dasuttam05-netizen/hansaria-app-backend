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
