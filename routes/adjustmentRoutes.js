const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

const {
  Inward: MongoInward,
  Outward: MongoOutward,
  Company: MongoCompany,
  CompanyAccount: MongoCompanyAccount,
  Warehouse: MongoWarehouse,
  isMongoMirrorReady,
} = require("../db-mongodb");

const {
  userHasPermission,
} = require("../middleware/auth");

const {
  calculateAppliedShortageRate,
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
  if (
    !mongoose.connection.db
  ) {
    throw new Error(
      "MongoDB database handle is not available"
    );
  }

  return mongoose.connection.db;
}

function getAdjustmentCollection() {
  return getDb().collection(
    "adjustments"
  );
}

function getPaltiCollection() {
  return getDb().collection(
    "paltilorryentries"
  );
}

function normalizeQty(value) {
  const qty = Number(value);

  if (!Number.isFinite(qty)) {
    return 0;
  }

  return Number(
    qty.toFixed(4)
  );
}

function addQty(...values) {
  return normalizeQty(
    values.reduce(
      (sum, value) =>
        sum +
        normalizeQty(
          value
        ),
      0
    )
  );
}

const EPS = 0.0001;

function getPaltiQty(row) {
  const balance =
    normalizeQty(
      row?.balance
    );

  if (balance > 0) {
    return balance;
  }

  return normalizeQty(
    row?.new_weight
  );
}

function makeAdjustmentError(
  message,
  details = {},
  status = 400
) {
  const error =
    new Error(message);

  error.status =
    status;

  error.details =
    details;

  return error;
}

function normalizeText(value) {
  return String(
    value ?? ""
  ).trim();
}

function isValidObjectId(
  value
) {
  return mongoose.Types.ObjectId.isValid(
    String(value || "")
  );
}

/*
====================================================
FLEXIBLE LEGACY/MONGO ID FILTER
====================================================
*/

