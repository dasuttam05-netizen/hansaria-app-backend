const express = require("express");
const https = require("https");
const mongoose = require("mongoose");

const router = express.Router();

const {
  Farmer,
  isMongoMirrorReady,
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

function canReadFarmers(user) {
  return [
    "farmers.manage",
    "farmers.view",
    "farmers.create",
    "farmers.edit",

    "inward.view",
    "inward.create",

    "outward.view",
    "outward.create",

    "adjustment.manage",

    "expense.entry",
    "expense.view",
    "expense.create",

    "cash.view",
    "settlement.view",

    "report.inward",
    "report.erp",
    "report.partyLedger",
    "report.partyStock",
    "report.warehouseRentLedger",
    "report.warehouseRentMonthEnd",
    "report.outwardSettlement",
    "report.expense",

    "warehouse.trading.view",
    "warehouse.trading.manage",
  ].some((permission) =>
    userHasPermission(
      user,
      permission
    )
  );
}

function canManageFarmers(
  user,
  action
) {
  return (
    userHasPermission(
      user,
      "farmers.manage"
    ) ||
    userHasPermission(
      user,
      `farmers.${action}`
    )
  );
}

function cleanText(value) {
  const text =
    String(
      value || ""
    ).trim();

  return text
    ? text
    : null;
}

function compactUpper(value) {
  return String(
    value || ""
  )
    .replace(
      /\s/g,
      ""
    )
    .toUpperCase();
}

function compactDigits(value) {
  return String(
    value || ""
  ).replace(
    /\D/g,
    ""
  );
}

function isValidPan(value) {
  return (
    !value ||
    /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(
      value
    )
  );
}

function isValidAadhar(value) {
  return (
    !value ||
    /^[0-9]{12}$/.test(
      value
    )
  );
}

function isValidGst(value) {
  return (
    !value ||
    /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(
      value
    )
  );
}

function escapeRegex(value) {
  return String(
    value || ""
  ).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

function normalizeId(id) {
  const value =
    String(
      id || ""
    ).trim();

  if (
    !value ||
    !mongoose.Types.ObjectId.isValid(
      value
    )
  ) {
    return null;
  }

  return value;
}

function normalizeFarmerResponse(
  farmer
) {
  if (!farmer) {
    return null;
  }

  const row =
    typeof farmer.toObject ===
    "function"
      ? farmer.toObject()
      : {
          ...farmer,
        };

  return {
    ...row,

    id:
      row._id
        ? String(
            row._id
          )
        : row.id,

    name:
      row.name || "",

    mobile:
      row.mobile || "",

    email:
      row.email || null,

    address:
      row.address || null,

    pincode:
      row.pincode || "",

    state:
      row.state || null,

    district:
      row.district || null,

    city:
      row.city || null,

    room_floor_building:
      row.room_floor_building ||
      null,

    street_locality_landmark:
      row.street_locality_landmark ||
      null,

    gst_no:
      row.gst_no || null,

    pan_no:
      row.pan_no || null,

    aadhar_no:
      row.aadhar_no || null,

    aadhaar_pan_link_status:
      row.aadhaar_pan_link_status ||
      "unknown",

    bank_name:
      row.bank_name || null,

    bank_account_no:
      row.bank_account_no ||
      null,

    ifsc_code:
      row.ifsc_code || null,

    branch_name:
      row.branch_name || null,

    account_holder_name:
      row.account_holder_name ||
      null,
  };
}

/*
====================================================
EXTERNAL LOOKUP
====================================================
*/

function fetchJson(url) {
  return new Promise(
    (resolve, reject) => {
      const request =
        https.get(
          url,
          {
            timeout:
              10000,
          },
          (response) => {
            let raw = "";

            response.on(
              "data",
              (chunk) => {
                raw += chunk;
              }
            );

            response.on(
              "end",
              () => {
                if (
                  response.statusCode <
                    200 ||
                  response.statusCode >=
                    300
                ) {
                  reject(
                    new Error(
                      `Lookup failed with status ${response.statusCode}`
                    )
                  );

                  return;
                }

                try {
                  resolve(
                    JSON.parse(
                      raw
                    )
                  );
                } catch (error) {
                  reject(
                    error
                  );
                }
              }
            );
          }
        );

      request.on(
        "timeout",
        () => {
          request.destroy(
            new Error(
              "Lookup timed out"
            )
          );
        }
      );

      request.on(
        "error",
        reject
      );
    }
  );
}

/*
====================================================
BUILD FARMER PAYLOAD
====================================================
*/

function buildFarmerPayload(
  body = {}
) {
  const panNo =
    compactUpper(
      body.pan_no
    );

  const gstNo =
    compactUpper(
      body.gst_no
    );

  const aadharNo =
    compactDigits(
      body.aadhar_no
    );

  const pincode =
    compactDigits(
      body.pincode
    );

  const ifscCode =
    compactUpper(
      body.ifsc_code
    );

  if (!isValidPan(panNo)) {
    return {
      error:
        "Invalid PAN No. format",
    };
  }

  if (
    !isValidAadhar(
      aadharNo
    )
  ) {
    return {
      error:
        "Invalid Aadhaar No. format",
    };
  }

  if (
    !/^[0-9]{6}$/.test(
      pincode
    )
  ) {
    return {
      error:
        "PIN No. is required and must be 6 digits",
    };
  }

  if (
    !isValidGst(
      gstNo
    )
  ) {
    return {
      error:
        "Invalid GST No. format",
    };
  }

  if (
    gstNo &&
    panNo &&
    gstNo.slice(
      2,
      12
    ) !== panNo
  ) {
    return {
      error:
        "GST No. PAN part does not match PAN No.",
    };
  }

  if (
    ifscCode &&
    !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(
      ifscCode
    )
  ) {
    return {
      error:
        "Invalid IFSC Code format",
    };
  }

  const mobile =
    String(
      body.mobile || ""
    ).trim();

  if (!mobile) {
    return {
      error:
        "Mobile No. is required",
    };
  }

  const name =
    String(
      body.name || ""
    ).trim();

  if (!name) {
    return {
      error:
        "Farmer name is required",
    };
  }

  return {
    payload: {
      name,

      mobile,

      email:
        cleanText(
          body.email
        ),

      address:
        cleanText(
          body.address
        ),

      pincode,

      state:
        cleanText(
          body.state
        ),

      district:
        cleanText(
          body.district
        ),

      city:
        cleanText(
          body.city
        ),

      room_floor_building:
        cleanText(
          body.room_floor_building
        ),

      street_locality_landmark:
        cleanText(
          body.street_locality_landmark
        ),

      gst_no:
        gstNo ||
        null,

      pan_no:
        panNo ||
        null,

      aadhar_no:
        aadharNo ||
        null,

      aadhaar_pan_link_status:
        [
          "linked",
          "not_linked",
          "unknown",
        ].includes(
          body.aadhaar_pan_link_status
        )
          ? body.aadhaar_pan_link_status
          : "unknown",

      bank_name:
        cleanText(
          body.bank_name
        ),

      bank_account_no:
        compactDigits(
          body.bank_account_no
        ) || null,

      ifsc_code:
        ifscCode ||
        null,

      branch_name:
        cleanText(
          body.branch_name
        ),

      account_holder_name:
        cleanText(
          body.account_holder_name
        ),
    },
  };
}

/*
====================================================
LIST FARMERS
====================================================
*/

router.get(
  "/",
  async (req, res) => {
    try {
      if (
        !canReadFarmers(
          req.user
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to view farmers",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const rows =
        await Farmer.find({})
          .sort({
            created_at: -1,
            _id: -1,
          })
          .lean();

      return res.json(
        rows.map(
          normalizeFarmerResponse
        )
      );
    } catch (err) {
      console.error(
        "Farmer list failed:",
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
GET SINGLE FARMER
====================================================
*/

router.get(
  "/:id",
  async (req, res) => {
    try {
      if (
        !canReadFarmers(
          req.user
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to view farmers",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const farmerId =
        normalizeId(
          req.params.id
        );

      if (!farmerId) {
        return res.status(400).json({
          error:
            "Invalid farmer ID",
        });
      }

      const farmer =
        await Farmer.findById(
          farmerId
        ).lean();

      if (!farmer) {
        return res.status(404).json({
          error:
            "Farmer not found",
        });
      }

      return res.json(
        normalizeFarmerResponse(
          farmer
        )
      );
    } catch (err) {
      console.error(
        "Farmer single fetch failed:",
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
PINCODE LOOKUP
====================================================
*/

router.get(
  "/lookup/pincode/:pincode",
  async (req, res) => {
    try {
      const pincode =
        compactDigits(
          req.params.pincode
        );

      if (
        !/^[0-9]{6}$/.test(
          pincode
        )
      ) {
        return res.status(400).json({
          error:
            "PIN No. must be 6 digits",
        });
      }

      const result =
        await fetchJson(
          `https://api.postalpincode.in/pincode/${pincode}`
        );

      const item =
        Array.isArray(
          result
        )
          ? result[0]
          : null;

      const postOffice =
        item?.PostOffice?.[0];

      if (!postOffice) {
        return res.status(404).json({
          error:
            "PIN not found",
        });
      }

      return res.json({
        district:
          postOffice.District ||
          postOffice.Block ||
          "",

        city:
          postOffice.Name ||
          "",

        state:
          postOffice.State ||
          "",
      });
    } catch (err) {
      console.error(
        "PIN lookup failed:",
        err
      );

      return res.status(502).json({
        error:
          "PIN lookup failed",
      });
    }
  }
);

/*
====================================================
IFSC LOOKUP
====================================================
*/

router.get(
  "/lookup/ifsc/:ifsc",
  async (req, res) => {
    try {
      const ifsc =
        compactUpper(
          req.params.ifsc
        );

      if (
        !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(
          ifsc
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid IFSC Code format",
        });
      }

      const data =
        await fetchJson(
          `https://ifsc.razorpay.com/${ifsc}`
        );

      return res.json({
        bank_name:
          data?.BANK ||
          "",

        branch_name:
          data?.BRANCH ||
          "",
      });
    } catch (err) {
      console.error(
        "IFSC lookup failed:",
        err
      );

      return res.status(502).json({
        error:
          "IFSC lookup failed",
      });
    }
  }
);

/*
====================================================
CREATE FARMER
====================================================
*/

router.post(
  "/",
  async (req, res) => {
    try {
      if (
        !canManageFarmers(
          req.user,
          "create"
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to manage farmers",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const built =
        buildFarmerPayload(
          req.body
        );

      if (built.error) {
        return res.status(400).json({
          error:
            built.error,
        });
      }

      /*
       * Duplicate mobile/PAN/Aadhaar
       * protection.
       */
      const duplicateOr =
        [];

      if (
        built.payload.pan_no
      ) {
        duplicateOr.push({
          pan_no:
            built.payload.pan_no,
        });
      }

      if (
        built.payload.aadhar_no
      ) {
        duplicateOr.push({
          aadhar_no:
            built.payload.aadhar_no,
        });
      }

      if (
        built.payload.mobile
      ) {
        duplicateOr.push({
          mobile:
            built.payload.mobile,
        });
      }

      if (
        duplicateOr.length
      ) {
        const duplicate =
          await Farmer.findOne({
            $or:
              duplicateOr,
          }).lean();

        if (duplicate) {
          return res.status(409).json({
            error:
              "Farmer with the same Mobile, PAN or Aadhaar already exists",
          });
        }
      }

      const farmer =
        await Farmer.create({
          ...built.payload,

          created_at:
            new Date(),

          updated_at:
            new Date(),
        });

      return res.status(201).json(
        normalizeFarmerResponse(
          farmer
        )
      );
    } catch (err) {
      console.error(
        "Farmer create failed:",
        err
      );

      if (
        err?.code ===
        11000
      ) {
        return res.status(409).json({
          error:
            "Farmer with the same unique information already exists",
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
UPDATE FARMER
====================================================
*/

router.put(
  "/:id",
  async (req, res) => {
    try {
      if (
        !canManageFarmers(
          req.user,
          "edit"
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to manage farmers",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const farmerId =
        normalizeId(
          req.params.id
        );

      if (!farmerId) {
        return res.status(400).json({
          error:
            "Invalid farmer ID",
        });
      }

      const existing =
        await Farmer.findById(
          farmerId
        );

      if (!existing) {
        return res.status(404).json({
          error:
            "Farmer not found",
        });
      }

      const built =
        buildFarmerPayload(
          req.body
        );

      if (built.error) {
        return res.status(400).json({
          error:
            built.error,
        });
      }

      const duplicateOr =
        [];

      if (
        built.payload.pan_no
      ) {
        duplicateOr.push({
          pan_no:
            built.payload.pan_no,
        });
      }

      if (
        built.payload.aadhar_no
      ) {
        duplicateOr.push({
          aadhar_no:
            built.payload.aadhar_no,
        });
      }

      if (
        built.payload.mobile
      ) {
        duplicateOr.push({
          mobile:
            built.payload.mobile,
        });
      }

      if (
        duplicateOr.length
      ) {
        const duplicate =
          await Farmer.findOne({
            _id: {
              $ne:
                existing._id,
            },

            $or:
              duplicateOr,
          }).lean();

        if (duplicate) {
          return res.status(409).json({
            error:
              "Another farmer has the same Mobile, PAN or Aadhaar",
          });
        }
      }

      Object.assign(
        existing,
        built.payload
      );

      existing.updated_at =
        new Date();

      await existing.save();

      return res.json(
        normalizeFarmerResponse(
          existing
        )
      );
    } catch (err) {
      console.error(
        "Farmer update failed:",
        err
      );

      if (
        err?.code ===
        11000
      ) {
        return res.status(409).json({
          error:
            "Farmer with the same unique information already exists",
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
DELETE FARMER
====================================================
*/

router.delete(
  "/:id",
  async (req, res) => {
    try {
      if (
        !canManageFarmers(
          req.user,
          "delete"
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to manage farmers",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const farmerId =
        normalizeId(
          req.params.id
        );

      if (!farmerId) {
        return res.status(400).json({
          error:
            "Invalid farmer ID",
        });
      }

      const deleted =
        await Farmer.findByIdAndDelete(
          farmerId
        ).lean();

      if (!deleted) {
        return res.status(404).json({
          error:
            "Farmer not found",
        });
      }

      return res.json({
        message:
          "Farmer deleted",

        id:
          farmerId,

        deleted:
          1,

        source:
          "mongodb",
      });
    } catch (err) {
      console.error(
        "Farmer delete failed:",
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
