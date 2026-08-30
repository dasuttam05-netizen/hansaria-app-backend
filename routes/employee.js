const express = require("express");
const bcrypt = require("bcryptjs");

const {
  mongoose,
  Employee,
  Location,
  Warehouse,
  isMongoMirrorReady,
} = require("../db-mongodb");

const {
  parsePermissions,
  userHasPermission,
  isAdminUser,
  normalizeRole,
} = require("../middleware/auth");

const router = express.Router();

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

function parseWarehouseIds(input) {
  const raw = Array.isArray(input)
    ? input
    : String(input || "").split(",");

  return Array.from(
    new Set(
      raw
        .map((item) => String(item).trim())
        .filter(Boolean)
    )
  );
}

function getRecordId(value) {
  if (!value) return null;

  if (value._id) {
    return String(value._id);
  }

  if (value.id) {
    return String(value.id);
  }

  return String(value);
}

function getEmployeeMobile(value) {
  return String(
    value?.mobile ??
      value?.mobile_no ??
      value?.phone ??
      ""
  ).trim();
}

function getIncomingMobile(body = {}) {
  return String(
    body.mobile ??
      body.mobile_no ??
      body.phone ??
      ""
  ).trim();
}

function logEmployeeRouteError(
  stage,
  err,
  req
) {
  console.error(
    `[employees:${stage}]`,
    {
      message: err?.message,
      stack: err?.stack,
      userId:
        req?.user?.id ||
        req?.user?._id ||
        null,
      role:
        req?.user?.role ||
        null,
      path:
        req?.originalUrl ||
        req?.url ||
        null,
      method:
        req?.method ||
        null,
    }
  );
}

function normalizeIdArray(input) {
  return Array.isArray(input)
    ? Array.from(
        new Set(
          input
            .map((id) =>
              String(id).trim()
            )
            .filter(Boolean)
        )
      )
    : [];
}

function buildEmployeeResponse(
  employee
) {
  if (!employee) return null;

  const plain =
    typeof employee.toObject ===
    "function"
      ? employee.toObject()
      : employee;

  return {
    ...plain,

    id:
      plain._id
        ? String(plain._id)
        : plain.id,

    employee_id:
      plain.employee_id || "",

    name:
      plain.name || "",

    mobile:
      getEmployeeMobile(
        plain
      ),

    address:
      plain.address || "",

    username:
      plain.username || "",

    location_id:
      getRecordId(
        plain.location_id
      ),

    location_ids:
      Array.isArray(
        plain.location_ids
      )
        ? plain.location_ids.map(
            getRecordId
          )
        : [],

    all_location_access:
      !!plain.all_location_access,

    role:
      plain.role || "staff",

    permissions:
      parsePermissions(
        plain.permissions,
        plain.role
      ),

    opening_balance:
      Number(
        plain.opening_balance || 0
      ),

    opening_balance_type:
      String(
        plain.opening_balance_type ||
          "dr"
      ).toLowerCase() === "cr"
        ? "cr"
        : "dr",

    assigned_warehouse_ids:
      parseWarehouseIds(
        plain.assigned_warehouse_ids
      ),

    all_warehouse_access:
      !!plain.all_warehouse_access,
  };
}

/*
====================================================
CAN READ EMPLOYEES
====================================================
*/

function canReadEmployees(user) {
  return [
    "employees.view",
    "employees.manage",
    "expense.entry",
    "expense.view",
    "expense.create",
    "expense.edit",
    "inward.view",
    "outward.view",
    "cash.view",
    "report.erp",
  ].some((permission) =>
    userHasPermission(
      user,
      permission
    )
  );
}

/*
====================================================
GET ALL EMPLOYEES
====================================================
*/

