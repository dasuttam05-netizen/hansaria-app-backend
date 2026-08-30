const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");
const mongoose = require("mongoose");

const {
  ConsigneeName,
  BuyerName,
  isMongoMirrorReady,
} = require("../db-mongodb");

const {
  isAdminUser,
  userHasPermission,
} = require("../middleware/auth");

const upload = multer({
  storage: multer.memoryStorage(),
});

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

function canAccessConsigneeNames(user) {
  return [
    "consigneeNames.view",
    "consigneeNames.create",
    "consigneeNames.edit",
    "consigneeNames.delete",
    "outward.view",
    "outward.create",
    "outward.edit",
    "adjustment.manage",
    "expense.view",
    "expense.create",
    "expense.edit",
    "expense.entry",
  ].some((permission) =>
    userHasPermission(
      user,
      permission
    )
  );
}

function normalize(value) {
  return String(
    value ?? ""
  ).trim();
}

function escapeRegExp(value) {
  return String(
    value || ""
  ).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

/*
====================================================
BUYER ID NORMALIZATION
====================================================
*/

function parseBuyerIds(body = {}) {
  let raw = [];

  if (
    Array.isArray(
      body.buyer_ids
    )
  ) {
    raw =
      body.buyer_ids;
  } else if (
    body.buyer_ids !==
      undefined &&
    body.buyer_ids !==
      null &&
    normalize(
      body.buyer_ids
    )
  ) {
    raw =
      normalize(
        body.buyer_ids
      ).split(
        /[,|;]/
      );
  } else if (
    body.buyer_id !==
      undefined &&
    body.buyer_id !==
      null &&
    normalize(
      body.buyer_id
    )
  ) {
    raw = [
      body.buyer_id,
    ];
  }

  return Array.from(
    new Set(
      raw
        .map((value) =>
          String(
            value
          ).trim()
        )
        .filter(Boolean)
    )
  );
}

function buildRowBody(body = {}) {
  const buyerIds =
    parseBuyerIds(
      body
    );

  return {
    name:
      normalize(
        body.name
      ),

    buyer_id:
      buyerIds[0] ||
      null,

    buyer_ids:
      buyerIds,

    mobile:
      normalize(
        body.mobile
      ) || null,

    email:
      normalize(
        body.email
      ) || null,

    address:
      normalize(
        body.address
      ) || null,

    gst_no:
      normalize(
        body.gst_no
      ) || null,

    pan_no:
      normalize(
        body.pan_no
      ) || null,

    state:
      normalize(
        body.state
      ) || null,

    location:
      normalize(
        body.location
      ) || null,
  };
}

/*
====================================================
RESPONSE
====================================================
*/

function toResponse(doc) {
  if (!doc) {
    return null;
  }

  const obj =
    typeof doc.toObject ===
    "function"
      ? doc.toObject()
      : {
          ...doc,
        };

  const buyerIds =
    Array.isArray(
      obj.buyer_ids
    )
      ? Array.from(
          new Set(
            obj.buyer_ids
              .map((id) =>
                String(
                  id
                ).trim()
              )
              .filter(Boolean)
          )
        )
      : obj.buyer_id
      ? [
          String(
            obj.buyer_id
          ),
        ]
      : [];

  return {
    ...obj,

    id:
      Number.isFinite(
        Number(
          obj.legacy_id
        )
      )
        ? Number(
            obj.legacy_id
          )
        : String(
            obj._id
          ),

    legacy_id:
      obj.legacy_id ??
      null,

    name:
      obj.name ||
      "",

    buyer_id:
      buyerIds[0] ||
      null,

    buyer_ids:
      buyerIds,

    buyer_name:
      obj.buyer_name ||
      null,

    mobile:
      obj.mobile ??
      null,

    email:
      obj.email ??
      null,

    address:
      obj.address ??
      null,

    gst_no:
      obj.gst_no ??
      null,

    pan_no:
      obj.pan_no ??
      null,

    state:
      obj.state ??
      null,

    location:
      obj.location ??
      null,

    _id:
      obj._id,
  };
}

/*
====================================================
ID FILTER
====================================================
*/

function buildIdFilter(rawId) {
  const raw =
    String(
      rawId ?? ""
    ).trim();

  if (!raw) {
    return null;
  }

  if (
    mongoose.Types.ObjectId.isValid(
      raw
    )
  ) {
    return {
      _id: raw,
    };
  }

  const numeric =
    Number(raw);

  if (
    Number.isFinite(
      numeric
    )
  ) {
    return {
      legacy_id:
        numeric,
    };
  }

  return null;
}

/*
====================================================
NEXT LEGACY ID
====================================================
*/

async function nextLegacyId() {
  const last =
    await ConsigneeName.findOne({
      legacy_id: {
        $exists: true,
        $ne: null,
      },
    })
      .sort({
        legacy_id: -1,
      })
      .select({
        legacy_id: 1,
      })
      .lean();

  return (
    Math.max(
      0,
      Number(
        last?.legacy_id
      ) || 0
    ) + 1
  );
}

/*
====================================================
DUPLICATE CHECK
====================================================
*/

async function findDuplicateConsignee(
  name,
  excludeId = null
) {
  const filter = {
    name: {
      $regex:
        `^${escapeRegExp(
          name
        )}$`,
      $options: "i",
    },
  };

  if (excludeId) {
    filter._id = {
      $ne:
        excludeId,
    };
  }

  return ConsigneeName.findOne(
    filter
  ).lean();
}

/*
====================================================
HYDRATE BUYER NAMES
====================================================
*/

async function hydrateBuyerNames(
  docs
) {
  if (
    !Array.isArray(docs) ||
    docs.length === 0
  ) {
    return docs || [];
  }

  const ids =
    Array.from(
      new Set(
        docs.flatMap(
          (doc) => {
            const raw =
              Array.isArray(
                doc.buyer_ids
              ) &&
              doc.buyer_ids.length
                ? doc.buyer_ids
                : doc.buyer_id
                ? [
                    doc.buyer_id,
                  ]
                : [];

            return raw
              .map((id) =>
                String(
                  id
                ).trim()
              )
              .filter(
                Boolean
              );
          }
        )
      )
    );

  if (
    ids.length === 0
  ) {
    return docs.map(
      (doc) => ({
        ...doc,

        buyer_ids:
          Array.isArray(
            doc.buyer_ids
          )
            ? doc.buyer_ids
            : [],

        buyer_id:
          doc.buyer_id ||
          null,

        buyer_name:
          doc.buyer_name ||
          null,
      })
    );
  }

  /*
   * Buyer master uses numeric legacy_id.
   */
  const numericIds =
    ids
      .map(
        Number
      )
      .filter(
        (id) =>
          Number.isFinite(
            id
          ) &&
          id > 0
      );

  const buyers =
    numericIds.length
      ? await BuyerName.find({
          legacy_id: {
            $in:
              numericIds,
          },
        })
          .select({
            legacy_id: 1,
            name: 1,
          })
          .lean()
      : [];

  const byId =
    new Map(
      buyers.map(
        (buyer) => [
          String(
            buyer.legacy_id
          ),
          buyer.name ||
            "",
        ]
      )
    );

  return docs.map(
    (doc) => {
      const raw =
        Array.isArray(
          doc.buyer_ids
        ) &&
        doc.buyer_ids.length
          ? doc.buyer_ids
          : doc.buyer_id
          ? [
              doc.buyer_id,
            ]
          : [];

      const buyerIds =
        Array.from(
          new Set(
            raw
              .map(
                (id) =>
                  String(
                    id
                  ).trim()
              )
              .filter(
                Boolean
              )
          )
        );

      const buyerNames =
        buyerIds
          .map(
            (id) =>
              byId.get(
                id
              ) || ""
          )
          .filter(Boolean);

      return {
        ...doc,

        buyer_ids:
          buyerIds,

        buyer_id:
          buyerIds[0] ||
          null,

        buyer_name:
          buyerNames.length
            ? buyerNames.join(
                ", "
              )
            : null,
      };
    }
  );
}

/*
====================================================
GET ALL CONSIGNEES
====================================================
*/

router.get(
  "/",
  async (req, res) => {
    if (
      !canAccessConsigneeNames(
        req.user
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to view consignee names",
      });
    }

    try {
      if (!requireMongo(res)) {
        return;
      }

      const rows =
        await ConsigneeName.find({})
          .sort({
            name: 1,
            _id: 1,
          })
          .lean();

      const hydrated =
        await hydrateBuyerNames(
          rows
        );

      return res.json(
        hydrated.map(
          toResponse
        )
      );
    } catch (err) {
      console.error(
        "Consignee list failed:",
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
CREATE CONSIGNEE
====================================================
*/

router.post(
  "/",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "consigneeNames.create"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to create consignee names",
      });
    }

    try {
      if (!requireMongo(res)) {
        return;
      }

      const row =
        buildRowBody(
          req.body
        );

      if (!row.name) {
        return res.status(400).json({
          error:
            "Name is required",
        });
      }

      const exists =
        await findDuplicateConsignee(
          row.name
        );

      if (exists) {
        return res.status(409).json({
          error:
            "This consignee name already exists",
        });
      }

      /*
       * Keep buyer references as strings,
       * matching db-mongodb.js schema.
       */
      const doc =
        await ConsigneeName.create({
          ...row,

          buyer_ids:
            row.buyer_ids.map(
              String
            ),

          legacy_id:
            await nextLegacyId(),

          created_at:
            new Date(),

          updated_at:
            new Date(),
        });

      return res.status(201).json(
        toResponse(doc)
      );
    } catch (err) {
      console.error(
        "Consignee create failed:",
        err
      );

      if (
        err?.code ===
        11000
      ) {
        return res.status(409).json({
          error:
            "This consignee name already exists",
        });
      }

      return res.status(500).json({
        error:
          err.message,
      });
    }
  }
);

