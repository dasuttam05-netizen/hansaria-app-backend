const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

const {
  mongoose: MongoMongoose,
  SaleVoucher,
  CompanyAccount,
  Product,
  Company,
  Warehouse,
} = require("../mongo");

const {
  BuyerName,
  ConsigneeName,
} = require("../db-mongodb");

const {
  TransportBiltiOperational,
  TransporterOperational,
  OutwardOperational,
  CompanyOperational,
  CompanyAccountOperational,
  WarehouseOperational,
  ProductOperational,
} = require("../mongoOperationalModels");

/*
====================================================
COMMON HELPERS
====================================================
*/

const mongoReady = () =>
  mongoose.connection.readyState === 1;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const text = (v) =>
  v === undefined ||
  v === null
    ? ""
    : String(v).trim();

function normalizeMongoDoc(doc) {
  if (!doc) return null;

  const row = doc.toObject
    ? doc.toObject()
    : { ...doc };

  row.id =
    row.id ??
    row.legacy_id ??
    String(row._id);

  row._id =
    String(row._id);

  return row;
}

function idConditions(value) {
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

function idQuery(value) {
  const conditions =
    idConditions(value);

  if (!conditions.length) {
    return null;
  }

  return conditions.length === 1
    ? conditions[0]
    : {
        $or: conditions,
      };
}

async function findByIdFlexible(
  Model,
  value
) {
  const query =
    idQuery(value);

  if (!query) {
    return null;
  }

  return Model.findOne(
    query
  ).lean();
}

/*
====================================================
MASTER LOOKUP
====================================================
*/

async function getMongoName(
  Model,
  id,
  fields = ["name"]
) {
  if (
    id === undefined ||
    id === null ||
    id === ""
  ) {
    return "";
  }

  const doc =
    await findByIdFlexible(
      Model,
      id
    );

  if (!doc) {
    return "";
  }

  for (
    const field of
      fields
  ) {
    if (
      doc[field] !==
        undefined &&
      doc[field] !==
        null &&
      String(
        doc[field]
      ).trim()
    ) {
      return String(
        doc[field]
      );
    }
  }

  return "";
}

async function getMongoTransporter(
  id
) {
  if (!id) {
    return null;
  }

  const q =
    idQuery(id);

  if (!q) {
    return null;
  }

  return TransporterOperational.findOne(
    q
  ).lean();
}

/*
====================================================
CALCULATION
====================================================
*/

function calculateBilti(
  data
) {
  const CLAIM_FREE_SHORTAGE_KG =
    num(
      data.shortage_free_kg
    ) > 0
      ? num(
          data.shortage_free_kg
        )
      : 100;

  const KG_PER_MT =
    1000;

  const outwardQty =
    num(
      data.outward_qty
    );

  const dispatchQty =
    num(
      data.dispatch_qty
    );

  const outwardRate =
    num(
      data.outward_rate
    );

  const transportRate =
    num(
      data.transport_rate
    );

  const detainAmount =
    num(
      data.detain_amount
    );

  const othersExp =
    num(
      data.others_exp
    );

  const advanceAmount =
    num(
      data.advance_amount
    );

  const tdsPercent =
    num(
      data.tds_percent
    );

  const shortageQty =
    Math.max(
      outwardQty -
        dispatchQty,
      0
    );

  const claimFreeQtyInMt =
    CLAIM_FREE_SHORTAGE_KG /
    KG_PER_MT;

  const chargeableShortageQty =
    Math.max(
      shortageQty -
        claimFreeQtyInMt,
      0
    );

  const shortageAmount =
    chargeableShortageQty *
    outwardRate;

  const grossFreight =
    outwardQty *
    transportRate;

  const netAmount =
    grossFreight -
    shortageAmount +
    detainAmount +
    othersExp;

  const tdsAmount =
    netAmount *
    (tdsPercent / 100);

  const payableAmount =
    netAmount -
    advanceAmount -
    tdsAmount;

  return {
    outward_qty:
      outwardQty,

    dispatch_qty:
      dispatchQty,

    shortage_free_kg:
      CLAIM_FREE_SHORTAGE_KG,

    shortage_qty:
      shortageQty,

    outward_rate:
      outwardRate,

    shortage_amount:
      shortageAmount,

    transport_rate:
      transportRate,

    gross_freight:
      grossFreight,

    detain_amount:
      detainAmount,

    others_exp:
      othersExp,

    advance_amount:
      advanceAmount,

    tds_percent:
      tdsPercent,

    tds_amount:
      tdsAmount,

    net_amount:
      netAmount,

    payable_amount:
      payableAmount,
  };
}

function applyCalculatedBilti(
  row
) {
  const computed =
    calculateBilti(
      row || {}
    );

  return {
    ...row,
    ...computed,
  };
}

/*
====================================================
BILTI DECORATION
====================================================
*/

async function decorateMongoBilti(
  row
) {
  const r =
    normalizeMongoDoc(
      row
    ) || {};

  const transporter =
    await getMongoTransporter(
      r.transporter_id
    );

  const [
    companyName,
    accountName,
    warehouseName,
    productName,
  ] =
    await Promise.all([
      r.company_name
        ? String(
            r.company_name
          )
        : getMongoName(
            CompanyOperational,
            r.company_id,
            ["name"]
          ),

      r.account_name
        ? String(
            r.account_name
          )
        : getMongoName(
            CompanyAccountOperational,
            r.company_account_id,
            [
              "account_name",
              "name",
            ]
          ),

      r.warehouse_name
        ? String(
            r.warehouse_name
          )
        : getMongoName(
            WarehouseOperational,
            r.warehouse_id,
            ["name"]
          ),

      r.product_name
        ? String(
            r.product_name
          )
        : getMongoName(
            ProductOperational,
            r.product_id,
            ["name"]
          ),
    ]);

  return applyCalculatedBilti({
    ...r,

    transporter_name:
      r.transporter_name ||
      transporter?.name ||
      "",

    transporter_address:
      r.transporter_address ||
      transporter?.address ||
      "",

    transporter_pan_no:
      r.transporter_pan_no ||
      transporter?.pan_no ||
      "",

    transporter_mobile:
      r.transporter_mobile ||
      transporter?.mobile ||
      "",

    company_name:
      companyName,

    account_name:
      accountName,

    warehouse_name:
      warehouseName,

    product_name:
      productName,
  });
}

/*
====================================================
SALE DECORATION
====================================================
*/

async function decorateMongoSale(
  row
) {
  const buyerId =
    row?.buyer_id;

  const companyId =
    row?.company_id;

  const accountId =
    row?.company_account_id;

  const warehouseId =
    row?.warehouse_id;

  const productId =
    row?.product_id;

  const consigneeId =
    row?.consignee_id;

  const [
    buyerName,
    companyName,
    accountName,
    warehouseName,
    productName,
    consigneeName,
  ] =
    await Promise.all([
      getMongoName(
        BuyerName,
        buyerId,
        ["name"]
      ),

      row.company_name
        ? String(
            row.company_name
          )
        : getMongoName(
            CompanyOperational,
            companyId,
            ["name"]
          ),

      row.company_account_name
        ? String(
            row.company_account_name
          )
        : getMongoName(
            CompanyAccountOperational,
            accountId,
            [
              "account_name",
              "name",
            ]
          ),

      row.warehouse_name
        ? String(
            row.warehouse_name
          )
        : getMongoName(
            WarehouseOperational,
            warehouseId,
            ["name"]
          ),

      row.product_name
        ? String(
            row.product_name
          )
        : getMongoName(
            ProductOperational,
            productId,
            ["name"]
          ),

      getMongoName(
        ConsigneeName,
        consigneeId,
        ["name"]
      ),
    ]);

  return {
    ...row,

    sale_buyer_name:
      row.buyer_name ||
      buyerName ||
      companyName ||
      row.company_name ||
      "",

    sale_account_name:
      row.company_account_name ||
      accountName ||
      row.account_name ||
      "",

    sale_warehouse_name:
      row.warehouse_name ||
      warehouseName ||
      "",

    sale_product_name:
      row.product_name ||
      productName ||
      "",

    sale_consignee_name:
      row.consignee_name ||
      consigneeName ||
      "",
  };
}

/*
====================================================
OUTWARD DECORATION
====================================================
*/

async function decorateMongoOutward(
  row
) {
  if (!row) {
    return null;
  }

  const [
    companyName,
    accountName,
    warehouseName,
    productName,
  ] =
    await Promise.all([
      row.company_name ||
        getMongoName(
          CompanyOperational,
          row.company_id,
          ["name"]
        ),

      row.company_account_name ||
        getMongoName(
          CompanyAccountOperational,
          row.company_account_id,
          [
            "account_name",
            "name",
          ]
        ),

      row.warehouse_name ||
        getMongoName(
          WarehouseOperational,
          row.warehouse_id,
          ["name"]
        ),

      row.product_name ||
        getMongoName(
          ProductOperational,
          row.product_id,
          ["name"]
        ),
    ]);

  return {
    ...row,

    company_name:
      companyName || "",

    company_account_name:
      accountName || "",

    account_name:
      accountName || "",

    warehouse_name:
      warehouseName || "",

    product_name:
      productName || "",
  };
}

/*
====================================================
NEXT BILTI NUMBER
====================================================
*/

async function nextBiltiNo() {
  const last =
    await TransportBiltiOperational.findOne({
      legacy_id: {
        $type:
          "number",
      },
    })
      .sort({
        legacy_id: -1,
      })
      .select({
        legacy_id: 1,
      })
      .lean();

  const next =
    Number(
      last?.legacy_id || 0
    ) + 1;

  return {
    legacyId:
      next,

    biltiNo:
      `BLT${String(
        next
      ).padStart(4, "0")}`,
  };
}

/*
====================================================
OUTWARD LIST
====================================================
*/

router.get(
  "/outward-list",
  async (req, res) => {
    try {
      if (!mongoReady()) {
        return res.status(503).json({
          error:
            "MongoDB is not connected",
        });
      }

      const [
        rows,
        biltiRows,
      ] =
        await Promise.all([
          OutwardOperational.find({})
            .sort({
              date: -1,
              legacy_id: -1,
              _id: -1,
            })
            .lean(),

          TransportBiltiOperational.find({
            outward_id: {
              $nin: [
                null,
                "",
              ],
            },
          })
            .select({
              legacy_id: 1,
              outward_id: 1,
            })
            .lean(),
        ]);

      const biltiMap =
        new Map();

      for (
        const b of
          biltiRows || []
      ) {
        biltiMap.set(
          String(
            b.outward_id
          ),
          b.legacy_id ??
            String(
              b._id
            )
        );
      }

      const result =
        [];

      for (
        const row of
          rows || []
      ) {
        const id =
          row.legacy_id ??
          row.id ??
          row.sl_no ??
          row._id;

        const decorated =
          await decorateMongoOutward(
            row
          );

        result.push({
          id:
            String(id),

          bilti_id:
            biltiMap.get(
              String(id)
            ) ||
            null,

          voucher_no:
            decorated.voucher_no ||
            decorated.outward_no ||
            decorated.inv_no ||
            "",

          date:
            decorated.date ||
            "",

          lorry_no:
            decorated.lorry_no ||
            "",

          quantity:
            num(
              decorated.quantity ||
                decorated.weight
            ),

          weight:
            num(
              decorated.weight ||
                decorated.quantity
            ),

          rate:
            num(
              decorated.rate
            ),

          buyer_name:
            decorated.buyer_name ||
            decorated.company_name ||
            "",

          consignee_name:
            decorated.consignee_name ||
            "",

          company_name:
            decorated.company_name ||
            "",

          account_name:
            decorated.company_account_name ||
            decorated.account_name ||
            "",

          warehouse_name:
            decorated.warehouse_name ||
            "",

          product_name:
            decorated.product_name ||
            "",

          source:
            "mongo",
        });
      }

      return res.json(
        result
      );
    } catch (err) {
      console.error(
        "Mongo outward-list failed:",
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
SALE LIST
====================================================
*/

router.get(
  "/sale-list",
  async (req, res) => {
    try {
      if (!mongoReady()) {
        return res.status(503).json({
          error:
            "MongoDB is not connected",
        });
      }

      const biltiRows =
        await TransportBiltiOperational.find({
          sale_id: {
            $nin: [
              null,
              "",
            ],
          },
        })
          .select({
            sale_id: 1,
            legacy_id: 1,
          })
          .lean();

      const alreadyBiltied =
        new Set(
          (
            biltiRows || []
          ).map(
            (row) =>
              String(
                row.sale_id
              )
          )
        );

      const docs =
        await SaleVoucher.find({})
          .sort({
            date: -1,
            createdAt: -1,
            _id: -1,
          })
          .lean();

      const pending =
        [];

      for (
        const doc of
          docs || []
      ) {
        const mongoId =
          String(
            doc._id || ""
          );

        if (
          !mongoId ||
          alreadyBiltied.has(
            mongoId
          )
        ) {
          continue;
        }

        const decorated =
          await decorateMongoSale(
            doc
          );

        pending.push({
          id:
            mongoId,

          sale_id:
            mongoId,

          bilti_id:
            null,

          voucher_no:
            decorated.voucher_no ||
            decorated.bill_no ||
            "",

          date:
            decorated.date ||
            decorated.bill_date ||
            "",

          lorry_no:
            decorated.lorry_no ||
            "",

          quantity:
            num(
              decorated.quantity
            ),

          unloading_qty:
            num(
              decorated.unloading_qty
            ),

          rate:
            num(
              decorated.rate
            ),

          amount:
            num(
              decorated.amount
            ),

          buyer_name:
            decorated.sale_buyer_name ||
            decorated.buyer_name ||
            decorated.company_name ||
            "",

          consignee_name:
            decorated.sale_consignee_name ||
            decorated.consignee_name ||
            "",

          account_name:
            decorated.sale_account_name ||
            decorated.company_account_name ||
            decorated.account_name ||
            "",

          warehouse_name:
            decorated.sale_warehouse_name ||
            decorated.warehouse_name ||
            "",

          product_name:
            decorated.sale_product_name ||
            decorated.product_name ||
            "",

          source:
            "mongo",
        });
      }

      return res.json(
        pending
      );
    } catch (err) {
      console.error(
        "Mongo sale-list failed:",
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
REPORT LIST
====================================================
*/

router.get(
  "/report/list",
  async (req, res) => {
    try {
      if (!mongoReady()) {
        return res.status(503).json({
          error:
            "MongoDB is not connected",
        });
      }

      const fromDate =
        text(
          req.query.from_date
        );

      const toDate =
        text(
          req.query.to_date
        );

      const filter = {};

      if (
        fromDate ||
        toDate
      ) {
        filter.dispatch_date = {};

        if (fromDate) {
          filter.dispatch_date.$gte =
            fromDate;
        }

        if (toDate) {
          filter.dispatch_date.$lte =
            toDate;
        }
      }

      const rows =
        await TransportBiltiOperational.find(
          filter
        )
          .sort({
            dispatch_date: -1,
            legacy_id: -1,
            _id: -1,
          })
          .lean();

      const output =
        [];

      for (
        const row of
          rows
      ) {
        const decorated =
          await decorateMongoBilti(
            row
          );

        let sale =
          null;

        let outward =
          null;

        if (
          row.sale_id
        ) {
          sale =
            await findByIdFlexible(
              SaleVoucher,
              row.sale_id
            );
        }

        if (
          row.outward_id
        ) {
          outward =
            await findByIdFlexible(
              OutwardOperational,
              row.outward_id
            );
        }

        const decoratedSale =
          sale
            ? await decorateMongoSale(
                sale
              )
            : null;

        const decoratedOutward =
          outward
            ? await decorateMongoOutward(
                outward
              )
            : null;

        output.push({
          ...decorated,

          outward_voucher_no:
            decoratedOutward?.voucher_no ||
            decoratedOutward?.outward_no ||
            "",

          outward_entry_date:
            decoratedOutward?.date ||
            "",

          outward_buyer_name:
            decoratedOutward?.buyer_name ||
            decoratedOutward?.company_name ||
            "",

          outward_consignee_name:
            decoratedOutward?.consignee_name ||
            "",

          outward_lorry_no:
            decoratedOutward?.lorry_no ||
            "",

          outward_company_name:
            decoratedOutward?.company_name ||
            "",

          outward_account_name:
            decoratedOutward?.company_account_name ||
            "",

          outward_warehouse_name:
            decoratedOutward?.warehouse_name ||
            "",

          outward_product_name:
            decoratedOutward?.product_name ||
            "",

          sale_voucher_no:
            decoratedSale?.voucher_no ||
            decoratedSale?.bill_no ||
            "",

          sale_entry_date:
            decoratedSale?.date ||
            "",

          sale_quantity:
            num(
              decoratedSale?.quantity
            ),

          sale_unloading_qty:
            num(
              decoratedSale?.unloading_qty
            ),

          sale_master_rate:
            num(
              decoratedSale?.rate
            ),

          sale_lorry_no:
            decoratedSale?.lorry_no ||
            "",

          sale_buyer_name:
            decoratedSale?.sale_buyer_name ||
            "",

          sale_consignee_name:
            decoratedSale?.sale_consignee_name ||
            "",

          sale_account_name:
            decoratedSale?.sale_account_name ||
            "",

          sale_warehouse_name:
            decoratedSale?.sale_warehouse_name ||
            "",

          sale_product_name:
            decoratedSale?.sale_product_name ||
            "",
        });
      }

      return res.json(
        output
      );
    } catch (err) {
      console.error(
        "Mongo transport report failed:",
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
GET ONE BILTI
====================================================
*/

router.get(
  "/:id",
  async (req, res) => {
    try {
      if (!mongoReady()) {
        return res.status(503).json({
          error:
            "MongoDB is not connected",
        });
      }

      const id =
        text(
          req.params.id
        );

      /*
       * Source = sale
       */
      if (
        req.query.source ===
        "sale"
      ) {
        const sale =
          await findByIdFlexible(
            SaleVoucher,
            id
          );

        if (!sale) {
          return res.status(404).json({
            error:
              "Sale not found",
          });
        }

        const decoratedSale =
          await decorateMongoSale(
            sale
          );

        const saleWeight =
          num(
            decoratedSale.unloading_qty ||
              decoratedSale.quantity
          );

        return res.json(
          applyCalculatedBilti({
            id:
              null,

            outward_id:
              null,

            sale_id:
              String(
                decoratedSale._id
              ),

            bilti_no:
              "",

            transporter_id:
              "",

            transporter_name:
              "",

            transporter_address:
              "",

            transporter_pan_no:
              "",

            transporter_mobile:
              "",

            dispatch_date:
              decoratedSale.unloading_date ||
              decoratedSale.date ||
              "",

            destination:
              "",

            days:
              0,

            outward_qty:
              saleWeight,

            dispatch_qty:
              saleWeight,

            shortage_free_kg:
              100,

            shortage_qty:
              0,

            outward_rate:
              num(
                decoratedSale.rate
              ),

            transport_rate:
              0,

            detain_amount:
              0,

            others_exp:
              0,

            advance_amount:
              0,

            tds_percent:
              0,

            narration:
              "",

            sale_voucher_no:
              decoratedSale.voucher_no ||
              decoratedSale.bill_no ||
              "",

            sale_entry_date:
              decoratedSale.date ||
              "",

            sale_unloading_date:
              decoratedSale.unloading_date ||
              "",

            sale_quantity:
              num(
                decoratedSale.quantity
              ),

            sale_unloading_qty:
              num(
                decoratedSale.unloading_qty
              ),

            sale_master_rate:
              num(
                decoratedSale.rate
              ),

            sale_lorry_no:
              decoratedSale.lorry_no ||
              "",

            sale_buyer_name:
              decoratedSale.sale_buyer_name ||
              "",

            sale_consignee_name:
              decoratedSale.sale_consignee_name ||
              "",

            sale_account_name:
              decoratedSale.sale_account_name ||
              "",

            sale_warehouse_name:
              decoratedSale.sale_warehouse_name ||
              "",

            sale_product_name:
              decoratedSale.sale_product_name ||
              "",
          })
        );
      }

      /*
       * Existing Bilti
       */
      const bilti =
        await findByIdFlexible(
          TransportBiltiOperational,
          id
        );

      if (bilti) {
        const decorated =
          await decorateMongoBilti(
            bilti
          );

        /*
         * Add linked outward/sale
         * information.
         */
        if (
          bilti.outward_id
        ) {
          const outward =
            await findByIdFlexible(
              OutwardOperational,
              bilti.outward_id
            );

          if (outward) {
            const decoratedOutward =
              await decorateMongoOutward(
                outward
              );

            decorated.outward_voucher_no =
              decoratedOutward.voucher_no ||
              decoratedOutward.outward_no ||
              "";

            decorated.outward_entry_date =
              decoratedOutward.date ||
              "";

            decorated.outward_quantity =
              num(
                decoratedOutward.quantity ||
                  decoratedOutward.weight
              );

            decorated.outward_weight =
              num(
                decoratedOutward.weight
              );

            decorated.outward_master_rate =
              num(
                decoratedOutward.rate
              );

            decorated.outward_buyer_name =
              decoratedOutward.buyer_name ||
              "";

            decorated.outward_consignee_name =
              decoratedOutward.consignee_name ||
              "";

            decorated.outward_lorry_no =
              decoratedOutward.lorry_no ||
              "";

            decorated.outward_company_name =
              decoratedOutward.company_name ||
              "";

            decorated.outward_account_name =
              decoratedOutward.company_account_name ||
              "";

            decorated.outward_warehouse_name =
              decoratedOutward.warehouse_name ||
              "";

            decorated.outward_product_name =
              decoratedOutward.product_name ||
              "";
          }
        }

        if (
          bilti.sale_id
        ) {
          const sale =
            await findByIdFlexible(
              SaleVoucher,
              bilti.sale_id
            );

          if (sale) {
            const decoratedSale =
              await decorateMongoSale(
                sale
              );

            decorated.sale_voucher_no =
              decoratedSale.voucher_no ||
              decoratedSale.bill_no ||
              "";

            decorated.sale_entry_date =
              decoratedSale.date ||
              "";

            decorated.sale_unloading_date =
              decoratedSale.unloading_date ||
              "";

            decorated.sale_quantity =
              num(
                decoratedSale.quantity
              );

            decorated.sale_unloading_qty =
              num(
                decoratedSale.unloading_qty
              );

            decorated.sale_master_rate =
              num(
                decoratedSale.rate
              );

            decorated.sale_lorry_no =
              decoratedSale.lorry_no ||
              "";

            decorated.sale_buyer_name =
              decoratedSale.sale_buyer_name ||
              "";

            decorated.sale_consignee_name =
              decoratedSale.sale_consignee_name ||
              "";

            decorated.sale_account_name =
              decoratedSale.sale_account_name ||
              "";

            decorated.sale_warehouse_name =
              decoratedSale.sale_warehouse_name ||
              "";

            decorated.sale_product_name =
              decoratedSale.sale_product_name ||
              "";
          }
        }

        return res.json(
          decorated
        );
      }

      /*
       * Source = outward
       * If there is no Bilti yet,
       * return a blank Bilti form.
       */
      if (
        req.query.source ===
        "outward"
      ) {
        const outward =
          await findByIdFlexible(
            OutwardOperational,
            id
          );

        if (!outward) {
          return res.status(404).json({
            error:
              "Outward not found",
          });
        }

        const decoratedOutward =
          await decorateMongoOutward(
            outward
          );

        const qty =
          num(
            decoratedOutward.quantity ||
              decoratedOutward.weight
          );

        return res.json(
          applyCalculatedBilti({
            id:
              null,

            outward_id:
              decoratedOutward.legacy_id ??
              decoratedOutward.id ??
              decoratedOutward.sl_no ??
              String(
                decoratedOutward._id
              ),

            bilti_no:
              "",

            transporter_id:
              "",

            transporter_name:
              "",

            transporter_address:
              "",

            transporter_pan_no:
              "",

            transporter_mobile:
              "",

            dispatch_date:
              decoratedOutward.date ||
              "",

            destination:
              "",

            days:
              0,

            outward_qty:
              qty,

            dispatch_qty:
              qty,

            shortage_free_kg:
              100,

            shortage_qty:
              0,

            outward_rate:
              num(
                decoratedOutward.rate
              ),

            transport_rate:
              0,

            detain_amount:
              0,

            others_exp:
              0,

            advance_amount:
              0,

            tds_percent:
              0,

            narration:
              "",

            outward_voucher_no:
              decoratedOutward.voucher_no ||
              decoratedOutward.outward_no ||
              "",

            outward_entry_date:
              decoratedOutward.date ||
              "",

            outward_quantity:
              qty,

            outward_weight:
              num(
                decoratedOutward.weight
              ),

            outward_master_rate:
              num(
                decoratedOutward.rate
              ),

            outward_buyer_name:
              decoratedOutward.buyer_name ||
              "",

            outward_consignee_name:
              decoratedOutward.consignee_name ||
              "",

            outward_lorry_no:
              decoratedOutward.lorry_no ||
              "",

            outward_company_name:
              decoratedOutward.company_name ||
              "",

            outward_account_name:
              decoratedOutward.company_account_name ||
              "",

            outward_warehouse_name:
              decoratedOutward.warehouse_name ||
              "",

            outward_product_name:
              decoratedOutward.product_name ||
              "",
          })
        );
      }

      return res.status(404).json({
        error:
          "Bilti not found",
      });
    } catch (err) {
      console.error(
        "Mongo bilti detail failed:",
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
SAVE / UPDATE BILTI
====================================================
*/

router.post(
  "/save",
  async (req, res) => {
    try {
      if (!mongoReady()) {
        return res.status(503).json({
          error:
            "MongoDB is not connected",
        });
      }

      const {
        id,
        outward_id,
        sale_id,
        transporter_id,
        voucher_no,
        outward_date,
        dispatch_date,
        destination,
        days,
        company_name,
        account_name,
        warehouse_name,
        product_name,
        lorry_no,
        buyer_name,
        consignee_name,
        outward_qty,
        dispatch_qty,
        shortage_free_kg,
        outward_rate,
        transport_rate,
        detain_amount,
        others_exp,
        advance_amount,
        tds_percent,
        narration,
      } = req.body || {};

      if (!transporter_id) {
        return res.status(400).json({
          error:
            "transporter_id required",
        });
      }

      const computed =
        calculateBilti({
          outward_qty,
          dispatch_qty,
          shortage_free_kg,
          outward_rate,
          transport_rate,
          detain_amount,
          others_exp,
          advance_amount,
          tds_percent,
        });

      let sourceOutward =
        null;

      let sourceSale =
        null;

      if (
        outward_id
      ) {
        sourceOutward =
          await findByIdFlexible(
            OutwardOperational,
            outward_id
          );

        if (!sourceOutward) {
          return res.status(404).json({
            error:
              "Outward not found",
          });
        }
      }

      if (
        sale_id
      ) {
        sourceSale =
          await findByIdFlexible(
            SaleVoucher,
            sale_id
          );

        if (!sourceSale) {
          return res.status(404).json({
            error:
              "Sale not found",
          });
        }
      }

      let existing =
        null;

      if (id) {
        existing =
          await findByIdFlexible(
            TransportBiltiOperational,
            id
          );
      }

      if (
        !existing &&
        outward_id
      ) {
        existing =
          await TransportBiltiOperational.findOne(
            {
              outward_id:
                String(
                  outward_id
                ),
            }
          ).lean();

        if (
          !existing &&
          /^\d+$/.test(
            String(
              outward_id
            )
          )
        ) {
          existing =
            await TransportBiltiOperational.findOne(
              {
                outward_id:
                  Number(
                    outward_id
                  ),
              }
            ).lean();
        }
      }

      if (
        !existing &&
        sale_id
      ) {
        existing =
          await TransportBiltiOperational.findOne(
            {
              sale_id:
                String(
                  sale_id
                ),
            }
          ).lean();

        if (
          !existing &&
          /^\d+$/.test(
            String(
              sale_id
            )
          )
        ) {
          existing =
            await TransportBiltiOperational.findOne(
              {
                sale_id:
                  Number(
                    sale_id
                  ),
              }
            ).lean();
        }
      }

      let legacyId =
        Number(
          existing?.legacy_id
        );

      if (
        !Number.isFinite(
          legacyId
        )
      ) {
        const next =
          await nextBiltiNo();

        legacyId =
          next.legacyId;
      }

      const biltiNo =
        existing?.bilti_no ||
        text(
          voucher_no
        ) ||
        `BLT${String(
          legacyId
        ).padStart(
          4,
          "0"
        )}`;

      let finalTransporterId =
        text(
          transporter_id
        );

      const transporter =
        await getMongoTransporter(
          finalTransporterId
        );

      if (
        transporter
      ) {
        finalTransporterId =
          String(
            transporter._id
          );
      }

      const payload = {
        legacy_id:
          Number(
            legacyId
          ),

        outward_id:
          sourceOutward
            ? String(
                sourceOutward.legacy_id ??
                  sourceOutward.id ??
                  sourceOutward.sl_no ??
                  sourceOutward._id
              )
            : (
                existing?.outward_id ??
                (
                  outward_id
                    ? String(
                        outward_id
                      )
                    : null
                )
              ),

        sale_id:
          sourceSale
            ? String(
                sourceSale._id
              )
            : (
                existing?.sale_id ??
                (
                  sale_id
                    ? String(
                        sale_id
                      )
                    : null
                )
              ),

        bilti_no:
          biltiNo,

        transporter_id:
          finalTransporterId,

        voucher_no:
          text(
            voucher_no
          ),

        outward_date:
          text(
            outward_date
          ),

        dispatch_date:
          text(
            dispatch_date
          ),

        destination:
          text(
            destination
          ),

        days:
          num(days),

        company_name:
          text(
            company_name
          ),

        account_name:
          text(
            account_name
          ),

        warehouse_name:
          text(
            warehouse_name
          ),

        product_name:
          text(
            product_name
          ),

        lorry_no:
          text(
            lorry_no
          ),

        buyer_name:
          text(
            buyer_name
          ),

        consignee_name:
          text(
            consignee_name
          ),

        outward_qty:
          computed.outward_qty,

        dispatch_qty:
          computed.dispatch_qty,

        shortage_free_kg:
          computed.shortage_free_kg,

        shortage_qty:
          computed.shortage_qty,

        outward_rate:
          computed.outward_rate,

        shortage_amount:
          computed.shortage_amount,

        transport_rate:
          computed.transport_rate,

        gross_freight:
          computed.gross_freight,

        detain_amount:
          computed.detain_amount,

        others_exp:
          computed.others_exp,

        advance_amount:
          computed.advance_amount,

        tds_percent:
          computed.tds_percent,

        tds_amount:
          computed.tds_amount,

        net_amount:
          computed.net_amount,

        payable_amount:
          computed.payable_amount,

        narration:
          text(
            narration
          ),

        updated_at:
          new Date(),
      };

      let doc;

      if (existing) {
        doc =
          await TransportBiltiOperational.findById(
            existing._id
          );

        if (!doc) {
          return res.status(404).json({
            error:
              "Bilti not found",
          });
        }

        Object.assign(
          doc,
          payload
        );

        await doc.save();
      } else {
        doc =
          await TransportBiltiOperational.create(
            {
              ...payload,
              created_at:
                new Date(),
            }
          );
      }

      const normalized =
        normalizeMongoDoc(
          doc
        );

      return res.json({
        message:
          existing ||
          id
            ? "Bilti updated successfully"
            : `${
                outward_id
                  ? "Outward"
                  : sale_id
                  ? "Sale"
                  : "Manual"
              } bilti created successfully`,

        id:
          normalized.id,

        _id:
          normalized._id,

        legacy_id:
          normalized.legacy_id,

        source:
          "mongodb",
      });
    } catch (err) {
      console.error(
        "Mongo bilti save failed:",
        err
      );

      return res.status(500).json({
        error:
          err.message ||
          "Failed to save bilti",
      });
    }
  }
);

/*
====================================================
DELETE BILTI
====================================================
*/

router.delete(
  "/:id",
  async (req, res) => {
    try {
      if (!mongoReady()) {
        return res.status(503).json({
          error:
            "MongoDB is not connected",
        });
      }

      const id =
        text(
          req.params.id
        );

      const query =
        idQuery(id);

      if (!query) {
        return res.status(400).json({
          error:
            "Invalid bilti id",
        });
      }

      const deleted =
        await TransportBiltiOperational.findOneAndDelete(
          query
        ).lean();

      if (!deleted) {
        return res.status(404).json({
          error:
            "Bilti not found",
        });
      }

      return res.json({
        message:
          "Bilti deleted successfully",

        source:
          "mongodb",
      });
    } catch (err) {
      console.error(
        "Mongo bilti delete failed:",
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

