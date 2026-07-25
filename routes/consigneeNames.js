const express = require("express");
const router = express.Router();
const db = require("../db");
const multer = require("multer");
const XLSX = require("xlsx");
const { isAdminUser } = require("../middleware/auth");
const { userHasPermission } = require("../middleware/auth");
const upload = multer({ storage: multer.memoryStorage() });

function canAccessConsigneeNames(user) {
  return [
    "consigneeNames.view",
    "consigneeNames.create",
    "consigneeNames.edit",
    "consigneeNames.delete",
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

function parseBuyerIds(body) {
  let raw = [];
  if (Array.isArray(body?.buyer_ids)) {
    raw = body.buyer_ids;
  } else if (body?.buyer_ids != null && String(body.buyer_ids).trim() !== "") {
    raw = String(body.buyer_ids).split(/[,|]/);
  } else if (body?.buyer_id != null && body.buyer_id !== "") {
    raw = [body.buyer_id];
  }
  return [...new Set(raw.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0))];
}

function rowBody(body) {
  const name = (body.name || "").trim();
  const buyer_ids = parseBuyerIds(body);
  const buyer_id = buyer_ids.length ? buyer_ids[0] : null;
  return {
    name,
    buyer_id,
    buyer_ids,
    mobile: (body.mobile || "").trim() || null,
    email: (body.email || "").trim() || null,
    address: (body.address || "").trim() || null,
    gst_no: (body.gst_no || "").trim() || null,
    pan_no: (body.pan_no || "").trim() || null,
    state: (body.state || "").trim() || null,
    location: (body.location || "").trim() || null,
  };
}

function replaceConsigneeBuyers(consigneeId, buyerIds, done) {
  db.run("DELETE FROM consignee_buyers WHERE consignee_id = ?", [consigneeId], (delErr) => {
    if (delErr) return done(delErr);
    if (!buyerIds.length) return done(null);

    let pending = buyerIds.length;
    let failed = null;
    buyerIds.forEach((buyerId) => {
      db.run(
        "INSERT OR IGNORE INTO consignee_buyers (consignee_id, buyer_id) VALUES (?, ?)",
        [consigneeId, buyerId],
        (insErr) => {
          if (insErr && !failed) failed = insErr;
          pending -= 1;
          if (pending === 0) done(failed);
        }
      );
    });
  });
}

function mapConsigneeRow(row) {
  const buyer_ids = String(row.buyer_ids_csv || "")
    .split(",")
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0);
  const uniqueIds = [...new Set(buyer_ids.length ? buyer_ids : row.buyer_id ? [Number(row.buyer_id)] : [])];
  return {
    ...row,
    buyer_ids: uniqueIds,
    buyer_id: uniqueIds[0] || row.buyer_id || null,
    buyer_name: row.buyer_name || null,
    buyer_ids_csv: undefined,
  };
}

router.get("/", (req, res) => {
  if (!canAccessConsigneeNames(req.user)) {
    return res.status(403).json({ error: "You do not have permission to view consignee names" });
  }

  db.all(
    `
    SELECT
      c.*,
      COALESCE(
        (
          SELECT GROUP_CONCAT(cb.buyer_id)
          FROM consignee_buyers cb
          WHERE cb.consignee_id = c.id
        ),
        CASE WHEN c.buyer_id IS NOT NULL THEN CAST(c.buyer_id AS TEXT) ELSE NULL END
      ) AS buyer_ids_csv,
      COALESCE(
        (
          SELECT GROUP_CONCAT(b.name, ', ')
          FROM consignee_buyers cb
          JOIN buyer_names b ON b.id = cb.buyer_id
          WHERE cb.consignee_id = c.id
        ),
        (
          SELECT b2.name FROM buyer_names b2 WHERE b2.id = c.buyer_id
        )
      ) AS buyer_name
    FROM consignee_names c
    ORDER BY c.name COLLATE NOCASE
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json((rows || []).map(mapConsigneeRow));
    }
  );
});

router.post("/", (req, res) => {
  if (!userHasPermission(req.user, "consigneeNames.create")) {
    return res.status(403).json({ error: "You do not have permission to create consignee names" });
  }

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
      const id = this.lastID;
      replaceConsigneeBuyers(id, r.buyer_ids, (linkErr) => {
        if (linkErr) return res.status(500).json({ error: linkErr.message });
        res.json({ id, ...r });
      });
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
      const buyerNameRaw = String(raw.buyer_name || raw.BuyerName || "").trim();
      if (!r.buyer_ids.length && buyerNameRaw) {
        const names = buyerNameRaw.split(/[,|;]/).map((n) => n.trim()).filter(Boolean);
        const ids = names
          .map((n) => buyerByName.get(n.toLowerCase()))
          .filter((id) => Number.isFinite(id));
        if (ids.length) {
          r.buyer_ids = [...new Set(ids)];
          r.buyer_id = r.buyer_ids[0];
        }
      }
      const buyerIdFromField = Number(raw.buyer_id || raw.BuyerId || raw.buyerId) || null;
      if (!r.buyer_ids.length && buyerIdFromField) {
        r.buyer_ids = [buyerIdFromField];
        r.buyer_id = buyerIdFromField;
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
          function (insertErr) {
            if (insertErr) {
              skipped += 1;
              errors.push({ row: index + 2, error: insertErr.message });
              return processRow(index + 1);
            }
            const id = this.lastID;
            replaceConsigneeBuyers(id, r.buyer_ids, (linkErr) => {
              if (linkErr) {
                skipped += 1;
                errors.push({ row: index + 2, error: linkErr.message });
              } else {
                inserted += 1;
              }
              return processRow(index + 1);
            });
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
    buyer_ids: r.buyer_ids ?? r.BuyerIds ?? "",
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
  if (!userHasPermission(req.user, "consigneeNames.edit")) {
    return res.status(403).json({ error: "You do not have permission to update consignee names" });
  }

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
      replaceConsigneeBuyers(Number(id), r.buyer_ids, (linkErr) => {
        if (linkErr) return res.status(500).json({ error: linkErr.message });
        res.json({ id: Number(id), ...r });
      });
    }
  );
});

router.delete("/:id", (req, res) => {
  if (!userHasPermission(req.user, "consigneeNames.delete")) {
    return res.status(403).json({ error: "You do not have permission to delete consignee names" });
  }

  const { id } = req.params;
  db.run("DELETE FROM consignee_buyers WHERE consignee_id = ?", [id], (linkErr) => {
    if (linkErr) return res.status(500).json({ error: linkErr.message });
    db.run("DELETE FROM consignee_names WHERE id = ?", [id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: "Not found" });
      res.json({ message: "Deleted", id: Number(id) });
    });
  });
});

module.exports = router;
