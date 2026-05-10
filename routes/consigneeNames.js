const express = require("express");
const router = express.Router();
const db = require("../db");
const multer = require("multer");
const XLSX = require("xlsx");
const { isAdminUser } = require("../middleware/auth");
const upload = multer({ storage: multer.memoryStorage() });

function rowBody(body) {
  const name = (body.name || "").trim();
  const buyer_id = body.buyer_id != null && body.buyer_id !== "" ? Number(body.buyer_id) : null;
  return {
    name,
    buyer_id: Number.isFinite(buyer_id) ? buyer_id : null,
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
  db.all(
    `
    SELECT c.*, b.name AS buyer_name
    FROM consignee_names c
    LEFT JOIN buyer_names b ON b.id = c.buyer_id
    ORDER BY c.name COLLATE NOCASE
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

router.post("/", (req, res) => {
  const r = rowBody(req.body);
  if (!r.name) return res.status(400).json({ error: "Name is required" });

  db.run(
    `
    INSERT INTO consignee_names (
      buyer_id, name, mobile, email, address, gst_no, pan_no, state, location
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      r.buyer_id,
      r.name,
      r.mobile,
      r.email,
      r.address,
      r.gst_no,
      r.pan_no,
      r.state,
      r.location,
    ],
    function (err) {
      if (err) {
        if (String(err.message).includes("UNIQUE"))
          return res.status(400).json({ error: "This consignee name already exists" });
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID, ...r });
    }
  );
});

function importConsigneeRows(rows, res) {
  db.all("SELECT id, name FROM buyer_names ORDER BY name COLLATE NOCASE", [], (buyerErr, buyerRows) => {
    if (buyerErr) {
      return res.status(500).json({ error: buyerErr.message });
    }

    const buyerByName = new Map();
    (buyerRows || []).forEach((b) => {
      buyerByName.set(String(b.name || "").trim().toLowerCase(), b.id);
    });

    let inserted = 0;
    let skipped = 0;
    const errors = [];

    const processRow = (index) => {
      if (index >= rows.length) {
        return res.json({ total: rows.length, inserted, skipped, errors });
      }

      const raw = rows[index] || {};
      const r = rowBody(raw);
      const buyerNameKey = String(raw.buyer_name || raw.BuyerName || "").trim().toLowerCase();
      const buyerIdFromName = buyerByName.get(buyerNameKey);
      const buyerIdFromField = Number(raw.buyer_id || raw.BuyerId || raw.buyerId) || null;
      if (!r.buyer_id && (buyerIdFromName || buyerIdFromField)) {
        r.buyer_id = buyerIdFromName || buyerIdFromField;
      }

      if (!r.name) {
        skipped += 1;
        errors.push({ row: index + 2, error: "Name is required" });
        return processRow(index + 1);
      }

      db.get("SELECT id FROM consignee_names WHERE lower(name)=lower(?) LIMIT 1", [r.name], (findErr, exists) => {
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
          INSERT INTO consignee_names (buyer_id, name, mobile, email, address, gst_no, pan_no, state, location)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [r.buyer_id, r.name, r.mobile, r.email, r.address, r.gst_no, r.pan_no, r.state, r.location],
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
  });
}

router.post("/import", (req, res) => {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: "Only admin can import consignee master" });
  }
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (rows.length === 0) {
    return res.status(400).json({ error: "No rows found for import" });
  }
  return importConsigneeRows(rows, res);
});

router.post("/import-xlsx", upload.single("file"), (req, res) => {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: "Only admin can import consignee master" });
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
    buyer_id: r.buyer_id ?? r.BuyerId ?? r.buyerId ?? "",
    buyer_name: r.buyer_name ?? r.BuyerName ?? "",
    name: r.name ?? r.Name ?? r.consignee_name ?? r.ConsigneeName ?? "",
    mobile: r.mobile ?? r.Mobile ?? "",
    email: r.email ?? r.Email ?? "",
    address: r.address ?? r.Address ?? "",
    gst_no: r.gst_no ?? r.GST ?? r.GSTNo ?? "",
    pan_no: r.pan_no ?? r.PAN ?? r.PANNo ?? "",
    state: r.state ?? r.State ?? "",
    location: r.location ?? r.Location ?? "",
  }));

  return importConsigneeRows(normalized, res);
});

router.put("/:id", (req, res) => {
  const { id } = req.params;
  const r = rowBody(req.body);
  if (!r.name) return res.status(400).json({ error: "Name is required" });

  db.run(
    `
    UPDATE consignee_names SET
      buyer_id = ?, name = ?, mobile = ?, email = ?, address = ?, gst_no = ?, pan_no = ?, state = ?, location = ?
    WHERE id = ?
    `,
    [
      r.buyer_id,
      r.name,
      r.mobile,
      r.email,
      r.address,
      r.gst_no,
      r.pan_no,
      r.state,
      r.location,
      id,
    ],
    function (err) {
      if (err) {
        if (String(err.message).includes("UNIQUE"))
          return res.status(400).json({ error: "This consignee name already exists" });
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) return res.status(404).json({ error: "Not found" });
      res.json({ id: Number(id), ...r });
    }
  );
});

router.delete("/:id", (req, res) => {
  const { id } = req.params;
  db.run("DELETE FROM consignee_names WHERE id = ?", [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: "Not found" });
    res.json({ message: "Deleted", id: Number(id) });
  });
});

module.exports = router;
