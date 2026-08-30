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

[ 
  "db-mongodb.js",
  "mongo.js",
].forEach(assertCoreFile);

const {
  authenticate,
  authorize,
  userHasPermission,
} = require("./middleware/auth");

require("./mongo");

const db = require("./db-mongodb");

/*
========================================
MONGODB PRIMARY BOOTSTRAP
========================================
The backend now boots directly against MongoDB. Legacy mirror and
local-database startup paths are no longer part of the runtime flow.
*/

const app = express();

const allowedOrigins = new Set(
  [
    process.env.FRONTEND_URL,
    process.env.FRONTEND_ORIGIN,
    "https://hansaria-app-frontend.vercel.app",
  ]
    .filter(Boolean)
    .map((origin) => origin.replace(/\/+$/, ""))
);

const isAllowedOrigin = (origin) => {
  if (!origin) return true;

  const normalizedOrigin = origin.replace(/\/+$/, "");

  return (
    allowedOrigins.has(normalizedOrigin) ||
    /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(
      normalizedOrigin
    )
  );
};

const corsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }

    return callback(
      new Error(`CORS origin not allowed: ${origin}`)
    );
  },

  methods: [
    "GET",
    "HEAD",
    "PUT",
    "PATCH",
    "POST",
    "DELETE",
    "OPTIONS",
  ],

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
    res.setHeader(
      "Access-Control-Allow-Origin",
      origin
    );

    res.setHeader(
      "Access-Control-Allow-Credentials",
      "true"
    );

    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS"
    );

    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type,Authorization,Accept,Origin,X-Requested-With,Cache-Control,Pragma"
    );

    res.setHeader("Vary", "Origin");
  }

  return next();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && isAllowedOrigin(origin)) {
    if (
      !res.getHeader(
        "Access-Control-Allow-Origin"
      )
    ) {
      res.setHeader(
        "Access-Control-Allow-Origin",
        origin
      );
    }

    if (
      !res.getHeader(
        "Access-Control-Allow-Credentials"
      )
    ) {
      res.setHeader(
        "Access-Control-Allow-Credentials",
        "true"
      );
    }

    if (
      !res.getHeader(
        "Access-Control-Allow-Methods"
      )
    ) {
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS"
      );
    }

    if (
      !res.getHeader(
        "Access-Control-Allow-Headers"
      )
    ) {
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type,Authorization,Accept,Origin,X-Requested-With,Cache-Control,Pragma"
      );
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
    if (
      req.headers.origin &&
      isAllowedOrigin(req.headers.origin)
    ) {
      res.setHeader(
        "Access-Control-Allow-Origin",
        req.headers.origin
      );

      res.setHeader(
        "Access-Control-Allow-Credentials",
        "true"
      );

      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS"
      );

      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type,Authorization,Accept,Origin,X-Requested-With,Cache-Control,Pragma"
      );

      res.setHeader("Vary", "Origin");
    }

    return res.sendStatus(204);
  }

  return next();
});

// Fallback: ensure CORS headers are always present on every response
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && isAllowedOrigin(origin)) {
    if (
      !res.getHeader(
        "Access-Control-Allow-Origin"
      )
    ) {
      res.setHeader(
        "Access-Control-Allow-Origin",
        origin
      );
    }

    if (
      !res.getHeader(
        "Access-Control-Allow-Credentials"
      )
    ) {
      res.setHeader(
        "Access-Control-Allow-Credentials",
        "true"
      );
    }

    if (
      !res.getHeader(
        "Access-Control-Allow-Methods"
      )
    ) {
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS"
      );
    }

    if (
      !res.getHeader(
        "Access-Control-Allow-Headers"
      )
    ) {
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type,Authorization,Accept,Origin,X-Requested-With,Cache-Control,Pragma"
      );
    }

    if (!res.getHeader("Vary")) {
      res.setHeader("Vary", "Origin");
    }
  }

  // Monkey-patch res.send to ensure headers are present
  const originalSend = res.send;

  res.send = function sendWithCors(body) {
    const o = req.headers.origin;

    if (
      o &&
      isAllowedOrigin(o) &&
      !res.getHeader(
        "Access-Control-Allow-Origin"
      )
    ) {
      res.setHeader(
        "Access-Control-Allow-Origin",
        o
      );
    }

    return originalSend.call(this, body);
  };

  return next();
});

/*
========================================
ROUTES
========================================
*/

const authRoutes =
  require("./routes/auth");

const locationRoutes =
  require("./routes/location");

const employeeRoutes =
  require("./routes/employee");

const roleRoutes =
  require("./routes/roles");

const companiesRoute =
  require("./routes/companies");

