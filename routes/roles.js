const express = require("express");
const db = require("../db");
const { isAdminUser } = require("../middleware/auth");

const router = express.Router();

function normalizePermissions(permissions) {
  const raw = Array.isArray(permissions) ? permissions : [];
  return Array.from(new Set(raw.filter(Boolean).map((item) => String(item).trim()).filter(Boolean)));
}

router.get("/", (req, res) => {
  db.all("SELECT * FROM roles ORDER BY LOWER(name) ASC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
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
});

router.post("/", (req, res) => {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: "Only admin can manage roles" });
  }

  const name = String(req.body?.name || "").trim();
  const permissions = normalizePermissions(req.body?.permissions);
  const is_admin = req.body?.is_admin ? 1 : 0;

  if (!name) {
    return res.status(400).json({ error: "Role name is required" });
  }

  db.run(
    "INSERT INTO roles (name, permissions, is_admin) VALUES (?, ?, ?)",
    [name, JSON.stringify(is_admin ? ["all"] : permissions), is_admin],
    function onInsert(err) {
      if (err) return res.status(500).json({ error: err.message });
      return res.json({ id: this.lastID, name, permissions: is_admin ? ["all"] : permissions, is_admin });
    }
  );
});

router.put("/:id", (req, res) => {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: "Only admin can manage roles" });
  }

  const name = String(req.body?.name || "").trim();
  const permissions = normalizePermissions(req.body?.permissions);
  const is_admin = req.body?.is_admin ? 1 : 0;

  if (!name) {
    return res.status(400).json({ error: "Role name is required" });
  }

  db.run(
    "UPDATE roles SET name = ?, permissions = ?, is_admin = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [name, JSON.stringify(is_admin ? ["all"] : permissions), is_admin, req.params.id],
    function onUpdate(err) {
      if (err) return res.status(500).json({ error: err.message });
      return res.json({ updated: this.changes });
    }
  );
});

router.delete("/:id", (req, res) => {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: "Only admin can manage roles" });
  }

  db.run("DELETE FROM roles WHERE id = ?", [req.params.id], function onDelete(err) {
    if (err) return res.status(500).json({ error: err.message });
    return res.json({ deleted: this.changes });
  });
});

module.exports = router;
