const express = require("express");
const db = require("../db");
const dbMongo = require("../db-mongodb");
const { mongoose, Employee } = require("../mongo");
const { isAdminUser, ROLE_DEFAULT_PERMISSIONS } = require("../middleware/auth");

const router = express.Router();

const DEFAULT_ROLES = [
  {
    name: "HO",
    is_admin: 0,
    permissions: ROLE_DEFAULT_PERMISSIONS.ho,
  },
  {
    name: "BM",
    is_admin: 0,
    permissions: ROLE_DEFAULT_PERMISSIONS.bm,
  },
];

function formatRoleRow(row) {
  return {
    id: row.id || row._id,
    name: row.name,
    permissions: Array.isArray(row.permissions) ? row.permissions : [],
    is_admin: Number(row.is_admin) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getDefaultRoleRows() {
  return DEFAULT_ROLES.map((role, index) => ({
    id: `default-${index + 1}`,
    name: role.name,
    permissions: Array.isArray(role.permissions) ? role.permissions : [],
    is_admin: Number(role.is_admin) || 0,
    created_at: null,
    updated_at: null,
  }));
}

function normalizePermissions(permissions) {
  const raw = Array.isArray(permissions) ? permissions : [];
  return Array.from(new Set(raw.filter(Boolean).map((item) => String(item).trim()).filter(Boolean)));
}

function roleKey(name) {
  return String(name || "").trim().toLowerCase();
}

function isSeniorRole(name) {
  return ["ho", "bm"].includes(roleKey(name));
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getSqliteRoleById(id) {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM roles WHERE id = ?", [id], (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row || null);
    });
  });
}

async function updateAssignedEmployees(previousName, nextName, permissions) {
  // Role permissions are copied to the employee record at login. Keeping the
  // assigned users in sync means an HO/BM access tick takes effect immediately
  // for every user on that role, rather than only for new users.
  if (mongoose.connection.readyState !== 1) {
    return 0;
  }

  const previousRole = roleKey(previousName);
  if (!previousRole) return 0;

  const result = await Employee.updateMany(
    { role: { $regex: new RegExp(`^${escapeRegex(previousRole)}$`, "i") } },
    {
      $set: {
        role: roleKey(nextName) || previousRole,
        permissions: normalizePermissions(permissions),
      },
    }
  );

  return Number(result?.modifiedCount || result?.nModified || 0);
}