const companyAccountsRoute =
  require("./routes/companyAccounts");

const warehouseRoutes =
  require("./routes/warehouses");

const warehouseRentBookingRoutes =
  require("./routes/warehouseRentBooking");

const productsRoute =
  require("./routes/products");

const inwardRoute =
  require("./routes/inward");

const outwardRoute =
  require("./routes/outward");

const reportsRoute =
  require("./routes/reports");

const adjustmentRoutes =
  require("./routes/adjustmentRoutes");

const buyerAdjustmentRoutes =
  require("./routes/buyerAdjustment");

let systemRoutes;

try {
  systemRoutes =
    require("./routes/system");
} catch (err) {
  console.warn(
    "[Optional] system route module not loaded. Continuing without /api/system."
  );
}

const stockRoutes =
  require("./routes/stockRoutes");

const rentStockMongoRoutes =
  require("./routes/rentStockMongo");

const outwardSettlementRoutes =
  require("./routes/outwardSettlement");

const transportersRoutes =
  require("./routes/transporters");

const transportBiltiRoutes =
  require("./routes/transportBilti");

const expenseRoutes =
  require("./routes/expenses");

const paltiLorryRoutes =
  require("./routes/paltiLorry");

const selfLoadingRoutes =
  require("./routes/selfLoading");

const localSaleRoutes =
  require("./routes/localSale");

const consigneeNamesRoutes =
  require("./routes/consigneeNames");

const buyerNamesRoutes =
  require("./routes/buyerNames");

const farmersRoutes =
  require("./routes/farmers");

const warehouseTradingRoutes =
  require("./routes/warehouseTrading");

const whVouchersRoutes =
  require("./routes/whVouchers");

const cashEntriesRoutes =
  require("./routes/cashEntries");

const mongoHealthRoutes =
  require("./routes/mongoHealth");

const {
  normalizeDashboardList,
  normalizeDashboardSummary,
} = require("./helpers/dashboardPayload");

/*
========================================
MONGODB MODELS
========================================
*/

const {
  mongoose,
  Location,
  Employee,
  Company,
  CompanyAccount,
  Warehouse,
  Product,
  Inward,
  Outward,
  Adjustment,
  BuyerAdjustment,
  MirrorRow,
} = require("./db-mongodb");

const {
  calculateShortageQty,
} = require("./routes/shortageHelper");

/*
========================================
AUTHORIZATION HELPERS
========================================
*/

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

/*
========================================
ROUTE MOUNTS
========================================
*/

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
  authorize([
    "dropdown.view",
    "employees.view",
    "expense.entry",
    "expense.view",
    "expense.create",
    "expense.edit",
  ]),
  employeeRoutes
);

app.use(
  "/api/roles",
  authenticate,
  authorize([
    "dropdown.view",
    "employees.view",
    "expense.entry",
    "expense.view",
    "expense.create",
    "expense.edit",
  ]),
  roleRoutes
);

app.use(
  "/api/companies",
  authenticate,
  authorize([
    "dropdown.view",
    "companies.view",
    "companies.manage",
    "expense.entry",
    "expense.view",
    "expense.create",
    "expense.edit",
  ]),
  companiesRoute
);

app.use(
  "/api/company-accounts",
  authenticate,
  authorize([
    "dropdown.view",
    "companyAccounts.view",
    "companyAccounts.manage",
    "expense.entry",
    "expense.view",
    "expense.create",
    "expense.edit",
  ]),
  companyAccountsRoute
);

app.use(
  "/api/warehouses",
  authenticate,
  authorize([
    "dropdown.view",
    "warehouses.view",
    "warehouses.manage",
    "expense.entry",
    "expense.view",
    "expense.create",
    "expense.edit",
  ]),
  warehouseRoutes
);

app.use(
  "/api/products",
  authenticate,
  authorize([
    "dropdown.view",
    "products.view",
    "products.manage",
    "expense.entry",
    "expense.view",
    "expense.create",
    "expense.edit",
  ]),
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
  authorize([
    "dropdown.view",
    "consigneeNames.view",
    "consigneeNames.create",
    "consigneeNames.edit",
    "consigneeNames.delete",
    "outward.view",
    "outward.create",
    "outward.edit",
    "adjustment.manage",
    "expense.entry",
    "expense.view",
    "expense.create",
    "expense.edit",
  ]),
  authorizeConsigneeOrExpense,
  consigneeNamesRoutes
);