function buildFlexibleIdFilter(
  value
) {
  const raw =
    String(
      value ?? ""
    ).trim();

  if (!raw) {
    return null;
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

  if (
    conditions.length === 1
  ) {
    return conditions[0];
  }

  return {
    $or:
      conditions,
  };
}

function buildMongoIdCandidates(
  value
) {
  const filter =
    buildFlexibleIdFilter(
      value
    );

  if (!filter) {
    return [];
  }

  if (filter.$or) {
    return filter.$or;
  }

  return [filter];
}

/*
====================================================
DATES / SHORTAGE
====================================================
*/

function calculateMonthSlab(
  inwardDateStr,
  outwardDateStr
) {
  const inwardDate =
    new Date(
      inwardDateStr
    );

  const outwardDate =
    new Date(
      outwardDateStr
    );

  if (
    Number.isNaN(
      inwardDate.getTime()
    ) ||
    Number.isNaN(
      outwardDate.getTime()
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

  const daysDiff = Math.floor(
    (
      outwardDate -
      inwardDate
    ) /
      msPerDay
  );

  let monthsDiff =
    Math.floor(
      daysDiff / 30
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
ADJUSTMENT ACCESS
====================================================
*/

function canViewAdjustment(
  user
) {
  return (
    userHasPermission(
      user,
      "adjustment.manage"
    ) ||
    userHasPermission(
      user,
      "inward.view"
    ) ||
    userHasPermission(
      user,
      "outward.view"
    )
  );
}

function canManageAdjustment(
  user
) {
  return userHasPermission(
    user,
    "adjustment.manage"
  );
}

/*
====================================================
ADJUSTMENT QUERIES
====================================================
*/

async function getAdjustedQtyForOutward(
  outwardId,
  session = null,
  excludeAdjustmentId = null
) {
  const collection =
    getAdjustmentCollection();

  const filter = {
    outward_id:
      Number(
        outwardId
      ),
  };

  if (
    excludeAdjustmentId
  ) {
    filter._id = {
      $ne:
        excludeAdjustmentId,
    };
  }

  const result =
    await collection
      .aggregate(
        [
          {
            $match:
              filter,
          },

          {
            $group: {
              _id: null,

              total: {
                $sum: {
                  $ifNull: [
                    "$qty",
                    0,
                  ],
                },
              },
            },
          },
        ],
        session
          ? {
              session,
            }
          : undefined
      )
      .toArray();

  return normalizeQty(
    result[0]?.total
  );
}

async function getAdjustedQtyForInward(
  inwardId,
  session = null,
  excludeAdjustmentId = null
) {
  const collection =
    getAdjustmentCollection();

  const filter = {
    inward_id:
      Number(
        inwardId
      ),
  };

  if (
    excludeAdjustmentId
  ) {
    filter._id = {
      $ne:
        excludeAdjustmentId,
    };
  }

  const result =
    await collection
      .aggregate(
        [
          {
            $match:
              filter,
          },

          {
            $group: {
              _id: null,

              total: {
                $sum: {
                  $ifNull: [
                    "$qty",
                    0,
                  ],
                },
              },
            },
          },
        ],
        session
          ? {
              session,
            }
          : undefined
      )
      .toArray();

  return normalizeQty(
    result[0]?.total
  );
}

async function getAdjustedQtyForPalti(
  paltiId,
  session = null,
  excludeAdjustmentId = null
) {
  const collection =
    getAdjustmentCollection();

  const filter = {
    palti_lorry_id:
      Number(
        paltiId
      ),

    $or: [
      {
        source_type:
          "palti_lorry",
      },

      {
        source_type: {
          $exists:
            false,
        },
      },
    ],
  };

  if (
    excludeAdjustmentId
  ) {
    filter._id = {
      $ne:
        excludeAdjustmentId,
    };
  }

  const result =
    await collection
      .aggregate(
        [
          {
            $match:
              filter,
          },

          {
            $group: {
              _id: null,

              total: {
                $sum: {
                  $ifNull: [
                    "$qty",
                    0,
                  ],
                },
              },
            },
          },
        ],
        session
          ? {
              session,
            }
          : undefined
      )
      .toArray();

  return normalizeQty(
    result[0]?.total
  );
}

/*
====================================================
LOOKUP COMPANY
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
    String(
      row.shortage_percent
    ).trim() !== ""
  ) {
    return Number(
      row.shortage_percent
    );
  }

  let company =
    null;

  let account =
    null;

  if (
    row?.company_id
  ) {
    const filter =
      buildFlexibleIdFilter(
        row.company_id
      );

    if (filter) {
      company =
        await MongoCompany.findOne(
          filter
        )
          .select({
            shortage_percent: 1,
            name: 1,
          })
          .lean()
          .catch(
            () => null
          );
    }
  }

  if (
    row?.company_account_id
  ) {
    const filter =
      buildFlexibleIdFilter(
        row.company_account_id
      );

    if (filter) {
      account =
        await MongoCompanyAccount.findOne(
          filter
        )
          .select({
            shortage_percent: 1,
            account_name: 1,
          })
          .lean()
          .catch(
            () => null
          );
    }
  }

  const values = [
    company?.shortage_percent,
    account?.shortage_percent,
  ];

  for (
    const value of values
  ) {
    if (
      value !==
        null &&
      value !==
        undefined &&
      String(
        value
      ).trim() !== ""
    ) {
      return Number(
        value
      );
    }
  }

  return null;
}

/*
====================================================
GET PARTIES
====================================================
*/

router.get(
  "/parties",
  async (req, res) => {
    if (
      !canViewAdjustment(
        req.user
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to view adjustment parties",
      });
    }

    try {
      if (!requireMongo(res)) {
        return;
      }

      const warehouseId =
        normalizeText(
          req.query
            ?.warehouse_id
        );

      const locationId =
        normalizeText(
          req.query
            ?.location_id
        );

      const productId =
        normalizeText(
          req.query
            ?.product_id
        );

      if (
        !warehouseId &&
        !locationId
      ) {
        return res.status(400).json({
          error:
            "warehouse_id or location_id required",
        });
      }

      /*
       * -------------------------
       * INWARD COMPANIES
       * -------------------------
       */
      const inwardFilter = {};

      if (
        warehouseId
      ) {
        inwardFilter.warehouse_id =
          Number(
            warehouseId
          );
      } else {
        inwardFilter.location_id =
          Number(
            locationId
          );
      }

      inwardFilter.remaining_qty = {
        $gt: 0,
      };

      if (
        productId
      ) {
        inwardFilter.product_id =
          Number(
            productId
          );
      }

      const inwardRows =
        await MongoInward.find(
          inwardFilter
        )
          .select({
            company_id: 1,
          })
          .lean();

      /*
       * -------------------------
       * PALTI COMPANIES
       * -------------------------
       */
      const paltiCollection =
        getPaltiCollection();

      const paltiFilter = {};

      if (
        warehouseId
      ) {
        paltiFilter.warehouse_id =
          Number(
            warehouseId
          );
      }

      if (
        productId
      ) {
        paltiFilter.product_id =
          Number(
            productId
          );
      }

      const paltiRows =
        await paltiCollection
          .find(
            paltiFilter,
            {
              projection: {
                company_id: 1,
                id: 1,
                legacy_id: 1,
                balance: 1,
                new_weight: 1,
              },
            }
          )
          .toArray();

      const companyIds =
        Array.from(
          new Set(
            [
              ...inwardRows.map(
                (row) =>
                  row.company_id
              ),
              ...paltiRows.map(
                (row) =>
                  row.company_id
              ),
            ]
              .map(
                (id) =>
                  String(
                    id ??
                      ""
                  ).trim()
              )
              .filter(Boolean)
          )
        );

      if (
        companyIds.length === 0
      ) {
        return res.json([]);
      }

      const mongoObjectIds =
        companyIds
          .filter((id) =>
            mongoose.Types.ObjectId.isValid(
              id
            )
          )
          .map(
            (id) =>
              new mongoose.Types.ObjectId(
                id
              )
          );

      const numericIds =
        companyIds
          .map(Number)
          .filter(
            Number.isFinite
          );

      const conditions = [];

      if (
        mongoObjectIds.length
      ) {
        conditions.push({
          _id: {
            $in:
              mongoObjectIds,
          },
        });
      }

      if (
        numericIds.length
      ) {
        conditions.push({
          legacy_id: {
            $in:
              numericIds,
          },
        });

        conditions.push({
          id: {
            $in:
              numericIds,
          },
        });
      }

      const companies =
        conditions.length
          ? await MongoCompany.find({
              $or:
                conditions,
            })
              .select({
                name: 1,
              })
              .lean()
          : [];

      const companyMap =
        new Map(
          companies.map(
            (company) => [
              String(
                company._id
              ),
              company,
            ]
          )
        );

      const numericCompanyMap =
        new Map();

      for (
        const company of
          companies
      ) {
        if (
          company.legacy_id !=
          null
        ) {
          numericCompanyMap.set(
            String(
              company.legacy_id
            ),
            company
          );
        }

        if (
          company.id != null
        ) {
          numericCompanyMap.set(
            String(
              company.id
            ),
            company
          );
        }
      }

      const resultMap =
        new Map();

      for (
        const id of
          companyIds
      ) {
        const company =
          companyMap.get(
            id
          ) ||
          numericCompanyMap.get(
            id
          );

        if (!company) {
          continue;
        }

        const key =
          String(
            company._id
          );

        resultMap.set(
          key,
          {
            id:
              company.legacy_id ??
              company.id ??
              String(
                company._id
              ),

            name:
              company.name ||
              "",

            source_type:
              "inward",
          }
        );
      }

      return res.json(
        Array.from(
          resultMap.values()
        ).sort(
          (a, b) =>
            String(
              a.name
            ).localeCompare(
              String(
                b.name
              )
            )
        )
      );
    } catch (err) {
      console.error(
        "[adjustment parties] error:",
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
GET INWARD REPORT
====================================================
*/

router.get(
  "/inward/report",
  async (req, res) => {
    if (
      !canViewAdjustment(
        req.user
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to view adjustment report",
      });
    }

    try {
      if (!requireMongo(res)) {
        return;
      }

      const warehouseId =
        normalizeText(
          req.query
            ?.warehouse_id
        );

      const locationId =
        normalizeText(
          req.query
            ?.location_id
        );

      const companyId =
        normalizeText(
          req.query
            ?.company_id
        );

      const outwardDate =
        normalizeText(
          req.query
            ?.outward_date
        );

      const sourceType =
        normalizeText(
          req.query
            ?.source_type
        ).toLowerCase();

      if (
        (!warehouseId &&
          !locationId) ||
        !companyId ||
        !outwardDate
      ) {
        return res.status(400).json({
          error:
            "warehouse_id or location_id, company_id and outward_date required",
        });
      }

      const companyFilter =
        buildFlexibleIdFilter(
          companyId
        );

      /*
       * ==================================================
       * PALTI LORRY REPORT
       * ==================================================
       */
      if (
        sourceType ===
        "palti_lorry"
      ) {
        const paltiCollection =
          getPaltiCollection();

        const paltiFilter = {
          company_id:
            Number(
              companyId
            ),
        };

        if (
          warehouseId
        ) {
          paltiFilter.warehouse_id =
            Number(
              warehouseId
            );
        } else {
          const warehouseRows =
            await MongoWarehouse.find({
              location_id:
                Number(
                  locationId
                ),
            })
              .select({
                _id: 1,
                legacy_id: 1,
                id: 1,
              })
              .lean();

          const warehouseIds =
            warehouseRows.flatMap(
              (row) => [
                Number(
                  row.legacy_id
                ),
                Number(
                  row.id
                ),
                String(
                  row._id
                ),
              ]
            );

          paltiFilter.warehouse_id =
            {
              $in:
                warehouseIds.filter(
                  (id) =>
                    id !==
                      null &&
                    id !==
                      undefined &&
                    !Number.isNaN(
                      Number(
                        id
                      )
                    )
                ),
            };
        }

        const paltiRows =
          await paltiCollection
            .find(
              paltiFilter
            )
            .sort({
              expense_date: 1,
              id: 1,
            })
            .toArray();

        const result =
          [];

        for (
          const row of
            paltiRows
        ) {
          const paltiId =
            row.legacy_id ??
            row.id ??
            row.sl_no;

          if (
            paltiId ==
            null
          ) {
            continue;
          }

          const alreadyAdjusted =
            await getAdjustedQtyForPalti(
              paltiId
            );

          const grossQty =
            getPaltiQty(
              row
            );

          const availableQty =
            normalizeQty(
              grossQty -
                alreadyAdjusted
            );

          if (
            availableQty <=
            0
          ) {
            continue;
          }

          const slab =
            calculateMonthSlab(
              row.expense_date,
              outwardDate
            );

          let warehouseName =
            "";

          if (
            row.warehouse_id !=
            null
          ) {
            const warehouse =
              await MongoWarehouse.findOne(
                buildFlexibleIdFilter(
                  row.warehouse_id
                )
              )
                .select({
                  name: 1,
                })
                .lean();

            warehouseName =
              warehouse?.name ||
              "";
          }

          let companyName =
            "";

          if (
            companyFilter
          ) {
            const company =
              await MongoCompany.findOne(
                companyFilter
              )
                .select({
                  name: 1,
                })
                .lean();

            companyName =
              company?.name ||
              "";
          }

          result.push({
            id:
              paltiId,

            _id:
              row._id
                ? String(
                    row._id
                  )
                : null,

            voucher_no:
              row.voucher_no ||
              null,

            date:
              row.expense_date ||
              null,

            reg_lorry_no:
              row.reg_lorry_no ||
              null,

            new_lorry_no:
              row.new_lorry_no ||
              null,

            display_lorry_no:
              normalizeText(
                row.new_lorry_no
              ) ||
              normalizeText(
                row.reg_lorry_no
              ) ||
              "-",

            lorry_no:
              normalizeText(
                row.reg_lorry_no
              ) ||
              normalizeText(
                row.new_lorry_no
              ) ||
              "-",

            gross_qty:
              normalizeQty(
                grossQty
              ),

            remaining_qty:
              normalizeQty(
                grossQty
              ),

            warehouse_name:
              warehouseName,

            company_name:
              companyName,

            source_type:
              "palti_lorry",

            outward_date:
              outwardDate,

            days_diff:
              slab.daysDiff,

            months_diff:
              slab.monthsDiff,

            applied_shortage_percent:
              0,

            shortage_qty:
              0,

            warehouse_chgs:
              0,

            net_opening_qty:
              normalizeQty(
                grossQty
              ),

            already_adjusted:
              normalizeQty(
                alreadyAdjusted
              ),

            available_qty:
              normalizeQty(
                availableQty
              ),
          });
        }

        return res.json(
          result
        );
      }

      /*
       * ==================================================
       * INWARD REPORT
       * ==================================================
       */

      const inwardFilter = {};

      if (
        warehouseId
      ) {
        inwardFilter.warehouse_id =
          Number(
            warehouseId
          );
      } else {
        inwardFilter.location_id =
          Number(
            locationId
          );
      }

      if (
        companyFilter
      ) {
        /*
         * For migrated records company_id
         * may be numeric/ObjectId.
         */
        const company =
          await MongoCompany.findOne(
            companyFilter
          )
            .select({
              _id: 1,
              legacy_id: 1,
              id: 1,
              name: 1,
            })
            .lean();

        const companyIds =
          [
            company?._id
              ? String(
                  company._id
                )
              : null,
            company?.legacy_id,
            company?.id,
          ].filter(
            (value) =>
              value !==
                null &&
              value !==
                undefined
          );

        inwardFilter.company_id =
          {
            $in:
              companyIds,
          };
      }

      const inwardRows =
        await MongoInward.find(
          inwardFilter
        )
          .sort({
            date: 1,
            legacy_id: 1,
            _id: 1,
          })
          .lean();

      const result =
        [];

      for (
        const row of
          inwardRows
      ) {
        const inwardId =
          row.legacy_id ??
          row.id ??
          row.sl_no ??
          String(
            row._id
          );

        const adjusted =
          await getAdjustedQtyForInward(
            Number(
              row.legacy_id ??
                row.id ??
                row.sl_no
            )
          );

        const shortagePercent =
          await resolveShortagePercent(
            row
          );

        const slab =
          calculateMonthSlab(
            row.date,
            outwardDate
          );

        const grossQty =
          normalizeQty(
            row.weight ??
              row.quantity
          );

        const shortageQty =
          normalizeQty(
            calculateShortageQty(
              grossQty,
              slab.monthsDiff,
              shortagePercent
            )
          );

        const appliedShortagePercent =
          calculateAppliedShortageRate(
            shortagePercent,
            slab.monthsDiff
          );

        const netOpeningQty =
          normalizeQty(
            grossQty -
              shortageQty
          );

        const availableQty =
          normalizeQty(
            netOpeningQty -
              adjusted
          );

        if (
          availableQty <=
          0
        ) {
          continue;
        }

        let warehouseName =
          row.warehouse_name ||
          "";

        if (
          !warehouseName &&
          row.warehouse_id !=
            null
        ) {
          const warehouse =
            await MongoWarehouse.findOne(
              buildFlexibleIdFilter(
                row.warehouse_id
              )
            )
              .select({
                name: 1,
              })
              .lean();

          warehouseName =
            warehouse?.name ||
            "";
        }

        let companyName =
          row.company_name ||
          "";

        if (
          !companyName &&
          row.company_id !=
            null
        ) {
          const company =
            await MongoCompany.findOne(
              buildFlexibleIdFilter(
                row.company_id
              )
            )
              .select({
                name: 1,
              })
              .lean();

          companyName =
            company?.name ||
            "";
        }

        result.push({
          id:
            inwardId,

          _id:
            row._id
              ? String(
                  row._id
                )
              : null,

          voucher_no:
            row.voucher_no ||
            null,

          date:
            row.date ||
            null,

          lorry_no:
            row.lorry_no ||
            null,

          inward_qty:
            normalizeQty(
              row.weight ??
                row.quantity
            ),

          gross_qty:
            normalizeQty(
              grossQty
            ),

          remaining_qty:
            normalizeQty(
              row.remaining_qty ??
                grossQty
            ),

          company_account_id:
            row.company_account_id ||
            null,

          warehouse_name:
            warehouseName,

          company_name:
            companyName,

          shortage_percent:
            shortagePercent,

          source_type:
            "inward",

          outward_date:
            outwardDate,

          days_diff:
            slab.daysDiff,

          months_diff:
            slab.monthsDiff,

          applied_shortage_percent:
            Number(
              (
                Number(
                  appliedShortagePercent
                ) *
                100
              ).toFixed(2)
            ),

          shortage_qty:
            Number(
              shortageQty.toFixed(
                4
              )
            ),

          warehouse_chgs:
            Number(
              shortageQty.toFixed(
                4
              )
            ),

          net_opening_qty:
            Number(
              netOpeningQty.toFixed(
                4
              )
            ),

          already_adjusted:
            Number(
              adjusted.toFixed(
                4
              )
            ),

          available_qty:
            Number(
              Math.max(
                availableQty,
                0
              ).toFixed(
                4
              )
            ),
        });
      }

      return res.json(
        result
      );
    } catch (err) {
      console.error(
        "[adjustment inward report] error:",
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
FINAL SAVE
====================================================
*/

router.post(
  "/final-save",
  async (req, res) => {
    if (
      !canManageAdjustment(
        req.user
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to save adjustments",
      });
    }

    let session = null;

    try {
      if (!requireMongo(res)) {
        return;
      }

      const {
        outward_id,
        adjustments,
      } = req.body || {};

      const cleanAdjustments =
        Array.isArray(
          adjustments
        )
          ? adjustments
              .map(
                (item) => ({
                  inward_id:
                    item?.inward_id ??
                    null,

                  palti_lorry_id:
                    item?.palti_lorry_id ??
                    null,

                  source_type:
                    normalizeText(
                      item?.source_type ||
                        "inward"
                    ).toLowerCase(),

                  company_id:
                    item?.company_id ??
                    null,

                  qty:
                    Number(
                      item?.qty
                    ) || 0,
                })
              )
              .filter(
                (item) =>
                  item.qty >
                  0
              )
          : [];

      if (
        !outward_id ||
        cleanAdjustments.length ===
          0
      ) {
        return res.status(400).json({
          error:
            "Data required",
        });
      }

      const outwardFilter =
        buildFlexibleIdFilter(
          outward_id
        );

      if (!outwardFilter) {
        return res.status(400).json({
          error:
            "Invalid outward id",
        });
      }

      const outward =
        await MongoOutward.findOne(
          outwardFilter
        ).lean();

      if (!outward) {
        return res.status(404).json({
          error:
            "Outward not found",
        });
      }

      const outwardNumericId =
        Number(
          outward.legacy_id ??
            outward.id ??
            outward.sl_no
        );

      if (
        !Number.isFinite(
          outwardNumericId
        )
      ) {
        return res.status(400).json({
          error:
            "Outward does not have a valid legacy ID",
        });
      }

      const outwardQty =
        normalizeQty(
          outward.quantity
        );

      const totalAdjust =
        addQty(
          ...cleanAdjustments.map(
            (row) =>
              row.qty
          )
        );

      const alreadyAdjusted =
        await getAdjustedQtyForOutward(
          outwardNumericId
        );

      const remainingToAdjust =
        normalizeQty(
          outwardQty -
            alreadyAdjusted
        );

      if (
        remainingToAdjust <=
        0
      ) {
        return res.status(400).json({
          error:
            "This outward is already fully adjusted",
        });
      }

      if (
        totalAdjust -
          remainingToAdjust >
        EPS
      ) {
        return res.status(400).json({
          error:
            `Total adjustment cannot exceed remaining ${remainingToAdjust}`,
        });
      }

      session =
        await mongoose.startSession();

      session.startTransaction();

      for (
        const adj of
          cleanAdjustments
      ) {
        const adjQty =
          normalizeQty(
            adj.qty
          );

        const companyId =
          String(
            adj.company_id ||
              ""
          ).trim();

        if (
          !companyId ||
          adjQty <=
            0
        ) {
          throw makeAdjustmentError(
            "Invalid adjustment row",
            {
              source_type:
                adj.source_type,

              company_id:
                companyId ||
                null,

              qty:
                adjQty,
            }
          );
        }

        /*
         * ==================================================
         * PALTI
         * ==================================================
         */
        if (
          adj.source_type ===
          "palti_lorry"
        ) {
          if (
            !adj.palti_lorry_id
          ) {
            throw makeAdjustmentError(
              "Invalid Palti Lorry adjustment row",
              {
                source_type:
                  adj.source_type,

                palti_lorry_id:
                  null,

                qty:
                  adjQty,
              }
            );
          }

          const paltiCollection =
            getPaltiCollection();

          const paltiFilter =
            buildFlexibleIdFilter(
              adj.palti_lorry_id
            );

          const paltiRow =
            await paltiCollection.findOne(
              paltiFilter,
              {
                session,
              }
            );

          if (!paltiRow) {
            throw makeAdjustmentError(
              `Invalid palti_lorry_id ${adj.palti_lorry_id}`,
              {
                source_type:
                  adj.source_type,

                palti_lorry_id:
                  adj.palti_lorry_id,

                qty:
                  adjQty,
              }
            );
          }

          if (
            String(
              paltiRow.company_id
            ) !==
            companyId
          ) {
            throw makeAdjustmentError(
              `Company mismatch for palti_lorry_id ${adj.palti_lorry_id}`,
              {
                source_type:
                  adj.source_type,

                palti_lorry_id:
                  adj.palti_lorry_id,

                company_id:
                  companyId,

                row_company_id:
                  paltiRow.company_id,

                qty:
                  adjQty,
              }
            );
          }

          const outwardWarehouse =
            String(
              outward.warehouse_id ||
                ""
            );

          const rowWarehouse =
            String(
              paltiRow.warehouse_id ||
                ""
            );

          if (
            outwardWarehouse
          ) {
            if (
              rowWarehouse !==
              outwardWarehouse
            ) {
              throw makeAdjustmentError(
                `Warehouse mismatch for palti_lorry_id ${adj.palti_lorry_id}`,
                {
                  source_type:
                    adj.source_type,

                  palti_lorry_id:
                    adj.palti_lorry_id,

                  outward_warehouse_id:
                    outwardWarehouse,

                  row_warehouse_id:
                    rowWarehouse,

                  qty:
                    adjQty,
                }
              );
            }
          }

          const paltiId =
            Number(
              paltiRow.legacy_id ??
                paltiRow.id ??
                paltiRow.sl_no
            );

          if (
            !Number.isFinite(
              paltiId
            )
          ) {
            throw makeAdjustmentError(
              "Palti Lorry does not have a valid legacy ID",
              {
                palti_lorry_id:
                  adj.palti_lorry_id,
              }
            );
          }

          const already =
            await getAdjustedQtyForPalti(
              paltiId,
              session
            );

          const grossQty =
            getPaltiQty(
              paltiRow
            );

          const availableQty =
            normalizeQty(
              grossQty -
                already
            );

          if (
            adjQty -
              availableQty >
            EPS
          ) {
            throw makeAdjustmentError(
              `Adjusted qty exceeds available qty for palti_lorry_id ${adj.palti_lorry_id}`,
              {
                source_type:
                  "palti_lorry",

                palti_lorry_id:
                  adj.palti_lorry_id,

                voucher_no:
                  paltiRow.voucher_no ||
                  null,

                lorry_no:
                  paltiRow.reg_lorry_no ||
                  paltiRow.new_lorry_no ||
                  null,

                requested_qty:
                  Number(
                    adjQty.toFixed(
                      4
                    )
                  ),

                available_qty:
                  Number(
                    availableQty.toFixed(
                      4
                    )
                  ),

                difference:
                  Number(
                    (
                      adjQty -
                      availableQty
                    ).toFixed(
                      4
                    )
                  ),
              }
            );
          }

          await getAdjustmentCollection().insertOne(
            {
              outward_id:
                outwardNumericId,

              inward_id:
                null,

              palti_lorry_id:
                paltiId,

              source_type:
                "palti_lorry",

              qty:
                adjQty,

              company_id:
                companyId,

              created_at:
                new Date(),

              updated_at:
                new Date(),
            },
            {
              session,
            }
          );

          continue;
        }

        /*
         * ==================================================
         * INWARD
         * ==================================================
         */

        if (
          !adj.inward_id
        ) {
          throw makeAdjustmentError(
            "Invalid inward adjustment row",
            {
              source_type:
                adj.source_type,

              inward_id:
                null,

              qty:
                adjQty,
            }
          );
        }

        const inwardFilter =
          buildFlexibleIdFilter(
            adj.inward_id
          );

        const inwardRow =
          await MongoInward.findOne(
            inwardFilter
          )
            .session(
              session
            );

        if (!inwardRow) {
          throw makeAdjustmentError(
            `Invalid inward_id ${adj.inward_id}`,
            {
              source_type:
                adj.source_type,

              inward_id:
                adj.inward_id,

              qty:
                adjQty,
            }
          );
        }

        const inwardNumericId =
          Number(
            inwardRow.legacy_id ??
              inwardRow.id ??
              inwardRow.sl_no
          );

        if (
          !Number.isFinite(
            inwardNumericId
          )
        ) {
          throw makeAdjustmentError(
            "Inward does not have a valid legacy ID",
            {
              inward_id:
                adj.inward_id,
            }
          );
        }

        if (
          String(
            inwardRow.company_id
          ) !==
          companyId
        ) {
          throw makeAdjustmentError(
            `Company mismatch for inward_id ${adj.inward_id}`,
            {
              source_type:
                "inward",

              inward_id:
                adj.inward_id,

              company_id:
                companyId,

              row_company_id:
                inwardRow.company_id,

              qty:
                adjQty,
            }
          );
        }

        const outwardWarehouse =
          String(
            outward.warehouse_id ||
              ""
          );

        const inwardWarehouse =
          String(
            inwardRow.warehouse_id ||
              ""
          );

        if (
          outwardWarehouse
        ) {
          if (
            outwardWarehouse !==
            inwardWarehouse
          ) {
            throw makeAdjustmentError(
              `Warehouse mismatch for inward_id ${adj.inward_id}`,
              {
                outward_warehouse_id:
                  outwardWarehouse,

                row_warehouse_id:
                  inwardWarehouse,
              }
            );
          }
        }

        const shortagePercent =
          await resolveShortagePercent(
            inwardRow
          );

        const slab =
          calculateMonthSlab(
            inwardRow.date,
            outward.date
          );

        const grossQty =
          normalizeQty(
            inwardRow.weight ??
              inwardRow.quantity
          );

        const alreadyAdjustedForThisInward =
          await getAdjustedQtyForInward(
            inwardNumericId,
            session
          );

        const shortageQty =
          normalizeQty(
            calculateShortageQty(
              grossQty,
              slab.monthsDiff,
              shortagePercent
            )
          );

        const netOpeningQty =
          normalizeQty(
            grossQty -
              shortageQty
          );

        const availableQty =
          normalizeQty(
            netOpeningQty -
              alreadyAdjustedForThisInward
          );

        if (
          adjQty -
            availableQty >
          EPS
        ) {
          throw makeAdjustmentError(
            `Adjusted qty exceeds available qty for inward_id ${adj.inward_id}`,
            {
              source_type:
                "inward",

              inward_id:
                adj.inward_id,

              voucher_no:
                inwardRow.voucher_no ||
                null,

              lorry_no:
                inwardRow.lorry_no ||
                null,

              requested_qty:
                Number(
                  adjQty.toFixed(
                    4
                  )
                ),

              available_qty:
                Number(
                  availableQty.toFixed(
                    4
                  )
                ),

              difference:
                Number(
                  (
                    adjQty -
                    availableQty
                  ).toFixed(
                    4
                  )
                ),
            }
          );
        }

        const currentRemaining =
          normalizeQty(
            inwardRow.remaining_qty ??
              grossQty
          );

        if (
          adjQty -
            currentRemaining >
          EPS
        ) {
          throw makeAdjustmentError(
            `Adjustment exceeds current remaining quantity for inward_id ${adj.inward_id}`,
            {
              requested_qty:
                adjQty,

              remaining_qty:
                currentRemaining,
            }
          );
        }

        await MongoInward.updateOne(
          {
            _id:
              inwardRow._id,
          },
          {
            $inc: {
              remaining_qty:
                -adjQty,
            },

            $set: {
              updated_at:
                new Date(),
            },
          },
          {
            session,
          }
        );

        await getAdjustmentCollection().insertOne(
          {
            outward_id:
              outwardNumericId,

            inward_id:
              inwardNumericId,

            palti_lorry_id:
              null,

            source_type:
              "inward",

            qty:
              adjQty,

            company_id:
              companyId,

            created_at:
              new Date(),

            updated_at:
              new Date(),
          },
          {
            session,
          }
        );
      }

      const finalStatus =
        Math.abs(
          totalAdjust -
            remainingToAdjust
        ) <
        0.0001
          ? "Completed"
          : "Partial";

      await MongoOutward.updateOne(
        {
          _id:
            outward._id,
        },
        {
          $set: {
            status:
              finalStatus,

            updated_at:
              new Date(),
          },
        },
        {
          session,
        }
      );

      await session.commitTransaction();

      return res.json({
        message:
          "Adjustment Saved Successfully",

        status:
          finalStatus,
      });
    } catch (err) {
      if (session) {
        await session
          .abortTransaction()
          .catch(
            () => {}
          );
      }

      console.error(
        "[adjustment final-save] error:",
        err
      );

      return res.status(
        Number(
          err?.status
        ) || 500
      ).json({
        error:
          err?.message ||
          "Adjustment save failed",

        details:
          err?.details ||
          null,
      });
    } finally {
      if (session) {
        await session.endSession();
      }
    }
  }
);

/*
====================================================
GET ADJUSTMENT LOG
====================================================
*/

router.get(
  "/:id",
  async (req, res) => {
    if (
      !canViewAdjustment(
        req.user
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to view adjustments",
      });
    }

    try {
      if (!requireMongo(res)) {
        return;
      }

      const outwardFilter =
        buildFlexibleIdFilter(
          req.params.id
        );

      if (!outwardFilter) {
        return res.status(400).json({
          error:
            "Invalid outward id",
        });
      }

      const outward =
        await MongoOutward.findOne(
          outwardFilter
        ).lean();

      if (!outward) {
        return res.status(404).json({
          error:
            "Outward not found",
        });
      }

      const outwardNumericId =
        Number(
          outward.legacy_id ??
            outward.id ??
            outward.sl_no
        );

      const collection =
        getAdjustmentCollection();

      const rows =
        await collection
          .find({
            outward_id:
              outwardNumericId,
          })
          .sort({
            created_at:
              1,
          })
          .toArray();

      const result =
        [];

      for (
        const row of
          rows
      ) {
        let inward =
          null;

        let palti =
          null;

        let company =
          null;

        let warehouse =
          null;

        if (
          row.inward_id !=
          null
        ) {
          inward =
            await MongoInward.findOne(
              buildFlexibleIdFilter(
                row.inward_id
              )
            )
              .lean();
        }

        if (
          row.palti_lorry_id !=
          null
        ) {
          palti =
            await getPaltiCollection().findOne(
              buildFlexibleIdFilter(
                row.palti_lorry_id
              )
            );
        }

        const companyId =
          inward?.company_id ??
          palti?.company_id;

        if (
          companyId !=
            null
        ) {
          company =
            await MongoCompany.findOne(
              buildFlexibleIdFilter(
                companyId
              )
            )
              .select({
                name: 1,
              })
              .lean();
        }

        const warehouseId =
          inward?.warehouse_id ??
          palti?.warehouse_id;

        if (
          warehouseId !=
            null
        ) {
          warehouse =
            await MongoWarehouse.findOne(
              buildFlexibleIdFilter(
                warehouseId
              )
            )
              .select({
                name: 1,
              })
              .lean();
        }

        result.push({
          id:
            row._id
              ? String(
                  row._id
                )
              : null,

          qty:
            normalizeQty(
              row.qty
            ),

          inward_voucher:
            inward?.voucher_no ??
            palti?.voucher_no ??
            null,

          lorry_no:
            normalizeText(
              inward?.lorry_no
            ) ||
            normalizeText(
              palti?.reg_lorry_no
            ) ||
            normalizeText(
              palti?.new_lorry_no
            ) ||
            "-",

          inward_date:
            inward?.date ??
            palti?.expense_date ??
            null,

          company_name:
            company?.name ||
            "",

          warehouse_name:
            warehouse?.name ||
            "",

          source_type:
            row.source_type ||
            "inward",

          outward_id:
            outwardNumericId,

          inward_id:
            row.inward_id ??
            null,

          palti_lorry_id:
            row.palti_lorry_id ??
            null,

          created_at:
            row.created_at ||
            null,

          updated_at:
            row.updated_at ||
            null,
        });
      }

      return res.json(
        result
      );
    } catch (err) {
      console.error(
        "[adjustment log] error:",
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
UPDATE ADJUSTMENT LOG
====================================================
*/

async function updateAdjustment(
  req,
  res
) {
  if (
    !canManageAdjustment(
      req.user
    )
  ) {
    return res.status(403).json({
      error:
        "You do not have permission to update adjustments",
    });
  }

  let session = null;

  try {
    if (!requireMongo(res)) {
      return;
    }

    const adjustmentObjectId =
      mongoose.Types.ObjectId.isValid(
        String(
          req.params.id
        )
      )
        ? new mongoose.Types.ObjectId(
            String(
              req.params.id
            )
          )
        : null;

    if (!adjustmentObjectId) {
      return res.status(400).json({
        error:
          "Invalid adjustment id",
      });
    }

    const newQty =
      normalizeQty(
        req.body?.qty
      );

    if (
      newQty <=
      0
    ) {
      return res.status(400).json({
        error:
          "Valid qty required",
      });
    }

    const collection =
      getAdjustmentCollection();

    const row =
      await collection.findOne({
        _id:
          adjustmentObjectId,
      });

    if (!row) {
      return res.status(404).json({
        error:
          "Adjustment not found",
      });
    }

    const outward =
      await MongoOutward.findOne(
        buildFlexibleIdFilter(
          row.outward_id
        )
      ).lean();

    if (!outward) {
      return res.status(404).json({
        error:
          "Outward not found",
      });
    }

    const outwardNumericId =
      Number(
        outward.legacy_id ??
          outward.id ??
          outward.sl_no
      );

    const oldQty =
      normalizeQty(
        row.qty
      );

    const isPalti =
      String(
        row.source_type ||
          ""
      )
        .trim()
        .toLowerCase() ===
        "palti_lorry" ||
      Number(
        row.palti_lorry_id
      ) > 0;

    const otherOutwardAdjusted =
      await getAdjustedQtyForOutward(
        outwardNumericId,
        null,
        adjustmentObjectId
      );

    const outwardQty =
      normalizeQty(
        outward.quantity
      );

    if (
      otherOutwardAdjusted +
        newQty -
        outwardQty >
      EPS
    ) {
      return res.status(400).json({
        error:
          "Updated qty exceeds outward qty",
      });
    }

    let availableQty =
      0;

    let sourceRow =
      null;

    if (isPalti) {
      sourceRow =
        await getPaltiCollection().findOne(
          buildFlexibleIdFilter(
            row.palti_lorry_id
          )
        );

      if (!sourceRow) {
        return res.status(404).json({
          error:
            "Palti Lorry source not found",
        });
      }

      const paltiId =
        Number(
          sourceRow.legacy_id ??
            sourceRow.id ??
            sourceRow.sl_no
        );

      const otherAdjusted =
        await getAdjustedQtyForPalti(
          paltiId,
          null,
          adjustmentObjectId
        );

      availableQty =
        normalizeQty(
          getPaltiQty(
            sourceRow
          ) -
            otherAdjusted
        );
    } else {
      sourceRow =
        await MongoInward.findOne(
          buildFlexibleIdFilter(
            row.inward_id
          )
        ).lean();

      if (!sourceRow) {
        return res.status(404).json({
          error:
            "Inward source not found",
        });
      }

      const inwardId =
        Number(
          sourceRow.legacy_id ??
            sourceRow.id ??
            sourceRow.sl_no
        );

      const shortagePercent =
        await resolveShortagePercent(
          sourceRow
        );

      const slab =
        calculateMonthSlab(
          sourceRow.date,
          outward.date
        );

      const grossQty =
        normalizeQty(
          sourceRow.weight ??
            sourceRow.quantity
        );

      const shortageQty =
        normalizeQty(
          calculateShortageQty(
            grossQty,
            slab.monthsDiff,
            shortagePercent
          )
        );

      const otherAdjusted =
        await getAdjustedQtyForInward(
          inwardId,
          null,
          adjustmentObjectId
        );

      availableQty =
        normalizeQty(
          grossQty -
            shortageQty -
            otherAdjusted
        );
    }

    if (
      newQty -
        availableQty >
      EPS
    ) {
      return res.status(400).json({
        error:
          "Updated qty exceeds available qty",
      });
    }

    session =
      await mongoose.startSession();

    session.startTransaction();

    await collection.updateOne(
      {
        _id:
          adjustmentObjectId,
      },
      {
        $set: {
          qty:
            newQty,

          updated_at:
            new Date(),
        },
      },
      {
        session,
      }
    );

    if (
      !isPalti
    ) {
      const difference =
        normalizeQty(
          oldQty -
            newQty
        );

      await MongoInward.updateOne(
        buildFlexibleIdFilter(
          row.inward_id
        ),
        {
          $inc: {
            remaining_qty:
              difference,
          },

          $set: {
            updated_at:
              new Date(),
          },
        },
        {
          session,
        }
      );
    }

    const finalTotal =
      await getAdjustedQtyForOutward(
        outwardNumericId,
        session
      );

    const status =
      finalTotal >=
      outwardQty
        ? "Completed"
        : finalTotal >
          0
        ? "Partial"
        : "Pending";

    await MongoOutward.updateOne(
      buildFlexibleIdFilter(
        outwardNumericId
      ),
      {
        $set: {
          status,

          updated_at:
            new Date(),
        },
      },
      {
        session,
      }
    );

    await session.commitTransaction();

    return res.json({
      message:
        "Adjustment updated successfully",

      status,
    });
  } catch (err) {
    if (session) {
      await session
        .abortTransaction()
        .catch(
          () => {}
        );
    }

    console.error(
      "[adjustment update] error:",
      err
    );

    return res.status(
      Number(
        err?.status
      ) || 500
    ).json({
      error:
        err?.message ||
        "Adjustment update failed",
    });
  } finally {
    if (session) {
      await session.endSession();
    }
  }
}

router.put(
  "/log/:id",
  updateAdjustment
);

router.post(
  "/log/:id/update",
  updateAdjustment
);

/*
====================================================
DELETE ADJUSTMENT LOG
====================================================
*/

async function deleteAdjustment(
  req,
  res
) {
  if (
    !canManageAdjustment(
      req.user
    )
  ) {
    return res.status(403).json({
      error:
        "You do not have permission to delete adjustments",
    });
  }

  let session = null;

  try {
    if (!requireMongo(res)) {
      return;
    }

    const adjustmentId =
      mongoose.Types.ObjectId.isValid(
        String(
          req.params.id
        )
      )
        ? new mongoose.Types.ObjectId(
            String(
              req.params.id
            )
          )
        : null;

    if (!adjustmentId) {
      return res.status(400).json({
        error:
          "Invalid adjustment id",
      });
    }

    const collection =
      getAdjustmentCollection();

    const row =
      await collection.findOne({
        _id:
          adjustmentId,
      });

    if (!row) {
      return res.json({
        message:
          "Adjustment already deleted",
      });
    }

    const outward =
      await MongoOutward.findOne(
        buildFlexibleIdFilter(
          row.outward_id
        )
      ).lean();

    const outwardQty =
      normalizeQty(
        outward?.quantity
      );

    const isPalti =
      String(
        row.source_type ||
          ""
      )
        .trim()
        .toLowerCase() ===
        "palti_lorry" ||
      Number(
        row.palti_lorry_id
      ) > 0;

    session =
      await mongoose.startSession();

    session.startTransaction();

    if (
      !isPalti &&
      row.inward_id !=
        null
    ) {
      const inwardFilter =
        buildFlexibleIdFilter(
          row.inward_id
        );

      await MongoInward.updateOne(
        inwardFilter,
        {
          $inc: {
            remaining_qty:
              normalizeQty(
                row.qty
              ),
          },

          $set: {
            updated_at:
              new Date(),
          },
        },
        {
          session,
        }
      );
    }

    await collection.deleteOne(
      {
        _id:
          adjustmentId,
      },
      {
        session,
      }
    );

    if (outward) {
      const outwardNumericId =
        Number(
          outward.legacy_id ??
            outward.id ??
            outward.sl_no
        );

      const totalAdj =
        await getAdjustedQtyForOutward(
          outwardNumericId,
          session
        );

      const status =
        totalAdj >=
        outwardQty
          ? "Completed"
          : totalAdj >
            0
          ? "Partial"
          : "Pending";

      await MongoOutward.updateOne(
        {
          _id:
            outward._id,
        },
        {
          $set: {
            status,

            updated_at:
              new Date(),
          },
        },
        {
          session,
        }
      );
    }

    await session.commitTransaction();

    return res.json({
      message:
        "Adjustment deleted successfully",

      deleted:
        1,

      source:
        "mongodb",
    });
  } catch (err) {
    if (session) {
      await session
        .abortTransaction()
        .catch(
          () => {}
        );
    }

    console.error(
      "[adjustment delete] error:",
      err
    );

    return res.status(
      Number(
        err?.status
      ) || 500
    ).json({
      error:
        err?.message ||
        "Adjustment delete failed",
    });
  } finally {
    if (session) {
      await session.endSession();
    }
  }
}

router.delete(
  "/log/:id",
  deleteAdjustment
);

router.post(
  "/log/:id/delete",
  deleteAdjustment
);

module.exports = router;