/*
====================================================
IMPORT CONSIGNEES
====================================================
*/

async function importConsigneeRows(
  rows,
  res
) {
  let inserted = 0;
  let skipped = 0;

  const errors = [];

  try {
    if (!requireMongo(res)) {
      return;
    }

    /*
     * Load buyers from MongoDB.
     */
    const buyerRows =
      await BuyerName.find({})
        .select({
          legacy_id: 1,
          name: 1,
        })
        .lean();

    const buyerByName =
      new Map(
        buyerRows.map(
          (buyer) => [
            normalize(
              buyer.name
            ).toLowerCase(),
            Number(
              buyer.legacy_id
            ),
          ]
        )
      );

    let nextId =
      await nextLegacyId();

    for (
      let index = 0;
      index < rows.length;
      index += 1
    ) {
      const raw =
        rows[index] || {};

      const row =
        buildRowBody(
          raw
        );

      /*
       * Resolve buyer from buyer name
       * when buyer IDs are not supplied.
       */
      const buyerNameRaw =
        normalize(
          raw.buyer_name ??
            raw.BuyerName
        );

      if (
        !row.buyer_ids.length &&
        buyerNameRaw
      ) {
        row.buyer_ids =
          Array.from(
            new Set(
              buyerNameRaw
                .split(
                  /[,|;]/
                )
                .map(
                  (name) =>
                    buyerByName.get(
                      name
                        .trim()
                        .toLowerCase()
                    )
                )
                .filter(
                  (id) =>
                    Number.isFinite(
                      id
                    )
                )
            )
          );

        row.buyer_id =
          row.buyer_ids[0] ||
          null;
      }

      /*
       * Resolve buyer_id column.
       */
      const buyerIdFromField =
        Number(
          raw.buyer_id ??
            raw.BuyerId ??
            raw.buyerId ??
            0
        ) || null;

      if (
        !row.buyer_ids.length &&
        buyerIdFromField
      ) {
        row.buyer_ids = [
          String(
            buyerIdFromField
          ),
        ];

        row.buyer_id =
          String(
            buyerIdFromField
          );
      }

      if (!row.name) {
        skipped += 1;

        errors.push({
          row:
            index + 2,

          error:
            "Name is required",
        });

        continue;
      }

      const exists =
        await findDuplicateConsignee(
          row.name
        );

      if (exists) {
        skipped += 1;
        continue;
      }

      try {
        await ConsigneeName.create({
          ...row,

          buyer_ids:
            row.buyer_ids.map(
              String
            ),

          legacy_id:
            nextId++,

          created_at:
            new Date(),

          updated_at:
            new Date(),
        });

        inserted += 1;
      } catch (err) {
        skipped += 1;

        errors.push({
          row:
            index + 2,

          error:
            err.message,
        });
      }
    }

    return res.json({
      total:
        rows.length,

      inserted,

      skipped,

      errors,
    });
  } catch (err) {
    console.error(
      "Consignee import failed:",
      err
    );

    return res.status(500).json({
      error:
        err.message,
    });
  }
}