app.use(
  "/api/buyer-names",
  authenticate,
  authorize([
    "dropdown.view",
    "buyerNames.view",
    "buyerNames.create",
    "buyerNames.edit",
    "buyerNames.delete",
    "consigneeNames.view",
    "outward.view",
    "outward.create",
    "outward.edit",
    "adjustment.manage",
    "expense.entry",
    "expense.view",
    "expense.create",
    "expense.edit",
  ]),
  authorizeConsigneeOrExpense,
  buyerNamesRoutes
);

app.use(
  "/api/farmers",
  authenticate,
  authorize([
    "dropdown.view",
    "farmers.view",
    "farmers.manage",
    "expense.view",
    "expense.create",
    "expense.edit",
  ]),
  farmersRoutes
);

app.use(
  "/api/warehouse-trading",
  authenticate,
  warehouseTradingRoutes
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
  rentStockMongoRoutes
);

app.use(
  "/api/reports",
  authenticate,
  reportsRoute
);

/*
=====================================================
MONGODB DASHBOARD
=====================================================
*/

app.get(
  "/api/dashboard",
  authenticate,
  authorize("dashboard.view"),
  async (req, res) => {
    try {
      const { user } = req;

      if (
        mongoose.connection.readyState !== 1
      ) {
        return res.status(503).json({
          error:
            "MongoDB is not connected yet",
        });
      }

      const currentMonth =
        new Date()
          .toISOString()
          .slice(0, 7);

      const currentDate =
        new Date()
          .toISOString()
          .slice(0, 10);

      /*
      ========================================
      PERMISSIONS
      ========================================
      */

      const canReadLocations =
        userHasPermission(
          user,
          "dashboard.view"
        ) ||
        userHasPermission(
          user,
          "locations.manage"
        ) ||
        userHasPermission(
          user,
          "expense.entry"
        ) ||
        userHasPermission(
          user,
          "expense.view"
        ) ||
        userHasPermission(
          user,
          "expense.create"
        ) ||
        userHasPermission(
          user,
          "expense.edit"
        ) ||
        userHasPermission(
          user,
          "inward.view"
        ) ||
        userHasPermission(
          user,
          "inward.create"
        ) ||
        userHasPermission(
          user,
          "outward.view"
        ) ||
        userHasPermission(
          user,
          "outward.create"
        ) ||
        userHasPermission(
          user,
          "employees.view"
        ) ||
        userHasPermission(
          user,
          "report.partyStock"
        ) ||
        userHasPermission(
          user,
          "report.warehouseRentLedger"
        ) ||
        userHasPermission(
          user,
          "report.warehouseRentMonthEnd"
        );

      const canReadEmployees =
        userHasPermission(
          user,
          "dashboard.view"
        ) ||
        userHasPermission(
          user,
          "employees.view"
        ) ||
        userHasPermission(
          user,
          "inward.view"
        ) ||
        userHasPermission(
          user,
          "outward.view"
        ) ||
        userHasPermission(
          user,
          "expense.entry"
        ) ||
        userHasPermission(
          user,
          "report.erp"
        );

      const canReadCompanies =
        userHasPermission(
          user,
          "dashboard.view"
        ) ||
        userHasPermission(
          user,
          "companies.manage"
        ) ||
        userHasPermission(
          user,
          "inward.view"
        ) ||
        userHasPermission(
          user,
          "inward.create"
        ) ||
        userHasPermission(
          user,
          "outward.view"
        ) ||
        userHasPermission(
          user,
          "outward.create"
        ) ||
        userHasPermission(
          user,
          "adjustment.manage"
        ) ||
        userHasPermission(
          user,
          "expense.entry"
        ) ||
        userHasPermission(
          user,
          "expense.view"
        ) ||
        userHasPermission(
          user,
          "expense.create"
        ) ||
        userHasPermission(
          user,
          "cash.view"
        ) ||
        userHasPermission(
          user,
          "settlement.view"
        ) ||
        userHasPermission(
          user,
          "report.inward"
        ) ||
        userHasPermission(
          user,
          "report.erp"
        ) ||
        userHasPermission(
          user,
          "report.partyLedger"
        ) ||
        userHasPermission(
          user,
          "report.partyStock"
        ) ||
        userHasPermission(
          user,
          "report.warehouseRentLedger"
        ) ||
        userHasPermission(
          user,
          "report.warehouseRentMonthEnd"
        ) ||
        userHasPermission(
          user,
          "report.outwardSettlement"
        ) ||
        userHasPermission(
          user,
          "report.expense"
        );

      const canReadCompanyAccounts =
        userHasPermission(
          user,
          "dashboard.view"
        ) ||
        userHasPermission(
          user,
          "companyAccounts.manage"
        ) ||
        userHasPermission(
          user,
          "inward.view"
        ) ||
        userHasPermission(
          user,
          "inward.create"
        ) ||
        userHasPermission(
          user,
          "outward.view"
        ) ||
        userHasPermission(
          user,
          "outward.create"
        ) ||
        userHasPermission(
          user,
          "adjustment.manage"
        ) ||
        userHasPermission(
          user,
          "expense.entry"
        ) ||
        userHasPermission(
          user,
          "expense.view"
        ) ||
        userHasPermission(
          user,
          "expense.create"
        ) ||
        userHasPermission(
          user,
          "cash.view"
        ) ||
        userHasPermission(
          user,
          "settlement.view"
        ) ||
        userHasPermission(
          user,
          "report.inward"
        ) ||
        userHasPermission(
          user,
          "report.erp"
        ) ||
        userHasPermission(
          user,
          "report.partyLedger"
        ) ||
        userHasPermission(
          user,
          "report.partyStock"
        ) ||
        userHasPermission(
          user,
          "report.warehouseRentLedger"
        ) ||
        userHasPermission(
          user,
          "report.warehouseRentMonthEnd"
        ) ||
        userHasPermission(
          user,
          "report.outwardSettlement"
        ) ||
        userHasPermission(
          user,
          "report.expense"
        );

      const canReadWarehouses =
        userHasPermission(
          user,
          "dashboard.view"
        ) ||
        userHasPermission(
          user,
          "warehouses.manage"
        ) ||
        userHasPermission(
          user,
          "warehouse.trading.purchase.view"
        ) ||
        userHasPermission(
          user,
          "warehouse.trading.sale.view"
        ) ||
        userHasPermission(
          user,
          "warehouse.trading.payment.view"
        ) ||
        userHasPermission(
          user,
          "warehouse.trading.receipt.view"
        ) ||
        userHasPermission(
          user,
          "warehouse.trading.journal.view"
        ) ||
        userHasPermission(
          user,
          "outward.view"
        ) ||
        userHasPermission(
          user,
          "inward.view"
        );

      const canReadProducts =
        userHasPermission(
          user,
          "dashboard.view"
        ) ||
        userHasPermission(
          user,
          "products.manage"
        ) ||
        userHasPermission(
          user,
          "inward.view"
        ) ||
        userHasPermission(
          user,
          "inward.create"
        ) ||
        userHasPermission(
          user,
          "outward.view"
        ) ||
        userHasPermission(
          user,
          "outward.create"
        ) ||
        userHasPermission(
          user,
          "adjustment.manage"
        ) ||
        userHasPermission(
          user,
          "expense.entry"
        ) ||
        userHasPermission(
          user,
          "expense.view"
        ) ||
        userHasPermission(
          user,
          "expense.create"
        ) ||
        userHasPermission(
          user,
          "transport.manage"
        ) ||
        userHasPermission(
          user,
          "report.inward"
        ) ||
        userHasPermission(
          user,
          "report.erp"
        ) ||
        userHasPermission(
          user,
          "report.partyLedger"
        ) ||
        userHasPermission(
          user,
          "report.partyStock"
        );

      const canReadInwards =
        userHasPermission(
          user,
          "dashboard.view"
        ) ||
        userHasPermission(
          user,
          "inward.manage"
        ) ||
        userHasPermission(
          user,
          "inward.view"
        ) ||
        userHasPermission(
          user,
          "inward.create"
        );

      const canReadOutwards =
        userHasPermission(
          user,
          "dashboard.view"
        ) ||
        userHasPermission(
          user,
          "outward.manage"
        ) ||
        userHasPermission(
          user,
          "outward.view"
        ) ||
        userHasPermission(
          user,
          "outward.create"
        );

      const rentRate = 200;
      const referenceDate =
        currentDate;

      /*
      ========================================
      CALCULATIONS
      ========================================
      */

      const calculateMonthSlab = (
        inwardDateStr,
        refDateStr
      ) => {
        if (!inwardDateStr) {
          return {
            daysDiff: 0,
            monthsDiff: 1,
          };
        }

        const inwardDate =
          new Date(inwardDateStr);

        const refDate =
          new Date(refDateStr);

        if (
          Number.isNaN(
            inwardDate.getTime()
          ) ||
          Number.isNaN(
            refDate.getTime()
          )
        ) {
          return {
            daysDiff: 0,
            monthsDiff: 1,
          };
        }

        const msPerDay =
          1000 *
          60 *
          60 *
          24;

        const daysDiff =
          Math.floor(
            (refDate - inwardDate) /
              msPerDay
          );

        let monthsDiff =
          Math.floor(
            (
              daysDiff <= 0
                ? 0
                : daysDiff - 1
            ) / 30
          ) + 1;

        if (
          monthsDiff < 1
        ) {
          monthsDiff = 1;
        }

        return {
          daysDiff:
            daysDiff < 0
              ? 0
              : daysDiff,
          monthsDiff,
        };
      };

      const firstNonEmptyDate =
        (...values) => {
          for (
            const value of values
          ) {
            const text =
              String(
                value || ""
              ).trim();

            if (
              text &&
              text !== "-" &&
              text.toLowerCase() !==
                "null" &&
              text.toLowerCase() !==
                "undefined"
            ) {
              const parsed =
                new Date(text);

              if (
                !Number.isNaN(
                  parsed.getTime()
                )
              ) {
                return parsed
                  .toISOString()
                  .slice(0, 10);
              }

              return text.slice(
                0,
                10
              );
            }
          }

          return null;
        };

      const calculateAvailableQty =
        (
          weight,
          inwardDate,
          alreadyAdjusted,
          refDate = currentDate,
          shortagePercent = null
        ) => {
          const gross =
            Number(weight) || 0;

          const slab =
            calculateMonthSlab(
              inwardDate,
              refDate
            );

          const shortage =
            calculateShortageQty(
              gross,
              slab.monthsDiff,
              shortagePercent
            );

          return (
            gross -
            shortage -
            Number(
              alreadyAdjusted || 0
            )
          );
        };

      /*
      ========================================
      MONGODB READ
      ========================================
      */

      const [
        locations,
        employees,
        companies,
        companyAccounts,
        warehouses,
        products,
        inwardRows,
        outwardRows,
        adjustmentMirrorRows,
        transportBiltiMirrorRows,
        buyerAdjustmentRows,
        allInwardRows,
      ] = await Promise.all([
        canReadLocations
          ? Location.find({})
              .sort({
                _id: -1,
              })
              .lean()
          : Promise.resolve([]),

        canReadEmployees
          ? Employee.find({})
              .sort({
                _id: -1,
              })
              .lean()
          : Promise.resolve([]),

        canReadCompanies
          ? Company.find({})
              .sort({
                _id: -1,
              })
              .lean()
          : Promise.resolve([]),

        canReadCompanyAccounts
          ? CompanyAccount.find({})
              .sort({
                _id: -1,
              })
              .lean()
          : Promise.resolve([]),

        canReadWarehouses
          ? Warehouse.find({})
              .sort({
                _id: -1,
              })
              .lean()
          : Promise.resolve([]),

        canReadProducts
          ? Product.find({})
              .sort({
                _id: -1,
              })
              .lean()
          : Promise.resolve([]),

        canReadInwards
          ? Inward.find({})
              .sort({
                date: -1,
                _id: -1,
              })
              .limit(200)
              .lean()
          : Promise.resolve([]),

        canReadOutwards
          ? Outward.find({})
              .sort({
                date: -1,
                _id: -1,
              })
              .limit(200)
              .lean()
          : Promise.resolve([]),

        Adjustment.find({})
          .sort({
            createdAt: -1,
            _id: -1,
          })
          .lean(),

        MirrorRow.find({
          table:
            "transport_bilti",
        })
          .select({
            table: 1,
            row_id: 1,
            data: 1,
          })
          .sort({
            row_id: 1,
          })
          .lean(),

        BuyerAdjustment.find({})
          .sort({
            unloading_date: -1,
            _id: -1,
          })
          .lean(),

        canReadInwards
          ? Inward.find({})
              .sort({
                date: 1,
                _id: 1,
              })
              .lean()
          : Promise.resolve([]),
      ]);

      /*
      ========================================
      LIST PAYLOAD
      ========================================
      */

      const listPayload = {
        locations:
          normalizeDashboardList(
            locations
          ).map((item) => ({
            ...item,

            id:
              item.id ??
              item.legacy_id ??
              item._id,

            name:
              item.name ||
              item.account_name ||
              "",
          })),

        employees:
          normalizeDashboardList(
            employees
          ).map((item) => ({
            ...item,

            id:
              item.id ??
              item.legacy_id ??
              item._id,

            name:
              item.name || "",
          })),

        companies:
          normalizeDashboardList(
            companies
          ).map((item) => ({
            ...item,

            id:
              item.id ??
              item.legacy_id ??
              item._id,

            name:
              item.name || "",
          })),

        companyAccounts:
          normalizeDashboardList(
            companyAccounts
          ).map((item) => ({
            ...item,

            id:
              item.id ??
              item.legacy_id ??
              item._id,

            name:
              item.account_name ||
              item.name ||
              "",
          })),

        warehouses:
          normalizeDashboardList(
            warehouses
          ).map((item) => ({
            ...item,

            id:
              item.id ??
              item.legacy_id ??
              item._id,

            name:
              item.name || "",
          })),

        products:
          normalizeDashboardList(
            products
          ).map((item) => ({
            ...item,

            id:
              item.id ??
              item.legacy_id ??
              item._id,

            name:
              item.name || "",
          })),

        inwards:
          normalizeDashboardList(
            inwardRows
          ).map((item) => ({
            ...item,

            id:
              item.legacy_id ??
              item.id ??
              item._id,

            voucher_no:
              item.voucher_no ||
              item.inward_no ||
              item.inwardNo ||
              item.voucherNo ||
              "",

            date:
              item.date
                ? new Date(
                    item.date
                  )
                    .toISOString()
                    .slice(0, 10)
                : "",

            company_name:
              item.company_name ||
              item.company ||
              "",

            account_name:
              item.company_account_name ||
              item.company_account ||
              item.account_name ||
              "",

            weight:
              item.weight ??
              item.quantity ??
              0,
          })),

        outwards:
          normalizeDashboardList(
            outwardRows
          ).map((item) => ({
            ...item,

            id:
              item.legacy_id ??
              item.id ??
              item._id,

            inv_no:
              item.inv_no ||
              item.outward_no ||
              item.outwardNo ||
              item.invoice_no ||
              item.voucher_no ||
              item.voucherNo ||
              "",

            date:
              item.date
                ? new Date(
                    item.date
                  )
                    .toISOString()
                    .slice(0, 10)
                : "",

            party_name:
              item.party_name ||
              item.buyer_name ||
              item.buyer ||
              item.company_name ||
              item.company ||
              "",

            company_name:
              item.company_name ||
              item.company ||
              "",

            account_name:
              item.company_account_name ||
              item.company_account ||
              item.account_name ||
              "",

            weight:
              item.weight ??
              item.quantity ??
              0,
          })),
      };

      /*
      ========================================
      LEGACY MIRROR DATA
      ========================================
      */

      const adjustmentRows =
        (
          adjustmentMirrorRows ||
          []
        ).map(
          (mirror) => ({
            ...(mirror?.data ||
              {}),

            id:
              mirror?.row_id,
          })
        );

      const transportBiltiRows =
        (
          transportBiltiMirrorRows ||
          []
        ).map(
          (mirror) => ({
            ...(mirror?.data ||
              {}),

            id:
              mirror?.row_id,
          })
        );

      /*
      ========================================
      BUYER UNLOADING DATE MAP
      ========================================
      */

      const unloadingDateMap =
        {};

      (
        buyerAdjustmentRows ||
        []
      ).forEach(
        (row) => {
          const outwardId =
            String(
              row?.outward_id ??
                ""
            ).trim();

          if (!outwardId) {
            return;
          }

          const date =
            firstNonEmptyDate(
              row?.unloading_date,
              row?.created_at
            );

          if (!date) {
            return;
          }

          if (
            !unloadingDateMap[
              outwardId
            ] ||
            date >
              unloadingDateMap[
                outwardId
              ]
          ) {
            unloadingDateMap[
              outwardId
            ] = date;
          }
        }
      );

      /*
      ========================================
      TRANSPORT DISPATCH DATE MAP
      ========================================
      */

      const dispatchDateMap =
        {};

      (
        transportBiltiRows ||
        []
      ).forEach(
        (row) => {
          const outwardId =
            String(
              row?.outward_id ??
                ""
            ).trim();

          if (!outwardId) {
            return;
          }

          const date =
            firstNonEmptyDate(
              row?.dispatch_date,
              row?.created_at
            );

          if (!date) {
            return;
          }

          if (
            !dispatchDateMap[
              outwardId
            ] ||
            date >
              dispatchDateMap[
                outwardId
              ]
          ) {
            dispatchDateMap[
              outwardId
            ] = date;
          }
        }
      );

      /*
      ========================================
      OUTWARD DATE MAP
      ========================================
      */

      const outwardDateMap =
        {};

      (
        outwardRows ||
        []
      ).forEach(
        (row) => {
          const outwardId =
            String(
              row?.legacy_id ??
                row?.id ??
                row?._id ??
                ""
            );

          if (!outwardId) {
            return;
          }

          outwardDateMap[
            outwardId
          ] =
            row?.date
              ? firstNonEmptyDate(
                  row.date
                )
              : null;
        }
      );

      /*
      ========================================
      ADJUSTMENT MAP
      ========================================
      */

      const adjustmentMap =
        {};

      (
        adjustmentRows ||
        []
      ).forEach(
        (item) => {
          const inwardId =
            String(
              item?.inward_id ??
                ""
            ).trim();

          if (!inwardId) {
            return;
          }

          if (
            !adjustmentMap[
              inwardId
            ]
          ) {
            adjustmentMap[
              inwardId
            ] = [];
          }

          const outwardId =
            String(
              item?.outward_id ??
                ""
            ).trim();

          adjustmentMap[
            inwardId
          ].push({
            ...item,

            outward_date:
              outwardDateMap[
                outwardId
              ] || null,

            transport_dispatch_date:
              dispatchDateMap[
                outwardId
              ] || null,

            buyer_unloading_date:
              unloadingDateMap[
                outwardId
              ] || null,
          });
        }
      );

      /*
      ========================================
      RENT / STOCK CALCULATION
      ========================================
      */

      const rentDetailedRows =
        [];

      (
        allInwardRows ||
        []
      ).forEach(
        (row) => {
          const originalWeight =
            Number(
              row?.weight ??
                row?.quantity ??
                0
            ) || 0;

          const rowId =
            row?.legacy_id ??
            row?.id ??
            row?._id;

          const inwardDate =
            firstNonEmptyDate(
              row?.date
            );

          if (!inwardDate) {
            return;
          }

          const adjustments =
            adjustmentMap[
              String(rowId)
            ] || [];

          const slab =
            calculateMonthSlab(
              inwardDate,
              referenceDate
            );

          let adjustedQty =
            0;

          let adjustedRentAmount =
            0;

          let lastDispatchDate =
            null;

          adjustments.forEach(
            (adj) => {
              const adjustmentDate =
                firstNonEmptyDate(
                  adj?.transport_dispatch_date,
                  adj?.buyer_unloading_date,
                  adj?.outward_date,
                  adj?.created_at
                );

              if (
                !adjustmentDate ||
                adjustmentDate >
                  referenceDate
              ) {
                return;
              }

              const qty =
                Number(
                  adj?.qty
                ) || 0;

              adjustedQty +=
                qty;

              const adjustmentSlab =
                calculateMonthSlab(
                  inwardDate,
                  adjustmentDate
                );

              adjustedRentAmount +=
                qty *
                rentRate *
                adjustmentSlab.monthsDiff;

              if (
                !lastDispatchDate ||
                adjustmentDate >
                  lastDispatchDate
              ) {
                lastDispatchDate =
                  adjustmentDate;
              }
            }
          );

          const shortageQty =
            calculateShortageQty(
              originalWeight,
              slab.monthsDiff,
              row?.shortage_percent
            );

          const balanceQty =
            Math.max(
              calculateAvailableQty(
                originalWeight,
                inwardDate,
                adjustedQty,
                referenceDate,
                row?.shortage_percent
              ),
              0
            );

          const balanceRentAmount =
            balanceQty *
            rentRate *
            slab.monthsDiff;

          rentDetailedRows.push({
            id:
              rowId,

            party_name:
              row?.company_account_name ||
              row?.company_name ||
              row?.company_account ||
              row?.company ||
              "Unknown",

            warehouse_name:
              row?.warehouse_name ||
              "-",

            location:
              row?.location_name ||
              row?.location ||
              "-",

            voucher_no:
              row?.voucher_no ||
              row?.inward_no ||
              "",

            lorry_no:
              row?.lorry_no ||
              "",

            original_weight:
              Number(
                originalWeight.toFixed(
                  4
                )
              ),

            shortage_qty:
              Number(
                shortageQty.toFixed(
                  4
                )
              ),

            adjusted_qty:
              Number(
                adjustedQty.toFixed(
                  4
                )
              ),

            balance_qty:
              Number(
                balanceQty.toFixed(
                  4
                )
              ),

            total_rent:
              Number(
                (
                  adjustedRentAmount +
                  balanceRentAmount
                ).toFixed(2)
              ),

            total_entries:
              1,

            dispatch_date:
              lastDispatchDate ||
              null,
          });
        }
      );

      /*
      ========================================
      PARTY STOCK SUMMARY
      ========================================
      */

      const partyStockSummary =
        normalizeDashboardSummary({
          summary:
            rentDetailedRows.map(
              (row) => ({
                party_name:
                  row.party_name,

                warehouse_name:
                  row.warehouse_name,

                gross_qty:
                  row.original_weight,

                shortage_qty:
                  row.shortage_qty,

                net_opening_qty:
                  row.original_weight,

                already_adjusted_qty:
                  row.adjusted_qty,

                available_balance_qty:
                  row.balance_qty,
              })
            ),
        });

      /*
      ========================================
      WAREHOUSE STOCK SUMMARY
      ========================================
      */

      const warehouseStockSummary =
        normalizeDashboardSummary({
          summary:
            rentDetailedRows.map(
              (row) => ({
                warehouse:
                  row.warehouse_name,

                party:
                  row.party_name,

                location:
                  row.location ||
                  "-",

                stock:
                  row.balance_qty,
              })
            ),
        });

      /*
      ========================================
      TOTAL STOCK
      ========================================
      */

      const totalStockValue =
        rentDetailedRows.reduce(
          (sum, row) =>
            sum +
            Number(
              row?.balance_qty ||
                0
            ),
          0
        );

      /*
      ========================================
      MONTH END RENT SUMMARY
      ========================================
      */

      const monthEndRentSummary =
        normalizeDashboardSummary({
          summary:
            rentDetailedRows.map(
              (row) => ({
                party_name:
                  row.party_name,

                warehouse_name:
                  row.warehouse_name,

                total_rent:
                  row.total_rent,

                total_entries:
                  row.total_entries,

                voucher_no:
                  row.voucher_no,

                lorry_no:
                  row.lorry_no,

                original_weight:
                  row.original_weight,

                adjusted_qty:
                  row.adjusted_qty,

                shortage_qty:
                  row.shortage_qty,

                balance_qty:
                  row.balance_qty,
              })
            ),
        });

      /*
      ========================================
      RESPONSE
      ========================================
      */

      return res.json({
        ...listPayload,

        partyStock:
          partyStockSummary,

        warehouseStock:
          warehouseStockSummary,

        totalStock:
          totalStockValue,

        monthEndRentSummary,

        meta: {
          currentMonth,
          currentDate,
          source:
            "mongodb",
        },
      });
    } catch (error) {
      console.error(
        "Failed to load MongoDB dashboard payload:",
        error
      );

      return res.status(500).json({
        error:
          error.message,
      });
    }
  }
);

