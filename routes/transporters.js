const express = require("express");
const router = express.Router();

const {
  mongoose,
  Transporter,
  isMongoMirrorReady,
} = require("../db-mongodb");

const { userHasPermission } = require("../middleware/auth");

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

function str(value) {
  return value == null
    ? ""
    : String(value).trim();
}

function normalize(doc) {
  if (!doc) {
    return null;
  }

  const row =
    typeof doc.toObject === "function"
      ? doc.toObject()
      : { ...doc };

  return {
    ...row,

    id:
      row.id ??
      row.legacy_id ??
      String(row._id),

    _id:
      row._id
        ? String(row._id)
        : null,

    name:
      row.name || "",

    address:
      row.address || "",

    pan_no:
      row.pan_no || "",

    gst_no:
      row.gst_no || "",

    aadhar_no:
      row.aadhar_no || "",

    mobile:
      row.mobile || "",
  };
}

function normalizeId(value) {
  const raw = str(value);

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
      legacy_id:
        numeric,
    };
  }

  return null;
}

function escapeRegex(value) {
  return String(
    value || ""
  ).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

async function nextLegacyId() {
  const last =
    await Transporter.findOne({
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

function canManageTransporter(user) {
  return (
    userHasPermission(
      user,
      "transport.manage"
    ) ||
    userHasPermission(
      user,
      "transporters.manage"
    )
  );
}

/*
====================================================
LIST TRANSPORTERS
====================================================
*/

router.get(
  "/",
  async (req, res) => {
    try {
      if (!requireMongo(res)) {
        return;
      }

      if (
        !canManageTransporter(
          req.user
        ) &&
        !userHasPermission(
          req.user,
          "outward.view"
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to view transporters",
        });
      }

      const rows =
        await Transporter.find({})
          .sort({
            name: 1,
            _id: 1,
          })
          .lean();

      return res.json(
        rows.map(normalize)
      );
    } catch (err) {
      console.error(
        "Transporter list failed:",
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
VERIFY PAN / AADHAAR FORMAT
====================================================
*/

router.post(
  "/verify-pan-aadhaar-link",
  async (req, res) => {
    const pan =
      str(
        req.body?.pan_no
      ).toUpperCase();

    const aadhar =
      str(
        req.body?.aadhar_no
      ).replace(
        /\D/g,
        ""
      );

    const panValid =
      /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(
        pan
      );

    const aadharValid =
      /^[0-9]{12}$/.test(
        aadhar
      );

    if (
      !pan ||
      !aadhar
    ) {
      return res.status(400).json({
        error:
          "PAN and Aadhar are required",
      });
    }

    if (
      !panValid ||
      !aadharValid
    ) {
      return res.json({
        linked:
          false,

        message:
          "PAN or Aadhar format is invalid",
      });
    }

    return res.json({
      linked:
        true,

      message:
        "PAN and Aadhar format valid (official link verification unavailable)",
    });
  }
);

/*
====================================================
CREATE TRANSPORTER
====================================================
*/

router.post(
  "/",
  async (req, res) => {
    try {
      if (
        !canManageTransporter(
          req.user
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to create transporters",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const name =
        str(
          req.body?.name
        );

      const address =
        str(
          req.body?.address
        );

      const pan_no =
        str(
          req.body?.pan_no
        ).toUpperCase();

      const gst_no =
        str(
          req.body?.gst_no
        ).toUpperCase();

      const aadhar_no =
        str(
          req.body?.aadhar_no
        ).replace(
          /\D/g,
          ""
        );

      const mobile =
        str(
          req.body?.mobile
        );

      if (!name) {
        return res.status(400).json({
          error:
            "Transport name required",
        });
      }

      const duplicate =
        await Transporter.findOne({
          name: {
            $regex:
              `^${escapeRegex(
                name
              )}$`,
            $options:
              "i",
          },
        }).lean();

      if (duplicate) {
        return res.status(409).json({
          error:
            "Transporter already exists",
        });
      }

      const requestedLegacyId =
        Number(
          req.body?.legacy_id
        );

      const legacy_id =
        Number.isFinite(
          requestedLegacyId
        )
          ? requestedLegacyId
          : await nextLegacyId();

      const doc =
        await Transporter.create({
          legacy_id,

          name,

          address,

          pan_no,

          gst_no,

          aadhar_no,

          mobile,

          created_at:
            req.body?.created_at ||
            new Date(),

          updated_at:
            new Date(),
        });

      const result =
        normalize(doc);

      return res.status(201).json({
        id:
          result.id,

        _id:
          result._id,

        message:
          "Transport saved successfully",

        transporter:
          result,

        source:
          "mongodb",
      });
    } catch (err) {
      console.error(
        "Transporter create failed:",
        err
      );

      if (
        err?.code ===
        11000
      ) {
        return res.status(409).json({
          error:
            "Transporter already exists",
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
UPDATE TRANSPORTER
====================================================
*/

router.put(
  "/:id",
  async (req, res) => {
    try {
      if (
        !canManageTransporter(
          req.user
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to edit transporters",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const filter =
        normalizeId(
          req.params.id
        );

      if (!filter) {
        return res.status(400).json({
          error:
            "Invalid transporter ID",
        });
      }

      const name =
        str(
          req.body?.name
        );

      const address =
        str(
          req.body?.address
        );

      const pan_no =
        str(
          req.body?.pan_no
        ).toUpperCase();

      const gst_no =
        str(
          req.body?.gst_no
        ).toUpperCase();

      const aadhar_no =
        str(
          req.body?.aadhar_no
        ).replace(
          /\D/g,
          ""
        );

      const mobile =
        str(
          req.body?.mobile
        );

      if (!name) {
        return res.status(400).json({
          error:
            "Transport name required",
        });
      }

      const current =
        await Transporter.findOne(
          filter
        );

      if (!current) {
        return res.status(404).json({
          error:
            "Transporter not found",
        });
      }

      const duplicate =
        await Transporter.findOne({
          _id: {
            $ne:
              current._id,
          },

          name: {
            $regex:
              `^${escapeRegex(
                name
              )}$`,
            $options:
              "i",
          },
        }).lean();

      if (duplicate) {
        return res.status(409).json({
          error:
            "Another transporter with the same name already exists",
        });
      }

      current.name =
        name;

      current.address =
        address;

      current.pan_no =
        pan_no;

      current.gst_no =
        gst_no;

      current.aadhar_no =
        aadhar_no;

      current.mobile =
        mobile;

      current.updated_at =
        new Date();

      await current.save();

      const result =
        normalize(
          current
        );

      return res.json({
        id:
          result.id,

        _id:
          result._id,

        message:
          "Transport updated successfully",

        transporter:
          result,

        source:
          "mongodb",
      });
    } catch (err) {
      console.error(
        "Transporter update failed:",
        err
      );

      if (
        err?.code ===
        11000
      ) {
        return res.status(409).json({
          error:
            "Transporter already exists",
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
DELETE TRANSPORTER
====================================================
*/

router.delete(
  "/:id",
  async (req, res) => {
    try {
      if (
        !canManageTransporter(
          req.user
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to delete transporters",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const filter =
        normalizeId(
          req.params.id
        );

      if (!filter) {
        return res.status(400).json({
          error:
            "Invalid transporter ID",
        });
      }

      const deleted =
        await Transporter.findOneAndDelete(
          filter
        );

      if (!deleted) {
        return res.status(404).json({
          error:
            "Transporter not found",
        });
      }

      return res.json({
        message:
          "Transport deleted successfully",

        deleted:
          1,

        id:
          deleted.legacy_id ??
          String(
            deleted._id
          ),

        source:
          "mongodb",
      });
    } catch (err) {
      console.error(
        "Transporter delete failed:",
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