/*
====================================================
IMPORT JSON
====================================================
*/

router.post(
  "/import",
  async (req, res) => {
    if (
      !isAdminUser(
        req.user
      )
    ) {
      return res.status(403).json({
        error:
          "Only admin can import consignee master",
      });
    }

    const rows =
      Array.isArray(
        req.body?.rows
      )
        ? req.body.rows
        : [];

    if (!rows.length) {
      return res.status(400).json({
        error:
          "No rows found for import",
      });
    }

    return importConsigneeRows(
      rows,
      res
    );
  }
);

/*
====================================================
IMPORT XLSX
====================================================
*/

router.post(
  "/import-xlsx",
  upload.single("file"),
  async (req, res) => {
    if (
      !isAdminUser(
        req.user
      )
    ) {
      return res.status(403).json({
        error:
          "Only admin can import consignee master",
      });
    }

    if (!req.file?.buffer) {
      return res.status(400).json({
        error:
          "XLSX file is required",
      });
    }

    try {
      const workbook =
        XLSX.read(
          req.file.buffer,
          {
            type: "buffer",
          }
        );

      const firstSheet =
        workbook.SheetNames?.[0];

      if (!firstSheet) {
        return res.status(400).json({
          error:
            "No sheet found in file",
        });
      }

      const rows =
        XLSX.utils.sheet_to_json(
          workbook.Sheets[
            firstSheet
          ],
          {
            defval: "",
          }
        );

      if (!rows.length) {
        return res.status(400).json({
          error:
            "No rows found in XLSX",
        });
      }

      const normalized =
        rows.map(
          (row) => ({
            buyer_id:
              row.buyer_id ??
              row.BuyerId ??
              row.buyerId ??
              "",

            buyer_ids:
              row.buyer_ids ??
              row.BuyerIds ??
              "",

            buyer_name:
              row.buyer_name ??
              row.BuyerName ??
              "",

            name:
              row.name ??
              row.Name ??
              row.consignee_name ??
              row.ConsigneeName ??
              "",

            mobile:
              row.mobile ??
              row.Mobile ??
              "",

            email:
              row.email ??
              row.Email ??
              "",

            address:
              row.address ??
              row.Address ??
              "",

            gst_no:
              row.gst_no ??
              row.GST ??
              row.GSTNo ??
              "",

            pan_no:
              row.pan_no ??
              row.PAN ??
              row.PANNo ??
              "",

            state:
              row.state ??
              row.State ??
              "",

            location:
              row.location ??
              row.Location ??
              "",
          })
        );

      return importConsigneeRows(
        normalized,
        res
      );
    } catch (err) {
      return res.status(400).json({
        error:
          "Invalid XLSX file",
      });
    }
  }
);