/*
========================================
OTHER ROUTES
========================================
*/

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
  authorize(
    "adjustment.manage"
  ),
  adjustmentRoutes
);

app.use(
  "/api/buyer-adjustment",
  authenticate,
  authorize([
    "outward.view",
    "outward.create",
    "outward.edit",
    "adjustment.manage",
  ]),
  buyerAdjustmentRoutes
);

app.use(
  "/api/stock",
  authenticate,
  authorize("dashboard.view"),
  rentStockMongoRoutes
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
  authorize(
    "settlement.view"
  ),
  outwardSettlementRoutes
);

app.use(
  "/api/transporters",
  authenticate,
  authorize(
    "transport.manage"
  ),
  transportersRoutes
);

app.use(
  "/api/transport-bilti",
  authenticate,
  authorize(
    "transport.manage"
  ),
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
  authorize(
    "expense.palti"
  ),
  paltiLorryRoutes
);

app.use(
  "/api/self-loading",
  authenticate,
  authorize(
    "expense.selfLoading"
  ),
  selfLoadingRoutes
);

app.use(
  "/api/local-sale",
  authenticate,
  authorize(
    "expense.localSale"
  ),
  localSaleRoutes
);

app.use(
  "/api/cash-entries",
  authenticate,
  authorizeCashEntries,
  cashEntriesRoutes
);

