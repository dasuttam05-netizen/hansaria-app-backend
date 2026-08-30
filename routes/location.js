const express = require("express");
const router = express.Router();

const {
  mongoose,
  Location,
  Warehouse,
  isMongoMirrorReady,
} = require("../db-mongodb");

const {
  userHasPermission,
} = require("../middleware/auth");

function canReadLocations(user) {
  return [
    "locations.view",
    "locations.manage",
    "expense.entry",
    "expense.view",
    "expense.create",
    "expense.edit",
    "inward.view",
    "inward.create",
    "outward.view",
    "outward.create",
    "employees.view",
    "report.partyStock",
    "report.warehouseRentLedger",
    "report.warehouseRentMonthEnd",
  ].some((permission) =>
    userHasPermission(user, permission)
  );
}

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

function normalizeObjectId(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const text = String(value).trim();

  return mongoose.Types.ObjectId.isValid(text)
    ? text
    : null;
}

/*
====================================================
LIST LOCATIONS
====================================================
*/

router.get("/", async (req, res) => {
  try {
    if (!canReadLocations(req.user)) {
      return res.status(403).json({
        error:
          "You do not have permission to view locations",
      });
    }

    if (!requireMongo(res)) {
      return;
    }

    const rows =
      await Location.find({})
        .sort({
          created_at: -1,
          _id: -1,
        })
        .lean();

    return res.json(
      rows.map((row) => ({
        ...row,

        id:
          row?._id
            ? String(row._id)
            : row?.id,

        name:
          row?.name || "",

        address:
          row?.address || "",

        abbr:
          row?.abbr || "",
      }))
    );
  } catch (err) {
    console.error(
      "Error fetching locations:",
      err
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

/*
====================================================
UNMAPPED LOCATIONS
====================================================
*/

router.get(
  "/unmapped",
  async (req, res) => {
    try {
      if (!canReadLocations(req.user)) {
        return res.status(403).json({
          error:
            "You do not have permission to view locations",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const [
        locations,
        warehouses,
      ] = await Promise.all([
        Location.find({})
          .sort({
            created_at: -1,
            _id: -1,
          })
          .lean(),

        Warehouse.find({})
          .select({
            location_id: 1,
          })
          .lean(),
      ]);

      const warehouseCountByLocation =
        new Map();

      for (
        const warehouse of
          warehouses || []
      ) {
        const locationId =
          warehouse?.location_id
            ? String(
                warehouse.location_id
              )
            : "";

        if (!locationId) {
          continue;
        }

        warehouseCountByLocation.set(
          locationId,
          (
            warehouseCountByLocation.get(
              locationId
            ) || 0
          ) + 1
        );
      }

      const unmappedLocations =
        (locations || [])
          .filter((location) => {
            const id =
              location?._id
                ? String(
                    location._id
                  )
                : "";

            return (
              id &&
              !warehouseCountByLocation.has(
                id
              )
            );
          })
          .map((location) => ({
            id:
              location?._id
                ? String(
                    location._id
                  )
                : "",

            name:
              location?.name ||
              "",

            address:
              location?.address ||
              "",

            abbr:
              location?.abbr ||
              "",

            warehouse_count:
              0,
          }));

      return res.json({
        total_locations:
          locations.length,

        unmapped_count:
          unmappedLocations.length,

        unmapped_locations:
          unmappedLocations,
      });
    } catch (err) {
      console.error(
        "Error fetching unmapped locations:",
        err
      );

      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

/*
====================================================
CREATE LOCATION
====================================================
*/

router.post("/", async (req, res) => {
  try {
    if (
      !userHasPermission(
        req.user,
        "locations.create"
      )
    ) {
      return res.status(403).json({
        error:
          "You do not have permission to create locations",
      });
    }

    if (!requireMongo(res)) {
      return;
    }

    const {
      name,
      address,
      abbr,
    } = req.body;

    const cleanName =
      String(name || "").trim();

    const cleanAddress =
      String(address || "").trim();

    const cleanAbbr =
      String(abbr || "").trim();

    if (
      !cleanName ||
      !cleanAddress
    ) {
      return res.status(400).json({
        error:
          "Name and address are required",
      });
    }

    const duplicate =
      await Location.findOne({
        name: {
          $regex:
            `^${cleanName.replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&"
            )}$`,
          $options: "i",
        },
      }).lean();

    if (duplicate) {
      return res.status(409).json({
        error:
          "Location already exists",
      });
    }

    const location =
      await Location.create({
        name: cleanName,
        address:
          cleanAddress,
        abbr:
          cleanAbbr,

        created_at:
          new Date(),
      });

    return res.json({
      ...location.toObject(),

      id:
        String(
          location._id
        ),
    });
  } catch (err) {
    console.error(
      "Error creating location:",
      err
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});

/*
====================================================
UPDATE LOCATION
====================================================
*/

router.put(
  "/:id",
  async (req, res) => {
    try {
      if (
        !userHasPermission(
          req.user,
          "locations.edit"
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to edit locations",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const id =
        normalizeObjectId(
          req.params.id
        );

      if (!id) {
        return res.status(400).json({
          error:
            "Invalid location ID",
        });
      }

      const {
        name,
        address,
        abbr,
      } = req.body;

      const cleanName =
        String(name || "").trim();

      const cleanAddress =
        String(address || "").trim();

      const cleanAbbr =
        String(abbr || "").trim();

      if (
        !cleanName ||
        !cleanAddress
      ) {
        return res.status(400).json({
          error:
            "Name and address are required",
        });
      }

      const duplicate =
        await Location.findOne({
          _id: {
            $ne: id,
          },

          name: {
            $regex:
              `^${cleanName.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&"
              )}$`,
            $options: "i",
          },
        }).lean();

      if (duplicate) {
        return res.status(409).json({
          error:
            "Another location with the same name already exists",
        });
      }

      const updated =
        await Location.findByIdAndUpdate(
          id,
          {
            $set: {
              name:
                cleanName,

              address:
                cleanAddress,

              abbr:
                cleanAbbr,

              updated_at:
                new Date(),
            },
          },
          {
            new: true,
          }
        ).lean();

      if (!updated) {
        return res.status(404).json({
          error:
            "Location not found",
        });
      }

      return res.json({
        ...updated,

        id:
          String(
            updated._id
          ),
      });
    } catch (err) {
      console.error(
        "Error updating location:",
        err
      );

      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

/*
====================================================
DELETE LOCATION
====================================================
*/

router.delete(
  "/:id",
  async (req, res) => {
    try {
      if (
        !userHasPermission(
          req.user,
          "locations.delete"
        )
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to delete locations",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const id =
        normalizeObjectId(
          req.params.id
        );

      if (!id) {
        return res.status(400).json({
          error:
            "Invalid location ID",
        });
      }

      const warehouseUsingLocation =
        await Warehouse.findOne({
          location_id: id,
        }).lean();

      if (warehouseUsingLocation) {
        return res.status(400).json({
          error:
            "Cannot delete location because warehouse(s) are assigned to it",
        });
      }

      const deleted =
        await Location.findByIdAndDelete(
          id
        ).lean();

      if (!deleted) {
        return res.status(404).json({
          error:
            "Location not found",
        });
      }

      return res.json({
        message:
          "Location deleted",

        id:
          String(id),

        deleted:
          1,

        source:
          "mongodb",
      });
    } catch (err) {
      console.error(
        "Error deleting location:",
        err
      );

      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

module.exports = router;
