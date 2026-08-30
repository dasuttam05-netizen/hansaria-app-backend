const express = require("express");
const router = express.Router();

const {
  Outward,
  Expense,
  Warehouse,
  Product,
  Company,
  CompanyAccount,
  Location,
  Employee,
  isMongoMirrorReady,
} = require("../db-mongodb");

const {
  userHasPermission,
} = require("../middleware/auth");

/*
====================================================
MONGO CHECK
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

/*
====================================================
ID NORMALIZATION
====================================================
*/

function normalizeId(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  return String(value).trim();
}

function buildIdMap(rows = []) {
  const map = new Map();

  for (const row of rows) {
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
ASSIGNED WAREHOUSE ACCESS
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
        .map((value) =>
          normalizeId(
            value
          )
        )
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

  return assigned.includes(
    normalizeId(
      warehouseId
    )
  );
}

/*
====================================================
EXPENSE LOOKUP
====================================================
*/

async function getSelfLoadingExpenseMap(
  outwardDocs
) {
  const outwardIds =
    Array.from(
      new Set(
        outwardDocs
          .map(
            (row) =>
              row?.legacy_id ??
              row?.id ??
              row?.sl_no
          )
          .filter(
            (value) =>
              value !==
                undefined &&
              value !==
                null &&
              value !== ""
          )
          .map(Number)
          .filter(
            Number.isFinite
          )
      )
    );

  if (!outwardIds.length) {
    return new Map();
  }

  const expenses =
    await Expense.find({
      outward_id: {
        $in:
          outwardIds,
      },

      work_description: {
        $regex:
          /^Self Loading$/i,
      },
    })
      .sort({
        created_at: -1,
        _id: -1,
      })
      .lean();

  const map =
    new Map();

  for (const expense of expenses) {
    const key =
      String(
        expense.outward_id
      );

    if (
      map.has(key)
    ) {
      continue;
    }

    map.set(
      key,
      expense
    );
  }

  return map;
}

/*
====================================================
GET SELF LOADING
====================================================
*/

router.get(
  "/",
  async (req, res) => {
    try {
      if (
        !userHasPermission(
          req.user,
          "expense.selfLoading"
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to view Self Loading entries",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      /*
       * Self Loading outward records.
       * Support:
       * Yes / yes / true / "true"
       */
      const outwardDocs =
        await Outward.find({
          $or: [
            {
              self_loading:
                "Yes",
            },

            {
              self_loading:
                "yes",
            },

            {
              self_loading:
                true,
            },

            {
              self_loading:
                "true",
            },
          ],
        })
          .sort({
            date: -1,
            legacy_id: -1,
            _id: -1,
          })
          .lean();

      /*
       * Remove rows belonging to warehouses
       * the current user cannot access.
       */
      const filteredOutwardDocs =
        outwardDocs.filter(
          (row) =>
            canSeeWarehouse(
              req.user,
              row.warehouse_id
            )
        );

      if (
        !filteredOutwardDocs.length
      ) {
        return res.json([]);
      }

      /*
       * Load master data.
       */
      const [
        warehouses,
        locations,
        employees,
        products,
        companies,
        accounts,
      ] =
        await Promise.all([
          Warehouse.find({})
            .lean(),

          Location.find({})
            .lean(),

          Employee.find({})
            .lean(),

          Product.find({})
            .lean(),

          Company.find({})
            .lean(),

          CompanyAccount.find({})
            .lean(),
        ]);

      const warehouseMap =
        buildIdMap(
          warehouses
        );

      const locationMap =
        buildIdMap(
          locations
        );

      const employeeMap =
        buildIdMap(
          employees
        );

      const productMap =
        buildIdMap(
          products
        );

      const companyMap =
        buildIdMap(
          companies
        );

      const accountMap =
        buildIdMap(
          accounts
        );

      /*
       * Related Self Loading expense.
       */
      const expenseMap =
        await getSelfLoadingExpenseMap(
          filteredOutwardDocs
        );

      const result =
        filteredOutwardDocs.map(
          (outward) => {
            const warehouse =
              warehouseMap.get(
                normalizeId(
                  outward.warehouse_id
                )
              ) || {};

            const locationId =
              normalizeId(
                outward.location_id
              ) ||
              normalizeId(
                warehouse.location_id
              );

            const location =
              locationMap.get(
                locationId
              ) || {};

            const employee =
              employeeMap.get(
                normalizeId(
                  outward.employee_id
                )
              ) || {};

            const product =
              productMap.get(
                normalizeId(
                  outward.product_id
                )
              ) || {};

            const company =
              companyMap.get(
                normalizeId(
                  outward.company_id
                )
              ) || {};

            const account =
              accountMap.get(
                normalizeId(
                  outward.company_account_id
                )
              ) || {};

            const outwardLegacyId =
              outward.legacy_id ??
              outward.id ??
              outward.sl_no;

            const expense =
              expenseMap.get(
                String(
                  outwardLegacyId
                )
              ) || null;

            return {
              ...outward,

              id:
                outward._id
                  ? String(
                      outward._id
                    )
                  : outwardLegacyId,

              legacy_id:
                outward.legacy_id ??
                null,

              mongo_id:
                outward._id
                  ? String(
                      outward._id
                    )
                  : null,

              expense_id:
                expense?.id ??
                expense?.legacy_id ??
                (
                  expense?._id
                    ? String(
                        expense._id
                      )
                    : null
                ),

              expense_voucher_no:
                expense?.voucher_no ||
                null,

              warehouse_name:
                warehouse.name ||
                outward.warehouse_name ||
                "",

              location_name:
                location.name ||
                outward.location_name ||
                "",

              employee_name:
                employee.name ||
                outward.employee_name ||
                "",

              product_name:
                product.name ||
                outward.product_name ||
                outward.product ||
                "",

              company_name:
                company.name ||
                outward.company_name ||
                "",

              party_name:
                account.account_name ||
                outward.party_name ||
                outward.company_account_name ||
                outward.company_name ||
                "",

              saved_from:
                "mongodb",
            };
          }
        );

      return res.json(
        result
      );
    } catch (err) {
      console.error(
        "Mongo self loading fetch failed:",
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
