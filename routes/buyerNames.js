const express = require("express");
const router = express.Router();
const db = require("../db");
const multer = require("multer");
const XLSX = require("xlsx");
const { isAdminUser } = require("../middleware/auth");
const { userHasPermission } = require("../middleware/auth");
const upload = multer({ storage: multer.memoryStorage() });

function canAccessBuyerNames(user) {
  return [
    "buyerNames.view",
    "buyerNames.create",
    "buyerNames.edit",
    "buyerNames.delete",
    "outward.view",
    "outward.create",
    "outward.edit",
    "adjustment.manage",
    "expense.view",
    "expense.create",
    "expense.edit",
    "expense.entry",
  ].some((permission) => userHasPermission(user, permission));
}

function rowBody(body) {
  const name = (body.name || "").trim();
  return {
    name,
    mobile: (body.mobile || "").trim() || null,
    email: (body.email || "").trim() || null,
    address: (body.address || "").trim() || null,
    gst_no: (body.gst_no || "").trim() || null,
    pan_no: (body.pan_no || "").trim() || null,
    state: (body.state || "").trim() || null,
    location: (body.location || "").trim() || null,
  };
}

router.get("/", (req, res) => {
  if (!canAccessBuyerNames(req.user)) {
    return res.status(403).json({ error: "You do not have permission to view buyer names" });
  }

  db.all("SELECT * FROM buyer_names ORDER BY name COLLATE NOCASE", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

router.post("/", (req, res) => {
  if (!canAccessBuyerNames(req.user)) {
    return res.status(403).json({ error: "You do not have permission to create buyer names" });
  }

  const r = rowBody(req.body);
  if (!r.name) return res.status(400).json({ error: "Name is required" });

  db.run(
    `
    INSERT INTO buyer_names (
      name, mobile, email, address, gst_no, pan_no, state, location
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [r.name, r.mobile, r.email, r.address, r.gst_no, r.pan_no, r.state, r.location],
    function (err) {
      if (err) {
        if (String(err.message).includes("UNIQUE"))
          return res.status(400).json({ error: "This buyer name already exists" });
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID, ...r });
    }
  );
});

function importBuyerRows(rows, res) {
  let inserted = 0;
  let skipped = 0;
  const errors = [];

  const processRow = (index) => {
    if (index >= rows.length) {
      return res.json({ total: rows.length, inserted, skipped, errors });
    }

    const r = rowBody(rows[index] || {});
    if (!r.name) {
      skipped += 1;
      errors.push({ row: index + 2, error: "Name is required" });
      return processRow(index + 1);
    }

    db.get("SELECT id FROM buyer_names WHERE lower(name)=lower(?) LIMIT 1", [r.name], (findErr, exists) => {
      if (findErr) {
        skipped += 1;
        errors.push({ row: index + 2, error: findErr.message });
        return processRow(index + 1);
      }
      if (exists) {
        skipped += 1;
        return processRow(index + 1);
      }

      db.run(
        `
        INSERT INTO buyer_names (name, mobile, email, address, gst_no, pan_no, state, location)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [r.name, r.mobile, r.email, r.address, r.gst_no, r.pan_no, r.state, r.location],
        (insertErr) => {
          if (insertErr) {
            skipped += 1;
            errors.push({ row: index + 2, error: insertErr.message });
          } else {
            inserted += 1;
          }
          return processRow(index + 1);
        }
      );
    });
  };

  return processRow(0);
}

router.post("/import", (req, res) => {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: "Only admin can import buyer master" });
  }
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (rows.length === 0) {
    return res.status(400).json({ error: "No rows found for import" });
  }
  return importBuyerRows(rows, res);
});

router.post("/import-xlsx", upload.single("file"), (req, res) => {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: "Only admin can import buyer master" });
  }
  if (!req.file?.buffer) {
    return res.status(400).json({ error: "XLSX file is required" });
  }

  let rows = [];
  try {
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const firstSheet = workbook.SheetNames?.[0];
    if (!firstSheet) return res.status(400).json({ error: "No sheet found in file" });
    rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: "" });
  } catch (err) {
    return res.status(400).json({ error: "Invalid XLSX file" });
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "No rows found in XLSX" });
  }

  const normalized = rows.map((r) => ({
    name: r.name ?? r.Name ?? r.buyer_name ?? r.BuyerName ?? "",
    mobile: r.mobile ?? r.Mobile ?? "",
    email: r.email ?? r.Email ?? "",
    address: r.address ?? r.Address ?? "",
    gst_no: r.gst_no ?? r.GST ?? r.GSTNo ?? "",
    pan_no: r.pan_no ?? r.PAN ?? r.PANNo ?? "",
    state: r.state ?? r.State ?? "",
    location: r.location ?? r.Location ?? "",
  }));

  return importBuyerRows(normalized, res);
});

router.put("/:id", (req, res) => {
  if (!canAccessBuyerNames(req.user)) {
    return res.status(403).json({ error: "You do not have permission to update buyer names" });
  }

  const { id } = req.params;
  const r = rowBody(req.body);
  if (!r.name) return res.status(400).json({ error: "Name is required" });

  db.run(
    `
    UPDATE buyer_names SET
      name = ?, mobile = ?, email = ?, address = ?, gst_no = ?, pan_no = ?, state = ?, location = ?
    WHERE id = ?
    `,
    [r.name, r.mobile, r.email, r.address, r.gst_no, r.pan_no, r.state, r.location, id],
    function (err) {
      if (err) {
        if (String(err.message).includes("UNIQUE"))
          return res.status(400).json({ error: "This buyer name already exists" });
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) return res.status(404).json({ error: "Not found" });
      res.json({ id: Number(id), ...r });
    }
  );
});

router.delete("/:id", (req, res) => {
  if (!canAccessBuyerNames(req.user)) {
    return res.status(403).json({ error: "You do not have permission to delete buyer names" });
  }

  const { id } = req.params;
  db.run("DELETE FROM buyer_names WHERE id = ?", [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: "Not found" });
    res.json({ message: "Deleted", id: Number(id) });
  });
});

module.exports = router;
