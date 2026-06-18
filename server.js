require("dotenv").config();

const express = require("express");
const cors = require("cors");

const {
  authenticate,
  authorize,
  userHasPermission,
} = require("./middleware/auth");

require("./mongo");

const db = require("./db");

/*
========================================
AUTO SQLITE COLUMN FIXES
========================================
*/

const alterQueries = [

  `
  ALTER TABLE cash_entries
  ADD COLUMN journal_group_no TEXT
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN location_id INTEGER
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN warehouse_id INTEGER
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN posted_to_inward INTEGER DEFAULT 0
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN inward_id INTEGER
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN inward_posted_at TEXT
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN posted_to_outward INTEGER DEFAULT 0
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN outward_id INTEGER
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN outward_posted_at TEXT
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN posted_to_palti INTEGER DEFAULT 0
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN palti_posted_at TEXT
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN send_to_kind TEXT
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN send_to_ref_id INTEGER
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN shortage REAL DEFAULT 0
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN excess REAL DEFAULT 0
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN shortage_excess REAL DEFAULT 0
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN balance REAL DEFAULT 0
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN work_description TEXT
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN receive_cash_from_party REAL DEFAULT 0
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN receive_cash_from_driver REAL DEFAULT 0
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN updated_at TEXT
  `,

  `
  ALTER TABLE expenses
  ADD COLUMN created_at TEXT
  `,

  `
  ALTER TABLE cash_entries
  ADD COLUMN source_expense_id INTEGER
  `,

  `
  ALTER TABLE cash_entries
  ADD COLUMN status TEXT DEFAULT 'pending'
  `,

  `
  ALTER TABLE outward
  ADD COLUMN self_loading TEXT DEFAULT 'No'
  `,

  `
  ALTER TABLE outward
  ADD COLUMN narration TEXT
  `,

  `
  ALTER TABLE inward
  ADD COLUMN narration TEXT
  `

];

// Only run SQLite queries in development mode
if (db && process.env.NODE_ENV !== "production") {
  alterQueries.forEach((query) => {

    db.run(query, (err) => {

      if (err) {

        console.log(
          "ALTER TABLE SKIPPED:",
          err.message
        );

      } else {

        console.log(
          "ALTER TABLE SUCCESS"
        );

      }

    });

  });
}

const app = express();

const allowedOrigins = [
  process.env.FRONTEND_ORIGIN || "https://hansaria-app-frontend.vercel.app",
  process.env.BACKEND_ORIGIN || "https://hansaria-app-backend.onrender.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const allowedOriginPatterns = [/\.vercel\.app$/i, /\.onrender\.com$/i];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) {
      return callback(null, true);
    }

    const isAllowedOrigin =
      allowedOrigins.includes(origin) ||
      allowedOriginPatterns.some((pattern) => pattern.test(origin));

    if (isAllowedOrigin) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "Origin",
    "X-Requested-With",
  ],
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());

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
  authorize("employees.view"),
  employeeRoutes
);

app.use(
  "/api/roles",
  authenticate,
  authorize("employees.view"),
  roleRoutes
);

app.use(
  "/api/companies",
  authenticate,
  companiesRoute
);

app.use(
  "/api/company-accounts",
  authenticate,
  companyAccountsRoute
);

app.use(
  "/api/warehouses",
  authenticate,
  warehouseRoutes
);

app.use(
  "/api/products",
  authenticate,
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
  authorizeConsigneeOrExpense,
  consigneeNamesRoutes
);

app.use(
  "/api/buyer-names",
  authenticate,
  authorizeConsigneeOrExpense,
  buyerNamesRoutes
);

app.use(
  "/api/farmers",
  authenticate,
  farmersRoutes
);

app.use(
  "/api/wh-vouchers",
  authenticate,
  authorize("warehouse.trading.view"),
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
  paltiLorryRoutes
);

app.use(
  "/api/self-loading",
  authenticate,
  selfLoadingRoutes
);

app.use(
  "/api/local-sale",
  authenticate,
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
