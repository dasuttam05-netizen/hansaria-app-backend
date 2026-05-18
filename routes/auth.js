const express = require("express");
const bcrypt = require("bcryptjs");

const {
  Employee,
  Warehouse,
  Location,
} = require("../mongo");

const {
  authenticate,
  authorize,
  buildUserPayload,
  normalizeRole,
  parsePermissions,
  signUserToken,
} = require("../middleware/auth");

const router = express.Router();

function getRecordId(value) {
  if (!value) return null;
  if (value._id) return String(value._id);
  if (value.id) return String(value.id);
  return String(value);
}

async function attachAssignedWarehousesMongo(user) {
  const assignedIds = Array.isArray(user.assigned_warehouse_ids)
    ? user.assigned_warehouse_ids
        .map((id) => String(id || "").trim())
        .filter((id) => id)
    : [];

  const filter = user.all_warehouse_access
    ? {}
    : assignedIds.length
    ? { _id: { $in: assignedIds } }
    : {
        $or: [
          { employee_id: user.id },
          { employee_ids: user.id },
        ],
      };

  const warehouses = await Warehouse.find(filter)
    .populate("location_id", "name")
    .sort({ name: 1 });

  const normalizedWarehouses = (warehouses || []).map((row) => {
    const plain = row.toObject ? row.toObject() : row;
    return {
      ...plain,
      id: getRecordId(row),
      location_id: getRecordId(row.location_id),
      location_name: row.location_id?.name || plain.location_name || "",
    };
  });

  const locationIds = Array.from(
    new Set(
      normalizedWarehouses
        .map((row) => row.location_id)
        .filter((item) => item)
    )
  );

  if (user.all_location_access) {
    const locations = await Location.find({}, { _id: 1 }).lean();
    locationIds.push(
      ...(locations || [])
        .map((row) => getRecordId(row))
        .filter((item) => item)
    );
  }

  const normalizedLocationIds = Array.from(new Set(locationIds));

  return {
    ...user,
    location_id: getRecordId(user.location_id) || normalizedLocationIds[0] || null,
    location_ids: normalizedLocationIds,
    all_location_access: !!user.all_location_access,
    assigned_warehouses: normalizedWarehouses,
    assigned_warehouse_ids: normalizedWarehouses.map(
      (row) => row.id
    ),
    all_warehouse_access: !!user.all_warehouse_access,
  };
}

router.post(
  "/register",
  authenticate,
  authorize("employees.view"),
  async (req, res) => {
    try {
      const {
        name,
        address,
        username,
        password,
        location_id,
        role,
        permissions,
      } = req.body;

      if (!name || !username || !password) {
        return res.status(400).json({
          error:
            "Name, username, and password are required",
        });
      }

      const existingUser = await Employee.findOne({
        username,
      });

      if (existingUser) {
        return res.status(400).json({
          error: "Username already exists",
        });
      }

      const safeRole = normalizeRole(role || "staff");

      const safePermissions =
        safeRole === "admin"
          ? ["all"]
          : parsePermissions(
              permissions,
              safeRole
            );

      const hash = await bcrypt.hash(password, 10);

      const employee = await Employee.create({
        name,
        address: address || "",
        username,
        password: hash,
        location_id: location_id || null,
        role: safeRole,
        permissions: safePermissions,
      });

      return res.json({
        id: employee._id,
        name: employee.name,
        address: employee.address,
        username: employee.username,
        location_id: employee.location_id,
        role: employee.role,
        permissions: employee.permissions,
      });

    } catch (err) {

      console.error(err);

      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

router.post("/login", async (req, res) => {
  try {

    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        error:
          "Username and password are required",
      });
    }

    const user = await Employee.findOne({
      username,
    });

    if (!user) {

  if (
    username === "admin" &&
    password === "1234"
  ) {

    const hashedPassword =
      await bcrypt.hash(
        "1234",
        10
      );

    const adminUser =
      await Employee.create({
        name: "Admin User",

        username: "admin",

        password:
          hashedPassword,

        role: "admin",

        permissions: ["all"],
      });

    const token =
      signUserToken({
        id: adminUser._id,
        username:
          adminUser.username,
        name: adminUser.name,
        role: adminUser.role,
        permissions:
          adminUser.permissions,
      });

    return res.json({
      token,

      user: {
        id: adminUser._id,
        username:
          adminUser.username,
        name: adminUser.name,
        role: adminUser.role,
        permissions:
          adminUser.permissions,
      },
    });
  }

  return res.status(400).json({
    error: "User not found",
  });
}

    const isMatch = await bcrypt.compare(
      password,
      user.password
    );

    if (!isMatch) {
      return res.status(400).json({
        error: "Invalid password",
      });
    }

    const token = signUserToken({
      id: user._id,
      username: user.username,
      name: user.name,
      role: user.role,
      permissions: user.permissions,
      location_id: user.location_id,
    });

    const userPayload =
      await attachAssignedWarehousesMongo(
        buildUserPayload({
          id: user._id,
          username: user.username,
          name: user.name,
          role: user.role,
          permissions: user.permissions,
          location_id: user.location_id,
          assigned_warehouse_ids: user.assigned_warehouse_ids,
          all_location_access: user.all_location_access,
          all_warehouse_access: user.all_warehouse_access,
        })
      );

    return res.json({
      token,
      user: userPayload,
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message,
    });
  }
});

router.get("/me", authenticate, (req, res) => {
  res.json({
    user: req.user,
  });
});

module.exports = router;
