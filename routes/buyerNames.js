const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");
const mongoose = require("mongoose");

const {
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

function canAccessBuyerNames(user) {
  return [
    "buyerNames.view",
    "buyerNames.create",
    "buyerNames.edit",
    "buyerNames.delete",
    "consigneeNames.view",
    "outward.view",
    "outward.create",
    "outward.edit",
    "adjustment.manage",
    "expense.view",
    "expense.create",
    "expense.edit",
    "expense.entry",
  ].some((permission) =>
    userHasPermission(user, permission)
  );
}

function normalize(value) {
  return String(value ?? "").trim();
}

function escapeRegExp(value) {
  return String(value || "").replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

function normalizeBuyerBody(body = {}) {
  return {
    name: normalize(body.name),

    mobile:
      normalize(body.mobile) || null,

    email:
      normalize(body.email) || null,

    address:
      normalize(body.address) || null,

    gst_no:
      normalize(body.gst_no) || null,

    pan_no:
      normalize(body.pan_no) || null,

    state:
      normalize(body.state) || null,

    location:
      normalize(body.location) || null,
  };
}

function toResponse(doc) {
  if (!doc) return null;

  const obj =
    typeof doc.toObject === "function"
      ? doc.toObject()
      : { ...doc };

  return {
    ...obj,

    id:
      Number.isFinite(
        Number(obj.legacy_id)
      )
        ? Number(obj.legacy_id)
        : String(obj._id),

    legacy_id:
      obj.legacy_id ?? null,

    name:
      obj.name || "",

    mobile:
      obj.mobile ?? null,

    email:
      obj.email ?? null,

    address:
      obj.address ?? null,

    gst_no:
      obj.gst_no ?? null,

    pan_no:
      obj.pan_no ?? null,

    state:
      obj.state ?? null,

    location:
      obj.location ?? null,

    _id:
      obj._id,
  };
}

function buildIdFilter(rawId) {
  const raw =
    String(rawId ?? "").trim();

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
    Number.isFinite(numeric)
  ) {
    return {
      legacy_id: numeric,
    };
  }

  return null;
}

async function nextLegacyId() {
  const last =
    await BuyerName.findOne({
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

async function findDuplicateBuyer(
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
      $ne: excludeId,
    };
  }

  return BuyerName.findOne(
    filter
  ).lean();
}

/*
====================================================
GET ALL BUYERS
====================================================
*/

router.get("/", async (req, res) => {
  if (
    !canAccessBuyerNames(
      req.user
    )
  ) {
    return res.status(403).json({
      error:
        "You do not have permission to view buyer names",
    });
  }

  try {
    if (!requireMongo(res)) {
      return;
    }

    const rows =
      await BuyerName.find({})
        .sort({
          name: 1,
          _id: 1,
        })
        .lean();

    return res.json(
      rows.map(toResponse)
    );
  } catch (err) {
    console.error(
      "Buyer list failed:",
      err
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

/*
====================================================
CREATE BUYER
====================================================
*/

router.post("/", async (req, res) => {
  if (
    !userHasPermission(
      req.user,
      "buyerNames.create"
    )
  ) {
    return res.status(403).json({
      error:
        "You do not have permission to create buyer names",
    });
  }

  try {
    if (!requireMongo(res)) {
      return;
    }

    const body =
      normalizeBuyerBody(
        req.body
      );

    if (!body.name) {
      return res.status(400).json({
        error:
          "Name is required",
      });
    }

    const exists =
      await findDuplicateBuyer(
        body.name
      );

    if (exists) {
      return res.status(409).json({
        error:
          "This buyer name already exists",
      });
    }

    const doc =
      await BuyerName.create({
        ...body,

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
      "Buyer create failed:",
      err
    );

    if (err?.code === 11000) {
      return res.status(409).json({
        error:
          "This buyer name already exists",
      });
    }

    return res.status(500).json({
      error: err.message,
    });
  }
});

/*
====================================================
IMPORT BUYERS
====================================================
*/

async function importBuyerRows(
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

    let nextId =
      await nextLegacyId();

    for (
      let index = 0;
      index < rows.length;
      index += 1
    ) {
      const body =
        normalizeBuyerBody(
          rows[index] || {}
        );

      if (!body.name) {
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
        await findDuplicateBuyer(
          body.name
        );

      if (exists) {
        skipped += 1;
        continue;
      }

      try {
        await BuyerName.create({
          ...body,

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
      "Buyer import failed:",
      err
    );

    return res.status(500).json({
      error: err.message,
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
          "Only admin can import buyer master",
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

    return importBuyerRows(
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
          "Only admin can import buyer master",
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
        rows.map((row) => ({
          name:
            row.name ??
            row.Name ??
            row.buyer_name ??
            row.BuyerName ??
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
        }));

      return importBuyerRows(
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
UPDATE BUYER
====================================================
*/

router.put(
  "/:id",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "buyerNames.edit"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to update buyer names",
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
            "Invalid buyer id",
        });
      }

      const body =
        normalizeBuyerBody(
          req.body
        );

      if (!body.name) {
        return res.status(400).json({
          error:
            "Name is required",
        });
      }

      const current =
        await BuyerName.findOne(
          idFilter
        );

      if (!current) {
        return res.status(404).json({
          error:
            "Not found",
        });
      }

      const exists =
        await findDuplicateBuyer(
          body.name,
          String(
            current._id
          )
        );

      if (exists) {
        return res.status(409).json({
          error:
            "This buyer name already exists",
        });
      }

      Object.assign(
        current,
        body
      );

      current.updated_at =
        new Date();

      await current.save();

      return res.json(
        toResponse(current)
      );
    } catch (err) {
      console.error(
        "Buyer update failed:",
        err
      );

      if (err?.code === 11000) {
        return res.status(409).json({
          error:
            "This buyer name already exists",
        });
      }

      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

/*
====================================================
DELETE BUYER
====================================================
*/

router.delete(
  "/:id",
  async (req, res) => {
    if (
      !userHasPermission(
        req.user,
        "buyerNames.delete"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to delete buyer names",
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
            "Invalid buyer id",
        });
      }

      const deleted =
        await BuyerName.findOneAndDelete(
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
          "Buyer deleted",

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
        "Buyer delete failed:",
        err
      );

      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

module.exports = router;