async function ensureDefaultRoles() {
  if (dbMongo.mongoose.connection.readyState !== 1) {
    return;
  }

  if (!db.isSqliteEnabled) {
    const docs = await dbMongo.Role.find({
      name: { $in: DEFAULT_ROLES.map((role) => role.name) },
    })
      .lean()
      .exec();

    const existingNames = new Set((docs || []).map((doc) => String(doc.name || "").toLowerCase()));
    const missingRoles = DEFAULT_ROLES.filter((role) => !existingNames.has(role.name.toLowerCase()));

    if (missingRoles.length > 0) {
      await dbMongo.Role.insertMany(
        missingRoles.map((role) => ({
          name: role.name,
          permissions: normalizePermissions(role.permissions),
          is_admin: role.is_admin,
        }))
      );
    }

    return;
  }

  const rows = await new Promise((resolve, reject) => {
    db.all("SELECT LOWER(name) AS name FROM roles", [], (selectErr, resultRows) => {
      if (selectErr) {
        reject(selectErr);
        return;
      }
      resolve(resultRows || []);
    });
  });

  const existingNames = new Set((rows || []).map((row) => row.name));
  const missingRoles = DEFAULT_ROLES.filter((role) => !existingNames.has(role.name.toLowerCase()));

  if (!missingRoles.length) {
    return;
  }

  const stmt = db.prepare("INSERT INTO roles (name, permissions, is_admin) VALUES (?, ?, ?)");
  try {
    missingRoles.forEach((role) => {
      stmt.run([role.name, JSON.stringify(role.permissions), role.is_admin]);
    });
  } finally {
    await new Promise((resolve, reject) => {
      stmt.finalize((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

router.get("/", async (req, res) => {
  if (dbMongo.mongoose.connection.readyState !== 1 && !db.isSqliteEnabled) {
    return res.json(getDefaultRoleRows());
  }

  try {
    await ensureDefaultRoles();

    if (!db.isSqliteEnabled) {
      const docs = await dbMongo.Role.find({})
        .sort({ name: 1 })
        .lean()
        .exec();
      return res.json((docs || []).map(formatRoleRow));
    }

    db.all("SELECT * FROM roles ORDER BY LOWER(name) ASC", [], (err, rows) => {
      if (err) {
        console.error("Failed to load roles from SQLite:", err.message);
        return res.json(getDefaultRoleRows());
      }
      return res.json(
        (rows || []).map((row) => ({
          ...row,
          permissions: (() => {
            try {
              return JSON.parse(row.permissions || "[]");
            } catch (error) {
              return [];
            }
          })(),
        }))
      );
    });
  } catch (err) {
    console.error("Role endpoint failed:", err.message);
    return res.json(getDefaultRoleRows());
  }
});

router.post("/", async (req, res) => {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: "Only admin can manage roles" });
  }

  const name = String(req.body?.name || "").trim();
  const permissions = normalizePermissions(req.body?.permissions);
  const is_admin = req.body?.is_admin ? 1 : 0;

  if (!name) {
    return res.status(400).json({ error: "Role name is required" });
  }

  if (isSeniorRole(name)) {
    return res.status(400).json({ error: "HO and BM already exist as protected senior roles. Please edit their access instead." });
  }

  try {
    const savedPermissions = is_admin ? ["all"] : permissions;
    const result = await new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO roles (name, permissions, is_admin) VALUES (?, ?, ?)",
        [name, JSON.stringify(savedPermissions), is_admin],
        function onInsert(err) {
          if (err) {
            reject(err);
            return;
          }
          resolve(this.lastID);
        }
      );
    });

    return res.json({ id: result, name, permissions: savedPermissions, is_admin });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.put("/:id", async (req, res) => {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: "Only admin can manage roles" });
  }

  const name = String(req.body?.name || "").trim();
  const permissions = normalizePermissions(req.body?.permissions);
  const is_admin = req.body?.is_admin ? 1 : 0;

  if (!name) {
    return res.status(400).json({ error: "Role name is required" });
  }

  try {
    const existing = await getSqliteRoleById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Role not found" });
    }

    if (isSeniorRole(existing.name) && roleKey(name) !== roleKey(existing.name)) {
      return res.status(400).json({ error: "HO and BM labels are fixed. You can change their access, but not rename them." });
    }

    const savedPermissions = is_admin ? ["all"] : permissions;
    const updated = await new Promise((resolve, reject) => {
      db.run(
        "UPDATE roles SET name = ?, permissions = ?, is_admin = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [name, JSON.stringify(savedPermissions), is_admin, req.params.id],
        function onUpdate(err) {
          if (err) {
            reject(err);
            return;
          }
          resolve(this.changes);
        }
      );
    });

    const employeesUpdated = await updateAssignedEmployees(existing.name, name, savedPermissions);
    return res.json({ updated, employees_updated: employeesUpdated });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: "Only admin can manage roles" });
  }

  try {
    const existing = await getSqliteRoleById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "Role not found" });
    }

    if (isSeniorRole(existing.name)) {
      return res.status(400).json({ error: "HO and BM are protected senior roles and cannot be deleted." });
    }

    if (mongoose.connection.readyState === 1) {
      const assignedCount = await Employee.countDocuments({
        role: { $regex: new RegExp(`^${escapeRegex(roleKey(existing.name))}$`, "i") },
      });
      if (assignedCount > 0) {
        return res.status(400).json({ error: "This role is assigned to users. Reassign those users before deleting it." });
      }
    }

    const deleted = await new Promise((resolve, reject) => {
      db.run("DELETE FROM roles WHERE id = ?", [req.params.id], function onDelete(err) {
        if (err) {
          reject(err);
          return;
        }
        resolve(this.changes);
      });
    });
    return res.json({ deleted });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
