const express = require("express");

const router = express.Router();

const {
  mongoose,
  isMongoMirrorReady,
  Warehouse,
  Employee,
  Product,
  Company,
  ConsigneeName,
  Expense,
} = require("../db-mongodb");

const {
  userHasPermission,
} = require("../middleware/auth");

/*
====================================================
HELPERS
====================================================
*/

function requireMongo(res) {
  if (!isMongoMirrorReady()) {
    res.status(503).json({
      error:
        "MongoDB is not connected. Please try again in a moment.",
    });

    return false;
  }

  return true;
}

function rawCollection() {
  if (!mongoose.connection.db) {
    throw new Error(
      "MongoDB database handle is not available"
    );
  }

  return mongoose.connection.db.collection(
    "paltilorryentries"
  );
}

function normalizeId(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return "";
  }

  return String(value).trim();
}

function mapById(rows) {
  const map = new Map();

  for (const row of rows || []) {
    if (!row) continue;

    if (row._id) {
      map.set(
        String(row._id),
        row
      );
    }

    if (
      row.id !== undefined &&
      row.id !== null &&
      row.id !== ""
    ) {
      map.set(
        String(row.id),
        row
      );
    }

    if (
      row.legacy_id !== undefined &&
      row.legacy_id !== null &&
      row.legacy_id !== ""
    ) {
      map.set(
        String(row.legacy_id),
        row
      );
    }

    if (
      row.employee_id !== undefined &&
      row.employee_id !== null &&
      row.employee_id !== ""
    ) {
      map.set(
        String(row.employee_id),
        row
      );
    }
  }

  return map;
}

/*
====================================================
ASSIGNED WAREHOUSE FILTER
====================================================
*/

function getAssignedWarehouseIds(user) {
  const raw =
    user?.assigned_warehouse_ids;

  if (!Array.isArray(raw)) {
    return [];
  }

  return Array.from(
    new Set(
      raw
        .map(normalizeId)
        .filter(Boolean)
    )
  );
}

function hasGlobalWarehouseAccess(user) {
  return (
    userHasPermission(
      user,
      "all"
    ) ||
    userHasPermission(
      user,
      "warehouses.manage"
    ) ||
    userHasPermission(
      user,
      "report.partyStock"
    ) ||
    userHasPermission(
      user,
      "report.partyLedger"
    ) ||
    userHasPermission(
      user,
      "report.warehouseRentLedger"
    ) ||
    userHasPermission(
      user,
      "report.warehouseRentMonthEnd"
    )
  );
}

function canSeeWarehouse(
  user,
  warehouseId
) {
  if (
    hasGlobalWarehouseAccess(
      user
    )
  ) {
    return true;
  }

  const assigned =
    getAssignedWarehouseIds(
      user
    );

  if (!assigned.length) {
    return true;
  }

  const currentId =
    normalizeId(
      warehouseId
    );

  return assigned.includes(
    currentId
  );
}

/*
====================================================
MONGO ID QUERY
====================================================
*/

function buildIdConditions(value) {
  const raw =
    normalizeId(value);

  if (!raw) {
    return [];
  }

  const conditions = [];

  if (
    mongoose.Types.ObjectId.isValid(
      raw
    )
  ) {
    conditions.push({
      _id:
        new mongoose.Types.ObjectId(
          raw
        ),
    });
  }

  const numeric =
    Number(raw);

  if (
    Number.isFinite(
      numeric
    )
  ) {
    conditions.push({
      legacy_id:
        numeric,
    });

    conditions.push({
      id:
        numeric,
    });

    conditions.push({
      sl_no:
        numeric,
    });
  }

  return conditions;
}

function buildIdFilter(value) {
  const conditions =
    buildIdConditions(
      value
    );

  if (!conditions.length) {
    return null;
  }

  if (
    conditions.length ===
    1
  ) {
    return conditions[0];
  }

  return {
    $or:
      conditions,
  };
}

async function findFlexible(
  Model,
  value
) {
  const filter =
    buildIdFilter(
      value
    );

  if (!filter) {
    return null;
  }

  return Model.findOne(
    filter
  ).lean();
}

/*
====================================================
MASTER DECORATION
====================================================
*/

