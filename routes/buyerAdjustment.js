const express = require("express");
const router = express.Router();
const db = require("../db");
const dbMongo = require("../db-mongodb");
const { userHasPermission } = require("../middleware/auth");

const safeNumber = (v) => (v === undefined || v === null || v === "" ? 0 : Number(v));
const safeText = (v) => (v ? v : null);

// Get outward entries without unloading details (no buyer_adjustments)
router.get("/without-unloading", async (req, res) => {
  if (!userHasPermission(req.user, "outward.view") && !userHasPermission(req.user, "outward.create")) {
    return res.status(403).json({ error: "You do not have permission to view outward entries" });
  }

  try {
    const query = `
      SELECT o.*, 
             e.name as employee_name,
             l.name as location_name,
             w.name as warehouse_name,
             p.name as product_name,
             c.name as company_name,
             ca.account_name as account_name,
             ca.account_name as party_name
      FROM outward o
      LEFT JOIN employees e ON o.employee_id = e.id
      LEFT JOIN locations l ON o.location_id = l.id
      LEFT JOIN warehouses w ON o.warehouse_id = w.id
      LEFT JOIN products p ON o.product_id = p.id
      LEFT JOIN companies c ON o.company_id = c.id
      LEFT JOIN company_accounts ca ON o.company_account_id = ca.id
      WHERE o.id NOT IN (
        SELECT DISTINCT outward_id FROM buyer_adjustments
      )
      AND o.status IN ('Pending', 'Partial')
      ORDER BY o.created_at DESC
    `;

    db.all(query, [], (err, rows) => {
      if (err) {
        console.error("Error fetching outward entries:", err);

        // Fallback for older / un-migrated databases without buyer_adjustments table
        if (err.message && err.message.includes("no such table: buyer_adjustments")) {
          const fallbackQuery = `
            SELECT o.*, 
                   e.name as employee_name,
                   l.name as location_name,
                   w.name as warehouse_name,
                   p.name as product_name,
                   c.name as company_name,
                   ca.account_name as account_name,
                   ca.account_name as party_name
            FROM outward o
            LEFT JOIN employees e ON o.employee_id = e.id
            LEFT JOIN locations l ON o.location_id = l.id
            LEFT JOIN warehouses w ON o.warehouse_id = w.id
            LEFT JOIN products p ON o.product_id = p.id
            LEFT JOIN companies c ON o.company_id = c.id
            LEFT JOIN company_accounts ca ON o.company_account_id = ca.id
            WHERE o.status IN ('Pending', 'Partial')
            ORDER BY o.created_at DESC
          `;

          db.all(fallbackQuery, [], (fallbackErr, fallbackRows) => {
            if (fallbackErr) {
              console.error("Fallback error fetching outward entries:", fallbackErr);
              return res.status(500).json({ error: "Database error: " + fallbackErr.message });
            }
            return res.json(Array.isArray(fallbackRows) ? fallbackRows : []);
          });
          return;
        }

        return res.status(500).json({ error: "Database error: " + err.message });
      }

      res.json(Array.isArray(rows) ? rows : []);
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error: " + err.message });
  }
});

// Get outward entries that already have buyer adjustments
router.get("/with-adjustments", async (req, res) => {
  if (!userHasPermission(req.user, "outward.view") && !userHasPermission(req.user, "outward.create")) {
    return res.status(403).json({ error: "You do not have permission to view outward entries" });
  }

  try {
    const query = `
      SELECT o.id as outward_id,
             o.voucher_no,
             o.date,
             o.status as outward_status,
             w.name as warehouse_name,
             p.name as product_name,
             COALESCE(ba.buyer_name, b.name) as buyer_name,
             ba.qty,
             ba.rate,
             ba.claim,
             ba.other_deduction,
             ba.shortage,
             ba.status as adjustment_status,
             ba.id as adjustment_id
      FROM buyer_adjustments ba
      JOIN outward o ON ba.outward_id = o.id
      LEFT JOIN warehouses w ON o.warehouse_id = w.id
      LEFT JOIN products p ON o.product_id = p.id
      LEFT JOIN buyer_names b ON ba.buyer_id = b.id
      ORDER BY o.created_at DESC, ba.created_at DESC
    `;

    db.all(query, [], (err, rows) => {
      if (err) {
        console.error("Error fetching outward entries with buyer adjustments:", err);
        return res.status(500).json({ error: "Database error: " + err.message });
      }

      res.json(Array.isArray(rows) ? rows : []);
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error: " + err.message });
  }
});

// Get buyer adjustments for a specific outward
router.get("/:outwardId", async (req, res) => {
  if (!userHasPermission(req.user, "outward.view")) {
    return res.status(403).json({ error: "You do not have permission" });
  }

  const { outwardId } = req.params;

  try {
    const query = `
      SELECT ba.*, 
             COALESCE(ba.buyer_name, b.name) as buyer_name
      FROM buyer_adjustments ba
      LEFT JOIN buyer_names b ON ba.buyer_id = b.id
      WHERE ba.outward_id = ?
      ORDER BY ba.created_at DESC
    `;

    db.all(query, [safeNumber(outwardId)], (err, rows) => {
      if (err) {
        console.error("Error fetching buyer adjustments:", err);
        return res.status(500).json({ error: "Database error" });
      }

      res.json(Array.isArray(rows) ? rows : []);
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Create buyer adjustment
router.post("/", async (req, res) => {
  if (!userHasPermission(req.user, "adjustment.manage")) {
    return res.status(403).json({ error: "You do not have permission to create adjustments" });
  }

  const { outward_id, buyer_id, buyer_name, unloading_date, weight, qty, rate, claim, other_deduction, shortage, status } = req.body;

  if (!outward_id || !qty) {
    return res.status(400).json({ error: "Missing required fields: outward_id, qty" });
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO buyer_adjustments 
      (outward_id, buyer_id, buyer_name, unloading_date, weight, qty, rate, claim, other_deduction, shortage, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      safeNumber(outward_id),
      safeNumber(buyer_id) || null,
      safeText(buyer_name),
      safeText(unloading_date),
      safeNumber(weight),
      safeNumber(qty),
      safeNumber(rate),
      safeNumber(claim),
      safeNumber(other_deduction),
      safeNumber(shortage),
      safeText(status) || "Pending"
    );

    const lastId = stmt.lastID;
    stmt.finalize();

    res.json({ id: lastId, message: "Buyer adjustment created successfully" });
  } catch (err) {
    console.error("Error creating buyer adjustment:", err);
    res.status(500).json({ error: "Failed to create buyer adjustment" });
  }
});

// Update buyer adjustment
router.put("/:id", async (req, res) => {
  if (!userHasPermission(req.user, "adjustment.manage")) {
    return res.status(403).json({ error: "You do not have permission to update adjustments" });
  }

  const { id } = req.params;
  const { buyer_id, buyer_name, unloading_date, weight, qty, rate, claim, other_deduction, shortage, status } = req.body;

  try {
    const stmt = db.prepare(`
      UPDATE buyer_adjustments 
      SET buyer_id = ?, buyer_name = ?, unloading_date = ?, weight = ?, qty = ?, rate = ?, 
          claim = ?, other_deduction = ?, shortage = ?, status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    stmt.run(
      safeNumber(buyer_id) || null,
      safeText(buyer_name),
      safeText(unloading_date),
      safeNumber(weight),
      safeNumber(qty),
      safeNumber(rate),
      safeNumber(claim),
      safeNumber(other_deduction),
      safeNumber(shortage),
      safeText(status) || "Pending",
      safeNumber(id)
    );

    stmt.finalize();

    res.json({ message: "Buyer adjustment updated successfully" });
  } catch (err) {
    console.error("Error updating buyer adjustment:", err);
    res.status(500).json({ error: "Failed to update buyer adjustment" });
  }
});

// Delete buyer adjustment
router.delete("/:id", async (req, res) => {
  if (!userHasPermission(req.user, "adjustment.manage")) {
    return res.status(403).json({ error: "You do not have permission to delete adjustments" });
  }

  const { id } = req.params;

  try {
    const stmt = db.prepare(`
      DELETE FROM buyer_adjustments WHERE id = ?
    `);

    stmt.run(safeNumber(id));
    stmt.finalize();

    res.json({ message: "Buyer adjustment deleted successfully" });
  } catch (err) {
    console.error("Error deleting buyer adjustment:", err);
    res.status(500).json({ error: "Failed to delete buyer adjustment" });
  }
});

module.exports = router;
