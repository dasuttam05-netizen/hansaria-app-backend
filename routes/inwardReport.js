const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const {
  Inward,
  Employee,
  Location,
  Warehouse,
  Product,
  Company,
  CompanyAccount,
  isMongoMirrorReady,
} = require("../db-mongodb");

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

function normalizeId(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const raw = String(value).trim();

  if (!raw) {
    return null;
  }

  return raw;
}

function buildIdConditions(value) {
  const raw = normalizeId(value);

  if (!raw) {
    return [];
  }

  const conditions = [];

  if (mongoose.Types.ObjectId.isValid(raw)) {
    conditions.push({
      _id: new mongoose.Types.ObjectId(raw),
    });
  }

  const numeric = Number(raw);

  if (Number.isFinite(numeric)) {
    conditions.push({
      legacy_id: numeric,
    });

    conditions.push({
      id: numeric,
    });

    conditions.push({
      sl_no: numeric,
    });
  }

  return conditions;
}

async function findByLegacyOrObjectId(Model, value) {
  const conditions = buildIdConditions(value);

  if (!conditions.length) {
    return null;
  }

  return Model.findOne({
    $or: conditions,
  }).lean();
}

function buildDateFilter(fromDate, toDate) {
  const filter = {};

  if (fromDate) {
    const start = new Date(`${fromDate}T00:00:00`);

    if (!Number.isNaN(start.getTime())) {
      filter.$gte = start;
    }
  }

  if (toDate) {
    const end = new Date(`${toDate}T23:59:59.999`);

    if (!Number.isNaN(end.getTime())) {
      filter.$lte = end;
    }
  }

  return Object.keys(filter).length
    ? filter
    : null;
}

async function resolveNames(rows) {
  if (!rows.length) {
    return [];
  }

  const employeeIds = new Set();
  const locationIds = new Set();
  const warehouseIds = new Set();
  const productIds = new Set();
  const companyIds = new Set();
  const accountIds = new Set();

  for (const row of rows) {
    if (row.employee_id != null) {
      employeeIds.add(
        String(row.employee_id)
      );
    }

    if (row.location_id != null) {
      locationIds.add(
        String(row.location_id)
      );
    }

    if (row.warehouse_id != null) {
      warehouseIds.add(
        String(row.warehouse_id)
      );
    }

    if (row.product_id != null) {
      productIds.add(
        String(row.product_id)
      );
    }

    if (row.company_id != null) {
      companyIds.add(
        String(row.company_id)
      );
    }

    if (row.company_account_id != null) {
      accountIds.add(
        String(row.company_account_id)
      );
    }
  }

  async function loadMap(Model, values) {
    const all = Array.from(values);

    if (!all.length) {
      return new Map();
    }

    const conditions = [];

    const objectIds = all
      .filter((id) =>
        mongoose.Types.ObjectId.isValid(id)
      )
      .map(
        (id) =>
          new mongoose.Types.ObjectId(id)
      );

    const numericIds = all
      .map(Number)
      .filter((id) => Number.isFinite(id));

    if (objectIds.length) {
      conditions.push({
        _id: {
          $in: objectIds,
        },
      });
    }

    if (numericIds.length) {
      conditions.push({
        legacy_id: {
          $in: numericIds,
        },
      });

      conditions.push({
        id: {
          $in: numericIds,
        },
      });

      conditions.push({
        sl_no: {
          $in: numericIds,
        },
      });
    }

    if (!conditions.length) {
      return new Map();
    }

    const docs = await Model.find({
      $or: conditions,
    }).lean();

    const map = new Map();

    for (const doc of docs) {
      const name =
        doc.name ||
        doc.account_name ||
        "";

      if (doc._id) {
        map.set(
          String(doc._id),
          name
        );
      }

      if (doc.legacy_id != null) {
        map.set(
          String(doc.legacy_id),
          name
        );
      }

      if (doc.id != null) {
        map.set(
          String(doc.id),
          name
        );
      }

      if (doc.sl_no != null) {
        map.set(
          String(doc.sl_no),
          name
        );
      }
    }

    return map;
  }

  const [
    employeeMap,
    locationMap,
    warehouseMap,
    productMap,
    companyMap,
    accountMap,
  ] = await Promise.all([
    loadMap(Employee, employeeIds),
    loadMap(Location, locationIds),
    loadMap(Warehouse, warehouseIds),
    loadMap(Product, productIds),
    loadMap(Company, companyIds),
    loadMap(CompanyAccount, accountIds),
  ]);

  return rows.map((row) => ({
    ...row,

    id:
      row.legacy_id ??
      row.id ??
      row.sl_no ??
      String(row._id),

    mongo_id:
      row._id
        ? String(row._id)
        : null,

    employee_name:
      employeeMap.get(
        String(row.employee_id)
      ) ||
      row.employee_name ||
      "",

    location_name:
      locationMap.get(
        String(row.location_id)
      ) ||
      row.location_name ||
      "",

    warehouse_name:
      warehouseMap.get(
        String(row.warehouse_id)
      ) ||
      row.warehouse_name ||
      "",

    product_name:
      productMap.get(
        String(row.product_id)
      ) ||
      row.product_name ||
      row.product ||
      "",

    company_name:
      companyMap.get(
        String(row.company_id)
      ) ||
      row.company_name ||
      "",

    company_account_name:
      accountMap.get(
        String(row.company_account_id)
      ) ||
      row.company_account_name ||
      "",
  }));
}

router.get("/report", async (req, res) => {
  try {
    if (!requireMongo(res)) {
      return;
    }

    const {
      company_id,
      warehouse_id,
      from_date,
      to_date,
    } = req.query;

    const filter = {};

    if (company_id) {
      const conditions =
        buildIdConditions(
          company_id
        );

      if (conditions.length) {
        filter.$and = [
          {
            $or: conditions,
          },
        ];
      }
    }

    if (warehouse_id) {
      const conditions =
        buildIdConditions(
          warehouse_id
        );

      if (conditions.length) {
        filter.$and =
          filter.$and || [];

        filter.$and.push({
          $or: conditions,
        });
      }
    }

    const dateFilter =
      buildDateFilter(
        from_date,
        to_date
      );

    if (dateFilter) {
      filter.date = dateFilter;
    }

    const rows = await Inward.find(
      filter
    )
      .sort({
        date: 1,
        legacy_id: 1,
        _id: 1,
      })
      .lean();

    const result =
      await resolveNames(rows);

    return res.json(result);
  } catch (err) {
    console.error(
      "Inward report failed:",
      err
    );

    return res.status(500).json({
      error:
        err.message,
    });
  }
});

module.exports = router;
