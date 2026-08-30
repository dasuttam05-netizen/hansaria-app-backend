const express = require("express");
const router = express.Router();

const { userHasPermission } = require("../middleware/auth");
const {
  Expense,
  isMongoMirrorReady,
  Company,
  Warehouse,
  Product,
  Employee,
  Location,
} = require("../db-mongodb");

const {
  canAccessWarehouse,
} = require("../helpers/access");

router.get("/", async (req, res) => {
  if (
    !userHasPermission(
      req.user,
      "expense.localSale"
    )
  ) {
    return res.status(403).json({
      error:
        "You do not have permission to view Local Sale entries",
    });
  }

  if (!isMongoMirrorReady()) {
    return res.status(503).json({
      error:
        "MongoDB is not connected. Local Sale is now MongoDB-only.",
    });
  }

  try {
    const docs = await Expense.find({
      work_description: "Local Sale",
    })
      .sort({
        expense_date: -1,
        legacy_id: -1,
        _id: -1,
      })
      .lean();

    const [
      warehouses,
      employees,
      products,
      companies,
      locations,
    ] = await Promise.all([
      Warehouse.find({}).lean(),
      Employee.find({}).lean(),
      Product.find({}).lean(),
      Company.find({}).lean(),
      Location.find({}).lean(),
    ]);

    const mapByIds = (rows) =>
      new Map(
        rows.flatMap((row) =>
          [
            [String(row?._id || ""), row],
            [String(row?.id ?? ""), row],
            [String(row?.legacy_id ?? ""), row],
          ].filter(
            ([key]) =>
              key &&
              key !== "undefined" &&
              key !== "null"
          )
        )
      );

    const warehouseMap =
      mapByIds(warehouses);

    const employeeMap =
      mapByIds(employees);

    const productMap =
      mapByIds(products);

    const companyMap =
      mapByIds(companies);

    const locationMap =
      mapByIds(locations);

    const visibleDocs = docs.filter(
      (row) => {
        const warehouseId =
          row?.warehouse_id;

        if (
          warehouseId === undefined ||
          warehouseId === null ||
          warehouseId === ""
        ) {
          return true;
        }

        return canAccessWarehouse(
          req.user,
          warehouseId
        );
      }
    );

    return res.json(
      visibleDocs.map((row) => {
        const warehouse =
          warehouseMap.get(
            String(row?.warehouse_id || "")
          ) || {};

        const employee =
          employeeMap.get(
            String(row?.employee_id || "")
          ) || {};

        const product =
          productMap.get(
            String(row?.product_id || "")
          ) || {};

        const company =
          companyMap.get(
            String(row?.company_id || "")
          ) || {};

        const location =
          locationMap.get(
            String(
              row?.location_id ||
                row?.warehouse_location_id ||
                ""
            )
          ) || {};

        return {
          ...row,

          id: String(
            row?._id ||
              row?.id ||
              row?.legacy_id ||
              ""
          ),

          warehouse_name:
            row?.warehouse_name ||
            warehouse?.name ||
            "",

          employee_name:
            row?.employee_name ||
            employee?.name ||
            "",

          product_name:
            row?.product_name ||
            product?.name ||
            "",

          company_name:
            row?.company_name ||
            company?.name ||
            "",

          location_name:
            row?.location_name ||
            location?.name ||
            "",

          saved_from:
            "mongodb",
        };
      })
    );
  } catch (err) {
    console.error(
      "Mongo local sale fetch failed:",
      err
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

module.exports = router;