app.use(
  "/api/mongo-health",
  mongoHealthRoutes
);

/*
========================================
ROOT
========================================
*/

app.get(
  "/",
  (req, res) => {
    res.send(
      "Backend Running OK"
    );
  }
);

/*
========================================
ERROR HANDLER
========================================
*/

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

    const origin =
      req.headers.origin;

    if (origin) {
      res.setHeader(
        "Access-Control-Allow-Origin",
        origin
      );

      res.setHeader(
        "Access-Control-Allow-Credentials",
        "true"
      );

      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS"
      );

      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type,Authorization,Accept,Origin,X-Requested-With,Cache-Control,Pragma"
      );

      res.setHeader(
        "Vary",
        "Origin"
      );
    }

    return res.status(500).json({
      error:
        "Something went wrong",
    });
  }
);

/*
========================================
SERVER
========================================
*/

const PORT = Number(
  process.env.PORT || 4001
);

const HOST =
  process.env.HOST ||
  "0.0.0.0";

function startServer(port) {
  const server = app.listen(
    port,
    HOST,
    () => {
      console.log(
        `Backend running on ${process.env.RENDER_EXTERNAL_URL || `${HOST}:${port}`}`
      );
    }
  );

  server.on("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      const nextPort = port + 1;
      console.warn(
        `Port ${port} is already in use. Trying ${nextPort}...`
      );
      server.close(() => startServer(nextPort));
      return;
    }

    throw err;
  });
}

startServer(PORT);