async function decorateRows(
  rows
) {
  if (!rows.length) {
    return [];
  }

  const [
    warehouses,
    employees,
    products,
    companies,
    consignees,
  ] =
    await Promise.all([
      Warehouse.find({})
        .lean(),

      Employee.find({})
        .lean(),

      Product.find({})
        .lean(),

      Company.find({})
        .lean(),

      ConsigneeName.find({})
        .lean(),
    ]);

  const warehouseMap =
    mapById(
      warehouses
    );

  const employeeMap =
    mapById(
      employees
    );

  const productMap =
    mapById(
      products
    );

  const companyMap =
    mapById(
      companies
    );

  const consigneeMap =
    mapById(
      consignees
    );

  return rows.map(
    (row) => {
      const warehouse =
        warehouseMap.get(
          normalizeId(
            row.warehouse_id
          )
        ) || {};

      const employee =
        employeeMap.get(
          normalizeId(
            row.employee_id
          )
        ) || {};

      const product =
        productMap.get(
          normalizeId(
            row.product_id
          )
        ) || {};

      const company =
        companyMap.get(
          normalizeId(
            row.company_id
          )
        ) || {};

      const consignee =
        consigneeMap.get(
          normalizeId(
            row.reg_from_consignee_id
          )
        ) || {};

      const regFromCompany =
        companyMap.get(
          normalizeId(
            row.reg_from_company_id
          )
        ) || {};

      return {
        ...row,

        id:
          row._id
            ? String(
                row._id
              )
            : (
              row.id ??
              row.legacy_id ??
              row.sl_no
            ),

        mongo_id:
          row._id
            ? String(
                row._id
              )
            : null,

        warehouse_name:
          row.warehouse_name ||
          warehouse.name ||
          "",

        employee_name:
          row.employee_name ||
          employee.name ||
          "",

        product_name:
          row.product_name ||
          product.name ||
          "",

        company_name:
          row.company_name ||
          company.name ||
          "",

        reg_from_name:
          row.reg_from_name ||
          consignee.name ||
          regFromCompany.name ||
          "",

        display_lorry_no:
          row.new_lorry_no ||
          row.reg_lorry_no ||
          "-",

        saved_from:
          "mongodb",
      };
    }
  );
}

/*
====================================================
GET PALTI LORRY
====================================================
*/

router.get(
  "/",
  async (req, res) => {
    try {
      if (
        !userHasPermission(
          req.user,
          "expense.palti"
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to view Palti Lorry entries",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const [
        posted,
        expenses,
      ] =
        await Promise.all([
          rawCollection()
            .find({})
            .sort({
              expense_date: -1,
              _id: -1,
            })
            .toArray(),

          Expense.find({
            $or: [
              {
                send_to_kind:
                  "palti_lorry",
              },

              {
                work_description:
                  {
                    $regex:
                      /^palti lorry$/i,
                  },
              },
            ],
          })
            .sort({
              expense_date: -1,
              _id: -1,
            })
            .lean(),
        ]);

      /*
       * Warehouse access filter.
       */
      const filteredPosted =
        posted.filter(
          (row) =>
            canSeeWarehouse(
              req.user,
              row.warehouse_id
            )
        );

      const filteredExpenses =
        expenses.filter(
          (row) =>
            canSeeWarehouse(
              req.user,
              row.warehouse_id
            )
        );

      const decoratedPosted =
        await decorateRows(
          filteredPosted
        );

      const postedRows =
        decoratedPosted.map(
          (row) => ({
            ...row,

            entry_status:
              "posted",
          })
        );

      /*
       * Avoid showing the same expense again
       * after it has already been posted to
       * palti_lorry_entries.
       */
      const postedExpenseIds =
        new Set(
          filteredPosted
            .map(
              (row) =>
                String(
                  row.expense_id ??
                    ""
                )
            )
            .filter(Boolean)
        );

      const expenseRows =
        [];

      for (
        const expense of
          filteredExpenses
      ) {
        const expenseId =
          expense.legacy_id ??
          expense.id ??
          (
            expense._id
              ? String(
                  expense._id
                )
              : null
          );

        if (
          expenseId !==
            null &&
          postedExpenseIds.has(
            String(
              expenseId
            )
          )
        ) {
          continue;
        }

        expenseRows.push({
          ...expense,

          id:
            expense._id
              ? String(
                  expense._id
                )
              : expenseId,

          mongo_id:
            expense._id
              ? String(
                  expense._id
                )
              : null,

          expense_id:
            expenseId,

          display_lorry_no:
            expense.new_lorry_no ||
            expense.reg_lorry_no ||
            "-",

          entry_status:
            "expense",

          saved_from:
            "mongodb",
        });
      }

      const decoratedExpenses =
        await decorateRows(
          expenseRows
        );

      const rows = [
        ...postedRows,
        ...decoratedExpenses,
      ];

      rows.sort(
        (a, b) => {
          const dateA =
            String(
              a.expense_date ||
                a.date ||
                ""
            );

          const dateB =
            String(
              b.expense_date ||
                b.date ||
                ""
            );

          const dateCompare =
            dateB.localeCompare(
              dateA
            );

          if (
            dateCompare !==
            0
          ) {
            return dateCompare;
          }

          return String(
            b.id || ""
          ).localeCompare(
            String(
              a.id || ""
            ),
            undefined,
            {
              numeric:
                true,
            }
          );
        }
      );

      return res.json(
        rows
      );
    } catch (err) {
      console.error(
        "Mongo palti fetch failed:",
        err
      );

      return res.status(500).json({
        error:
          err.message,
      });
    }
  }
);

module.exports = router;