router.get(
  "/",
  async (req, res) => {
    try {
      if (!canReadEmployees(req.user)) {
        return res.status(403).json({
          error:
            "You do not have permission to view employees",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      // IMPORTANT: Do not use Mongoose populate() here.
      // Older migrated employee rows can contain legacy numeric/string
      // location IDs such as "3". populate() converts those values to
      // ObjectId values and throws a CastError, turning the whole endpoint
      // into HTTP 500. We load employees first and resolve only valid
      // ObjectId location IDs below. Invalid legacy IDs are kept as-is in
      // location_id and simply get an empty location_name.
      const employees =
        await Employee.find({})
          .sort({
            created_at: -1,
            _id: -1,
          })
          .lean();

      const locationIds = Array.from(
        new Set(
          employees
            .flatMap((row) => [
              row?.location_id,
              ...(Array.isArray(row?.location_ids)
                ? row.location_ids
                : []),
            ])
            .map((value) =>
              value == null ? "" : String(value)
            )
            .filter((value) =>
              value &&
              mongoose.Types.ObjectId.isValid(value)
            )
        )
      );

      const locations = locationIds.length
        ? await Location.find({
            _id: { $in: locationIds },
          }).lean()
        : [];

      const locationMap = new Map(
        locations.map((location) => [
          String(location._id),
          location,
        ])
      );

      const formatted =
        employees.map((row) => {
          const locationKey =
            row?.location_id == null
              ? ""
              : String(row.location_id);
          const location =
            locationMap.get(locationKey);

          return {
            ...row,

            id:
              row?._id
                ? String(row._id)
                : row?.id,

            location_id:
              getRecordId(row.location_id),

            location_ids:
              Array.isArray(row.location_ids)
                ? row.location_ids.map(getRecordId)
                : [],

            all_location_access:
              !!row.all_location_access,

            employee_id:
              row.employee_id || "",

            mobile:
              getEmployeeMobile(row),

            location_name:
              location?.name ||
              row.location_name ||
              "",

            permissions:
              parsePermissions(
                row.permissions,
                row.role
              ),

            assigned_warehouse_ids:
              parseWarehouseIds(
                row.assigned_warehouse_ids
              ),

            all_warehouse_access:
              !!row.all_warehouse_access,
          };
        });

      return res.json(
        formatted
      );
    } catch (err) {
      logEmployeeRouteError(
        "list",
        err,
        req
      );

      return res.status(500).json({
        error:
          "Failed to load employees",
      });
    }
  }
);

/*
====================================================
GET SINGLE EMPLOYEE
====================================================
*/

router.get(
  "/:id",
  async (req, res) => {
    try {
      if (!canReadEmployees(req.user)) {
        return res.status(403).json({
          error:
            "You do not have permission to view employees",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      if (
        !mongoose.Types.ObjectId.isValid(
          String(
            req.params.id
          )
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid employee ID",
        });
      }

      const row =
        await Employee.findById(
          req.params.id
        ).lean();

      // Resolve location without populate() so legacy invalid location IDs
      // cannot cause a Mongoose ObjectId CastError.
      let location = null;
      const locationId = row?.location_id == null
        ? ""
        : String(row.location_id);

      if (locationId && mongoose.Types.ObjectId.isValid(locationId)) {
        location = await Location.findById(locationId).lean();
      }

      if (!row) {
        return res.status(404).json({
          error:
            "Employee not found",
        });
      }

      return res.json({
        ...buildEmployeeResponse(
          row
        ),

        location_name:
          location?.name ||
          row.location_name ||
          "",
      });
    } catch (err) {
      logEmployeeRouteError(
        "single",
        err,
        req
      );

      return res.status(500).json({
        error:
          "Failed to load employee",
      });
    }
  }
);

/*
====================================================
CREATE EMPLOYEE
====================================================
*/

router.post(
  "/",
  async (req, res) => {
    try {
      if (!isAdminUser(req.user)) {
        return res.status(403).json({
          error:
            "Only admin can create employee users",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      const {
        name,
        address,
        username,
        password,
        location_id,
        location_ids,
        all_location_access,
        role,
        permissions,
        opening_balance,
        opening_balance_type,
        assigned_warehouse_ids,
        all_warehouse_access,
      } = req.body;

      const mobile =
        getIncomingMobile(
          req.body
        );

      const cleanName =
        String(
          name || ""
        ).trim();

      const cleanUsername =
        String(
          username || ""
        ).trim();

      if (
        !cleanName ||
        !cleanUsername ||
        !password
      ) {
        return res.status(400).json({
          error:
            "Name, username, and password are required",
        });
      }

      if (
        location_id &&
        !mongoose.Types.ObjectId.isValid(
          String(location_id)
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid location ID",
        });
      }

      /*
       * Validate assigned warehouses.
       */
      const safeWarehouseIds =
        parseWarehouseIds(
          assigned_warehouse_ids
        );

      for (
        const warehouseId of
          safeWarehouseIds
      ) {
        if (
          !mongoose.Types.ObjectId.isValid(
            warehouseId
          )
        ) {
          return res.status(400).json({
            error:
              `Invalid warehouse ID: ${warehouseId}`,
          });
        }
      }

      /*
       * Validate location_ids.
       */
      const safeLocationIds =
        normalizeIdArray(
          location_ids
        );

      for (
        const locationId of
          safeLocationIds
      ) {
        if (
          !mongoose.Types.ObjectId.isValid(
            locationId
          )
        ) {
          return res.status(400).json({
            error:
              `Invalid location ID: ${locationId}`,
          });
        }
      }

      /*
       * Prevent duplicate username.
       */
      const existing =
        await Employee.findOne({
          username:
            cleanUsername,
        }).lean();

      if (existing) {
        return res.status(409).json({
          error:
            "Username already exists",
        });
      }

      /*
       * Prevent role escalation.
       */
      const safeRole =
        normalizeRole(
          role || "staff"
        );

      if (
        safeRole === "admin" &&
        !isAdminUser(req.user)
      ) {
        return res.status(403).json({
          error:
            "Only admin can create admin users",
        });
      }

      /*
       * Generate employee ID.
       */
      let employee_id =
        "EMP001";

      if (location_id) {
        const location =
          await Location.findById(
            location_id
          ).lean();

        if (
          location &&
          location.abbr
        ) {
          const abbr =
            String(
              location.abbr
            )
              .trim()
              .toUpperCase();

          const count =
            await Employee.countDocuments({
              location_id:
                location_id,
            });

          const nextSeq =
            String(
              count + 1
            ).padStart(
              2,
              "0"
            );

          employee_id =
            abbr + nextSeq;
        }
      }

      /*
       * Global fallback employee ID.
       *
       * Use created_at, because our Mongo schema
       * uses created_at rather than createdAt.
       */
      if (
        employee_id ===
        "EMP001"
      ) {
        const lastEmployee =
          await Employee.findOne({})
            .sort({
              created_at: -1,
              _id: -1,
            })
            .lean();

        let nextNumber =
          1;

        if (
          lastEmployee &&
          lastEmployee.employee_id
        ) {
          const digits =
            String(
              lastEmployee.employee_id
            ).replace(
              /\D/g,
              ""
            );

          const lastNumber =
            parseInt(
              digits,
              10
            );

          if (
            Number.isFinite(
              lastNumber
            )
          ) {
            nextNumber =
              lastNumber + 1;
          }
        }

        employee_id =
          "EMP" +
          String(
            nextNumber
          ).padStart(
            3,
            "0"
          );
      }

      const safePermissions =
        safeRole === "admin"
          ? ["all"]
          : parsePermissions(
              permissions,
              safeRole
            );

      const hash =
        await bcrypt.hash(
          String(password),
          10
        );

      const employee =
        await Employee.create({
          employee_id,

          name:
            cleanName,

          mobile:
            mobile,

          address:
            address || "",

          username:
            cleanUsername,

          password:
            hash,

          location_id:
            location_id || null,

          location_ids:
            safeLocationIds,

          all_location_access:
            !!all_location_access,

          role:
            safeRole,

          permissions:
            safePermissions,

          opening_balance:
            Number(
              opening_balance || 0
            ),

          opening_balance_type:
            String(
              opening_balance_type ||
                "dr"
            ).toLowerCase() ===
            "cr"
              ? "cr"
              : "dr",

          assigned_warehouse_ids:
            safeWarehouseIds,

          all_warehouse_access:
            !!all_warehouse_access,

          created_at:
            new Date(),
        });

      return res.json(
        buildEmployeeResponse(
          employee
        )
      );
    } catch (err) {
      logEmployeeRouteError(
        "create",
        err,
        req
      );

      return res.status(500).json({
        error:
          "Failed to create employee",
          details:
            err.message,
      });
    }
  }
);

/*
====================================================
UPDATE EMPLOYEE
====================================================
*/

router.put(
  "/:id",
  async (req, res) => {
    try {
      if (!requireMongo(res)) {
        return;
      }

      if (
        !mongoose.Types.ObjectId.isValid(
          String(
            req.params.id
          )
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid employee ID",
        });
      }

      const targetEmployeeId =
        req.params.id;

      const admin =
        isAdminUser(req.user);

      const canEditNonAdmin =
        userHasPermission(
          req.user,
          "employees.edit.non_admin"
        );

      if (
        !admin &&
        !canEditNonAdmin
      ) {
        return res.status(403).json({
          error:
            "You do not have permission to edit employees",
        });
      }

      const {
        name,
        address,
        username,
        password,
        location_id,
        location_ids,
        all_location_access,
        role,
        permissions,
        opening_balance,
        opening_balance_type,
        assigned_warehouse_ids,
        all_warehouse_access,
      } = req.body;

      const mobile =
        getIncomingMobile(
          req.body
        );

      const target =
        await Employee.findById(
          targetEmployeeId
        );

      if (!target) {
        return res.status(404).json({
          error:
            "Employee not found",
        });
      }

      /*
       * Prevent role escalation.
       */
      const safeRole =
        normalizeRole(
          role !== undefined
            ? role
            : target.role ||
              "staff"
        );

      if (
        safeRole === "admin" &&
        !admin
      ) {
        return res.status(403).json({
          error:
            "Only admin can set admin role",
        });
      }

      const targetIsAdmin =
        target.role ===
          "admin" ||
        (
          Array.isArray(
            target.permissions
          ) &&
          target.permissions.includes(
            "all"
          )
        );

      if (
        targetIsAdmin &&
        !admin
      ) {
        return res.status(403).json({
          error:
            "Only admin can edit admin user",
        });
      }

      /*
       * Validate username if changed.
       */
      const nextUsername =
        username !== undefined
          ? String(
              username
            ).trim()
          : String(
              target.username ||
                ""
            ).trim();

      if (!nextUsername) {
        return res.status(400).json({
          error:
            "Username is required",
        });
      }

      if (
        nextUsername !==
        target.username
      ) {
        const duplicate =
          await Employee.findOne({
            username:
              nextUsername,

            _id: {
              $ne:
                target._id,
            },
          }).lean();

        if (duplicate) {
          return res.status(409).json({
            error:
              "Username already exists",
          });
        }
      }

      /*
       * Validate location.
       */
      let safeLocationId =
        target.location_id ||
        null;

      if (
        location_id !==
        undefined
      ) {
        if (
          location_id &&
          !mongoose.Types.ObjectId.isValid(
            String(
              location_id
            )
          )
        ) {
          return res.status(400).json({
            error:
              "Invalid location ID",
          });
        }

        safeLocationId =
          location_id || null;
      }

      /*
       * Validate location_ids.
       */
      const incomingLocationIds =
        normalizeIdArray(
          location_ids
        );

      const safeLocationIds =
        incomingLocationIds.length > 0
          ? incomingLocationIds
          : Array.isArray(
              target.location_ids
            )
            ? target.location_ids
                .map(getRecordId)
                .filter(Boolean)
            : [];

      for (
        const locationId of
          safeLocationIds
      ) {
        if (
          !mongoose.Types.ObjectId.isValid(
            locationId
          )
        ) {
          return res.status(400).json({
            error:
              `Invalid location ID: ${locationId}`,
          });
        }
      }

      /*
       * Validate warehouses.
       */
      const safeWarehouseIds =
        assigned_warehouse_ids !==
        undefined
          ? parseWarehouseIds(
              assigned_warehouse_ids
            )
          : parseWarehouseIds(
              target.assigned_warehouse_ids
            );

      for (
        const warehouseId of
          safeWarehouseIds
      ) {
        if (
          !mongoose.Types.ObjectId.isValid(
            warehouseId
          )
        ) {
          return res.status(400).json({
            error:
              `Invalid warehouse ID: ${warehouseId}`,
          });
        }
      }

      const safePermissions =
        safeRole === "admin"
          ? ["all"]
          : permissions !==
            undefined
          ? parsePermissions(
              permissions,
              safeRole
            )
          : parsePermissions(
              target.permissions,
              safeRole
            );

      const updateData = {
        name:
          name ??
          target.name,

        mobile:
          mobile !== ""
            ? mobile
            : getEmployeeMobile(
                target
              ),

        address:
          address ??
          target.address ??
          "",

        username:
          nextUsername,

        location_id:
          safeLocationId,

        location_ids:
          safeLocationIds,

        all_location_access:
          all_location_access !==
          undefined
            ? !!all_location_access
            : !!target.all_location_access,

        role:
          safeRole,

        permissions:
          safePermissions,

        opening_balance:
          opening_balance !==
          undefined
            ? Number(
                opening_balance ||
                  0
              )
            : Number(
                target.opening_balance ||
                  0
              ),

        opening_balance_type:
          opening_balance_type !==
          undefined
            ? String(
                opening_balance ||
                  opening_balance_type ||
                  "dr"
              ).toLowerCase() ===
              "cr"
              ? "cr"
              : "dr"
            : String(
                target.opening_balance_type ||
                  "dr"
              ).toLowerCase() ===
              "cr"
            ? "cr"
            : "dr",

        assigned_warehouse_ids:
          safeWarehouseIds,

        all_warehouse_access:
          all_warehouse_access !==
          undefined
            ? !!all_warehouse_access
            : !!target.all_warehouse_access,

        updated_at:
          new Date(),
      };

      if (password) {
        updateData.password =
          await bcrypt.hash(
            String(password),
            10
          );
      }

      Object.assign(
        target,
        updateData
      );

      await target.save();

      const refreshedEmployee =
        await Employee.findById(
          targetEmployeeId
        ).lean();

      return res.json({
        updated:
          1,

        employee:
          buildEmployeeResponse(
            refreshedEmployee
          ),
      });
    } catch (err) {
      logEmployeeRouteError(
        "update",
        err,
        req
      );

      return res.status(500).json({
        error:
          "Failed to update employee",
          details:
            err.message,
      });
    }
  }
);

/*
====================================================
DELETE EMPLOYEE
====================================================
*/

router.delete(
  "/:id",
  async (req, res) => {
    try {
      if (!isAdminUser(req.user)) {
        return res.status(403).json({
          error:
            "Only admin can delete employee users",
        });
      }

      if (!requireMongo(res)) {
        return;
      }

      if (
        !mongoose.Types.ObjectId.isValid(
          String(
            req.params.id
          )
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid employee ID",
        });
      }

      const employeeId =
        req.params.id;

      const deleted =
        await Employee.findByIdAndDelete(
          employeeId
        ).lean();

      if (!deleted) {
        return res.status(404).json({
          error:
            "Employee not found",
        });
      }

      /*
       * Remove employee assignment
       * from warehouses.
       */
      await Warehouse.updateMany(
        {
          employee_id:
            employeeId,
        },
        {
          $set: {
            employee_id:
              null,
          },
        }
      );

      return res.json({
        deleted:
          1,

        id:
          employeeId,

        source:
          "mongodb",
      });
    } catch (err) {
      logEmployeeRouteError(
        "delete",
        err,
        req
      );

      return res.status(500).json({
        error:
          "Failed to delete employee",
          details:
            err.message,
      });
    }
  }
);

module.exports = router;