/*
====================================================
UPDATE CONSIGNEE
====================================================
*/

router.put(
  "/:id",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "consigneeNames.edit"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to update consignee names",
      });
    }

    try {
      if (!requireMongo(res)) {
        return;
      }

      const idFilter =
        buildIdFilter(
          req.params.id
        );

      if (!idFilter) {
        return res.status(400).json({
          error:
            "Invalid consignee id",
        });
      }

      const current =
        await ConsigneeName.findOne(
          idFilter
        );

      if (!current) {
        return res.status(404).json({
          error:
            "Not found",
        });
      }

      const row =
        buildRowBody(
          req.body
        );

      if (!row.name) {
        return res.status(400).json({
          error:
            "Name is required",
        });
      }

      const duplicate =
        await findDuplicateConsignee(
          row.name,
          String(
            current._id
          )
        );

      if (duplicate) {
        return res.status(409).json({
          error:
            "This consignee name already exists",
        });
      }

      current.name =
        row.name;

      current.buyer_id =
        row.buyer_id;

      current.buyer_ids =
        row.buyer_ids.map(
          String
        );

      current.mobile =
        row.mobile;

      current.email =
        row.email;

      current.address =
        row.address;

      current.gst_no =
        row.gst_no;

      current.pan_no =
        row.pan_no;

      current.state =
        row.state;

      current.location =
        row.location;

      current.updated_at =
        new Date();

      await current.save();

      return res.json(
        toResponse(
          current
        )
      );
    } catch (err) {
      console.error(
        "Consignee update failed:",
        err
      );

      if (
        err?.code ===
        11000
      ) {
        return res.status(409).json({
          error:
            "This consignee name already exists",
        });
      }

      return res.status(500).json({
        error:
          err.message,
      });
    }
  }
);

/*
====================================================
DELETE CONSIGNEE
====================================================
*/

router.delete(
  "/:id",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "consigneeNames.delete"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to delete consignee names",
      });
    }

    try {
      if (!requireMongo(res)) {
        return;
      }

      const idFilter =
        buildIdFilter(
          req.params.id
        );

      if (!idFilter) {
        return res.status(400).json({
          error:
            "Invalid consignee id",
        });
      }

      const deleted =
        await ConsigneeName.findOneAndDelete(
          idFilter
        );

      if (!deleted) {
        return res.status(404).json({
          error:
            "Not found",
        });
      }

      return res.json({
        message:
          "Consignee deleted",

        id:
          Number.isFinite(
            Number(
              req.params.id
            )
          )
            ? Number(
                req.params.id
              )
            : String(
                deleted._id
              ),

        deleted:
          1,

        source:
          "mongodb",
      });
    } catch (err) {
      console.error(
        "Consignee delete failed:",
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
