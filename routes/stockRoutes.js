const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

const {
  Inward,
  Company,
  CompanyAccount,
  Warehouse,
  Product,
  isMongoMirrorReady,
} = require("../db-mongodb");

const {
  calculateShortageQty,
} = require("./shortageHelper");

/*
====================================================
MONGO HELPERS
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

function getDb() {
  if (!mongoose.connection.db) {
    throw new Error(
      "MongoDB database handle is not available"
    );
  }

  return mongoose.connection.db;
}

function getCollection(name) {
  return getDb().collection(name);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value) {
  return String(value ?? "").trim();
}

function formatLocalDate(date = new Date()) {
  const year =
    date.getFullYear();

  const month =
    String(
      date.getMonth() + 1
    ).padStart(2, "0");

  const day =
    String(
      date.getDate()
    ).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

/*
====================================================
MONTH SLAB
====================================================
*/

function calculateMonthSlab(
  inwardDateStr,
  currentDateStr
) {
  const inwardDate =
    new Date(
      inwardDateStr
    );

  const currentDate =
    new Date(
      currentDateStr
    );

  if (
    Number.isNaN(
      inwardDate.getTime()
    ) ||
    Number.isNaN(
      currentDate.getTime()
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
      (
        currentDate -
        inwardDate
      ) /
        msPerDay
    );

  let monthsDiff =
    Math.floor(
      (
        daysDiff <= 0
          ? 0
          : daysDiff - 1
      ) /
        30
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
}

/*
====================================================
ID HELPERS
====================================================
*/

function buildIdConditions(value) {
  const raw =
    text(value);

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

/*
====================================================
AVAILABLE STOCK
====================================================
*/

function getAvailableQty(
  weight,
  inwardDate,
  alreadyAdjusted,
  shortagePercent = null,
  refDate =
    formatLocalDate()
) {
  const slab =
    calculateMonthSlab(
      inwardDate,
      refDate
    );

  const grossQty =
    num(weight);

  const shortageQty =
    calculateShortageQty(
      grossQty,
      slab.monthsDiff,
      shortagePercent
    );

  return (
    grossQty -
    shortageQty -
    num(
      alreadyAdjusted
    )
  );
}

/*
====================================================
SHORTAGE PERCENT
====================================================
*/

async function resolveShortagePercent(
  row
) {
  if (
    row?.shortage_percent !==
      undefined &&
    row?.shortage_percent !==
      null &&
    text(
      row.shortage_percent
    ) !== ""
  ) {
    return num(
      row.shortage_percent
    );
  }

  let company =
    null;

  let account =
    null;

  if (
    row?.company_id !=
    null
  ) {
    const filter =
      buildIdFilter(
        row.company_id
      );

    if (filter) {
      company =
        await Company.findOne(
          filter
        )
          .select({
            shortage_percent: 1,
          })
          .lean()
          .catch(
            () => null
          );
    }
  }

  if (
    row?.company_account_id !=
    null
  ) {
    const filter =
      buildIdFilter(
        row.company_account_id
      );

    if (filter) {
      account =
        await CompanyAccount.findOne(
          filter
        )
          .select({
            shortage_percent: 1,
          })
          .lean()
          .catch(
            () => null
          );
    }
  }

  if (
    company?.shortage_percent !=
      null &&
    company?.shortage_percent !==
      undefined
  ) {
    return num(
      company.shortage_percent
    );
  }

  if (
    account?.shortage_percent !=
      null &&
    account?.shortage_percent !==
      undefined
  ) {
    return num(
      account.shortage_percent
    );
  }

  /*
   * Fallback to raw MongoDB documents because
   * older migrated CompanyAccount documents may
   * contain shortage_percent outside the current
   * Mongoose schema.
   */
  try {
    if (
      row?.company_id !=
      null
    ) {
      const rawCompany =
        await getCollection(
          "companies"
        ).findOne(
          buildIdFilter(
            row.company_id
          )
        );

      if (
        rawCompany?.shortage_percent !=
          null &&
        rawCompany?.shortage_percent !==
          undefined
      ) {
        return num(
          rawCompany.shortage_percent
        );
      }
    }

    if (
      row?.company_account_id !=
      null
    ) {
      const rawAccount =
        await getCollection(
          "companyaccounts"
        ).findOne(
          buildIdFilter(
            row.company_account_id
          )
        );

      if (
        rawAccount?.shortage_percent !=
          null &&
        rawAccount?.shortage_percent !==
          undefined
      ) {
        return num(
          rawAccount.shortage_percent
        );
      }
    }
  } catch (err) {
    console.warn(
      "Raw shortage_percent lookup failed:",
      err.message
    );
  }

  return null;
}

/*
====================================================
ADJUSTMENT TOTALS
====================================================
*/

async function buildAdjustmentMap() {
  const rows =
    await getCollection(
      "adjustments"
    )
      .find(
        {},
        {
          projection: {
            inward_id: 1,
            qty: 1,
            quantity: 1,
          },
        }
      )
      .toArray();

  const map =
    new Map();

  for (
    const row of rows
  ) {
    const id =
      String(
        row.inward_id ??
          ""
      ).trim();

    if (!id) {
      continue;
    }

    const value =
      num(
        row.qty ??
          row.quantity
      );

    map.set(
      id,
      (
        map.get(id) ||
        0
      ) + value
    );

    /*
     * Also map ObjectId version when
     * the inward record was stored that way.
     */
    if (
      mongoose.Types.ObjectId.isValid(
        id
      )
    ) {
      map.set(
        id,
        (
          map.get(id) ||
          0
        ) + 0
      );
    }
  }

  return map;
}

function lookupAdjustmentQty(
  map,
  row
) {
  const candidates =
    [
      row?._id
        ? String(
            row._id
          )
        : null,

      row?.legacy_id !=
      null
        ? String(
            row.legacy_id
          )
        : null,

      row?.id != null
        ? String(
            row.id
          )
        : null,

      row?.sl_no != null
        ? String(
            row.sl_no
          )
        : null,
    ].filter(Boolean);

  for (
    const key of
      candidates
  ) {
    if (
      map.has(key)
    ) {
      return num(
        map.get(key)
      );
    }
  }

  return 0;
}

/*
====================================================
PARTY NAME
====================================================
*/

function resolvePartyName(
  row,
  companyMap,
  accountMap
) {
  const company =
    companyMap.get(
      String(
        row.company_id ??
          ""
      )
    );

  if (
    company?.name
  ) {
    return company.name;
  }

  const account =
    accountMap.get(
      String(
        row.company_account_id ??
          ""
      )
    );

  if (
    account?.account_name
  ) {
    return account.account_name;
  }

  return (
    row.company_name ||
    row.company_account_name ||
    "Unknown"
  );
}

/*
====================================================
PARTY STOCK
====================================================
*/

router.get(
  "/party-stock",
  async (req, res) => {
    try {
      if (!requireMongo(res)) {
        return;
      }

      const [
        rows,
        adjustments,
        companies,
        accounts,
      ] =
        await Promise.all([
          Inward.find({})
            .lean(),

          getCollection(
            "adjustments"
          )
            .find({})
            .toArray(),

          Company.find({})
            .lean(),

          CompanyAccount.find({})
            .lean(),
        ]);

      const adjustmentMap =
        new Map();

      for (
        const adjustment of
          adjustments
      ) {
        const key =
          String(
            adjustment.inward_id ??
              ""
          ).trim();

        if (!key) {
          continue;
        }

        adjustmentMap.set(
          key,
          (
            adjustmentMap.get(
              key
            ) || 0
          ) +
            num(
              adjustment.qty ??
                adjustment.quantity
            )
        );
      }

      const companyMap =
        new Map(
          companies.map(
            (item) => [
              String(
                item._id
              ),
              item,
            ]
          )
        );

      const accountMap =
        new Map(
          accounts.map(
            (item) => [
              String(
                item._id
              ),
              item,
            ]
          )
        );

      for (
        const company of
          companies
      ) {
        if (
          company.legacy_id !=
          null
        ) {
          companyMap.set(
            String(
              company.legacy_id
            ),
            company
          );
        }

        if (
          company.id !=
          null
        ) {
          companyMap.set(
            String(
              company.id
            ),
            company
          );
        }
      }

      for (
        const account of
          accounts
      ) {
        if (
          account.legacy_id !=
          null
        ) {
          accountMap.set(
            String(
              account.legacy_id
            ),
            account
          );
        }

        if (
          account.id !=
          null
        ) {
          accountMap.set(
            String(
              account.id
            ),
            account
          );
        }
      }

      const map =
        {};

      for (
        const row of
          rows
      ) {
        const alreadyAdjusted =
          lookupAdjustmentQty(
            adjustmentMap,
            row
          );

        const shortagePercent =
          await resolveShortagePercent(
            row
          );

        const qty =
          getAvailableQty(
            row.weight ??
              row.quantity,
            row.date ||
              row.inward_date,
            alreadyAdjusted,
            shortagePercent
          );

        const party =
          resolvePartyName(
            row,
            companyMap,
            accountMap
          );

        map[party] =
          (
            map[party] ||
            0
          ) + qty;
      }

      const result =
        Object.entries(
          map
        )
          .map(
            ([
              party,
              stock,
            ]) => ({
              party,

              stock:
                Number(
                  stock.toFixed(
                    4
                  )
                ),
            })
          )
          .sort(
            (a, b) =>
              a.party.localeCompare(
                b.party
              )
          );

      return res.json(
        result
      );
    } catch (err) {
      console.error(
        "Mongo party stock failed:",
        err
      );

      return res.status(500).json({
        error:
          err.message,
      });
    }
  }
);

/*
====================================================
WAREHOUSE STOCK
====================================================
*/

router.get(
  "/warehouse-stock",
  async (req, res) => {
    try {
      if (!requireMongo(res)) {
        return;
      }

      const [
        rows,
        adjustments,
        warehouses,
      ] =
        await Promise.all([
          Inward.find({
            warehouse_id: {
              $exists:
                true,
            },
          })
            .lean(),

          getCollection(
            "adjustments"
          )
            .find({})
            .toArray(),

          Warehouse.find({})
            .lean(),
        ]);

      const adjustmentMap =
        new Map();

      for (
        const adjustment of
          adjustments
      ) {
        const key =
          String(
            adjustment.inward_id ??
              ""
          ).trim();

        if (!key) {
          continue;
        }

        adjustmentMap.set(
          key,
          (
            adjustmentMap.get(
              key
            ) || 0
          ) +
            num(
              adjustment.qty ??
                adjustment.quantity
            )
        );
      }

      const warehouseMapById =
        new Map();

      for (
        const warehouse of
          warehouses
      ) {
        warehouseMapById.set(
          String(
            warehouse._id
          ),
          warehouse.name ||
            ""
        );

        if (
          warehouse.legacy_id !=
          null
        ) {
          warehouseMapById.set(
            String(
              warehouse.legacy_id
            ),
            warehouse.name ||
              ""
          );
        }

        if (
          warehouse.id !=
          null
        ) {
          warehouseMapById.set(
            String(
              warehouse.id
            ),
            warehouse.name ||
              ""
          );
        }
      }

      const map =
        {};

      for (
        const row of
          rows
      ) {
        const alreadyAdjusted =
          lookupAdjustmentQty(
            adjustmentMap,
            row
          );

        const shortagePercent =
          await resolveShortagePercent(
            row
          );

        const qty =
          getAvailableQty(
            row.weight ??
              row.quantity,
            row.date ||
              row.inward_date,
            alreadyAdjusted,
            shortagePercent
          );

        const warehouseName =
          warehouseMapById.get(
            String(
              row.warehouse_id
            )
          ) ||
          row.warehouse_name ||
          "Unknown";

        map[
          warehouseName
        ] =
          (
            map[
              warehouseName
            ] || 0
          ) + qty;
      }

      const result =
        Object.entries(
          map
        )
          .map(
            ([
              warehouse,
              stock,
            ]) => ({
              warehouse,

              stock:
                Number(
                  stock.toFixed(
                    4
                  )
                ),
            })
          )
          .sort(
            (a, b) =>
              a.warehouse.localeCompare(
                b.warehouse
              )
          );

      return res.json(
        result
      );
    } catch (err) {
      console.error(
        "Mongo warehouse stock failed:",
        err
      );

      return res.status(500).json({
        error:
          err.message,
      });
    }
  }
);

/*
====================================================
TOTAL STOCK
====================================================
*/

router.get(
  "/total-stock",
  async (req, res) => {
    try {
      if (!requireMongo(res)) {
        return;
      }

      const [
        rows,
        adjustments,
      ] =
        await Promise.all([
          Inward.find({})
            .lean(),

          getCollection(
            "adjustments"
          )
            .find({})
            .toArray(),
        ]);

      const adjustmentMap =
        new Map();

      for (
        const adjustment of
          adjustments
      ) {
        const key =
          String(
            adjustment.inward_id ??
              ""
          ).trim();

        if (!key) {
          continue;
        }

        adjustmentMap.set(
          key,
          (
            adjustmentMap.get(
              key
            ) || 0
          ) +
            num(
              adjustment.qty ??
                adjustment.quantity
            )
        );
      }

      let total = 0;

      for (
        const row of
          rows
      ) {
        const alreadyAdjusted =
          lookupAdjustmentQty(
            adjustmentMap,
            row
          );

        const shortagePercent =
          await resolveShortagePercent(
            row
          );

        total +=
          getAvailableQty(
            row.weight ??
              row.quantity,
            row.date ||
              row.inward_date,
            alreadyAdjusted,
            shortagePercent
          );
      }

      return res.json({
        total:
          Number(
            total.toFixed(
              4
            )
          ),

        saved_from:
          "mongodb",
      });
    } catch (err) {
      console.error(
        "Mongo total stock failed:",
        err
      );

      return res.status(500).json({
        error:
          err.message,
      });
    }
  }
);

/*
====================================================
FIFO STOCK
====================================================
*/

router.get(
  "/fifo-stock",
  async (req, res) => {
    try {
      if (!requireMongo(res)) {
        return;
      }

      const {
        product_id,
        warehouse_id,
      } =
        req.query;

      if (!product_id) {
        return res.status(400).json({
          error:
            "product_id is required",
        });
      }

      const inwardFilter = {};

      /*
       * Resolve product id safely.
       */
      const productConditions =
        buildIdConditions(
          product_id
        );

      if (
        productConditions.length
      ) {
        inwardFilter.$or =
          productConditions;
      }

      if (
        warehouse_id
      ) {
        const warehouseConditions =
          buildIdConditions(
            warehouse_id
          );

        if (
          warehouseConditions.length
        ) {
          inwardFilter.$and = [
            {
              $or:
                warehouseConditions,
            },
          ];
        }
      }

      const rows =
        await Inward.find(
          inwardFilter
        )
          .sort({
            date: 1,
            legacy_id: 1,
            _id: 1,
          })
          .lean();

      const adjustments =
        await getCollection(
          "adjustments"
        )
          .find({})
          .toArray();

      const adjustmentMap =
        new Map();

      for (
        const adjustment of
          adjustments
      ) {
        const key =
          String(
            adjustment.inward_id ??
              ""
          ).trim();

        if (!key) {
          continue;
        }

        adjustmentMap.set(
          key,
          (
            adjustmentMap.get(
              key
            ) || 0
          ) +
            num(
              adjustment.qty ??
                adjustment.quantity
            )
        );
      }

      const batches =
        [];

      for (
        const row of
          rows
      ) {
        const alreadyAdjusted =
          lookupAdjustmentQty(
            adjustmentMap,
            row
          );

        const shortagePercent =
          await resolveShortagePercent(
            row
          );

        const avail =
          getAvailableQty(
            row.weight ??
              row.quantity,
            row.date ||
              row.inward_date,
            alreadyAdjusted,
            shortagePercent
          );

        if (
          avail <=
          0
        ) {
          continue;
        }

        const inwardId =
          row.legacy_id ??
          row.id ??
          row.sl_no ??
          String(
            row._id
          );

        batches.push({
          inward_id:
            inwardId,

          mongo_id:
            row._id
              ? String(
                  row._id
                )
              : null,

          warehouse_id:
            row.warehouse_id ??
            null,

          inward_date:
            row.date ||
            row.inward_date ||
            null,

          gross_qty:
            Number(
              (
                row.weight ??
                row.quantity ??
                0
              )
            ),

          already_adjusted:
            Number(
              (
                alreadyAdjusted
              ).toFixed(
                4
              )
            ),

          shortage_percent:
            shortagePercent,

          available_qty:
            Number(
              avail.toFixed(
                4
              )
            ),
        });
      }

      /*
       * ================================================
       * AVERAGE PURCHASE RATE
       * ================================================
       *
       * Mongo collection:
       * purchasevouchers
       */
      const purchaseCollection =
        getCollection(
          "purchasevouchers"
        );

      const purchaseFilter = {};

      const productConditionsForPurchase =
        buildIdConditions(
          product_id
        );

      if (
        productConditionsForPurchase.length
      ) {
        purchaseFilter.$or =
          productConditionsForPurchase;
      }

      if (
        warehouse_id
      ) {
        const warehouseConditions =
          buildIdConditions(
            warehouse_id
          );

        if (
          warehouseConditions.length
        ) {
          purchaseFilter.$and = [
            {
              $or:
                warehouseConditions,
            },
          ];
        }
      }

      const purchaseRows =
        await purchaseCollection
          .find(
            purchaseFilter,
            {
              projection: {
                quantity: 1,
                qty: 1,
                rate: 1,
                product_id: 1,
                warehouse_id: 1,
              },
            }
          )
          .toArray();

      let totalAmount =
        0;

      let totalQty =
        0;

      for (
        const row of
          purchaseRows
      ) {
        const quantity =
          num(
            row.quantity ??
              row.qty
          );

        const rate =
          num(
            row.rate
          );

        totalQty +=
          quantity;

        totalAmount +=
          quantity *
          rate;
      }

      const avg_rate =
        totalQty > 0
          ? Number(
              (
                totalAmount /
                totalQty
              ).toFixed(
                4
              )
            )
          : 0;

      return res.json({
        batches,

        avg_rate,
      });
    } catch (err) {
      console.error(
        "Mongo FIFO stock failed:",
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
