
        return res.json({ message: "Cash entry status updated successfully" });
      }
    );
  });
});

router.patch("/bulk-cancel", (req, res) => {
  if (!userHasPermission(req.user, "cash.delete")) {
    return res.status(403).json({ error: "You do not have permission to cancel cash entries" });
  }

  const { ids } = req.body || {};
  const cleanIds = Array.isArray(ids)
    ? ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
    : [];

  if (cleanIds.length > 0) {
    db.all(
      `SELECT id, voucher_no, status FROM cash_entries WHERE id IN (${cleanIds.map(() => "?").join(",")})`,
      cleanIds,
      (fetchErr, selectedRows) => {
        if (fetchErr) return res.status(500).json({ error: fetchErr.message });

        const sql = `
          UPDATE cash_entries
          SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
          WHERE id IN (${cleanIds.map(() => "?").join(",")})
        `;
        db.run(sql, cleanIds, function (err) {
          if (err) return res.status(500).json({ error: err.message });

          writeCashAuditLog({
            req,
            action: "bulk_cancel",
            details: {
              ids: cleanIds,
              changes: this.changes || 0,
              entries: selectedRows || [],
            },
          });
          mirrorMultipleCashEntryStatus(cleanIds, "cancelled").catch((err) => {
            console.error("Mongo mirror error:", err.message);
          });
          return res.json({ message: "Selected entries cancelled successfully", changes: this.changes || 0 });
        });
      }
    );
    return;
  }

  db.all(
    `
    SELECT id, voucher_no, status
    FROM cash_entries
    WHERE COALESCE(status, 'pending') != 'cancelled'
    ORDER BY id DESC
    `,
    [],
    (fetchErr, allRows) => {
      if (fetchErr) return res.status(500).json({ error: fetchErr.message });

      db.run(
        `
        UPDATE cash_entries
        SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE COALESCE(status, 'pending') != 'cancelled'
        `,
        function (err) {
          if (err) return res.status(500).json({ error: err.message });

          writeCashAuditLog({
            req,
            action: "bulk_cancel",
            details: {
              all_active: true,
              changes: this.changes || 0,
              entries: allRows || [],
            },
          });
          mirrorAllNonCancelledEntriesStatus("cancelled").catch((err) => {
            console.error("Mongo mirror error:", err.message);
          });
          return res.json({ message: "All active entries cancelled successfully", changes: this.changes || 0 });
        }
      );
    }
  );
});

// Delete cash entry
router.delete("/:id(\\d+)", (req, res) => {
  if (!userHasPermission(req.user, "cash.delete")) {
    return res.status(403).json({ error: "You do not have permission to delete cash entries" });
  }

  const isPermanentDelete = String(req.query?.permanent || "0") === "1";
  getCashEntryBasicById(Number(req.params.id), (oldErr, oldRow) => {
    if (oldErr) return res.status(500).json({ error: oldErr.message });
    if (!oldRow) return res.status(404).json({ error: "Entry not found" });

    if (isPermanentDelete) {
      return db.run(
        "DELETE FROM cash_entry_adjustments WHERE source_entry_id = ? OR target_entry_id = ?",
        [req.params.id, req.params.id],
        (adjErr) => {
          if (adjErr) return res.status(500).json({ error: adjErr.message });
          return db.run("DELETE FROM cash_entries WHERE id = ?", [req.params.id], function (deleteErr) {
            if (deleteErr) return res.status(500).json({ error: deleteErr.message });
            if (this.changes === 0) return res.status(404).json({ error: "Entry not found" });

            writeCashAuditLog({
              req,
              action: "permanent_delete",
              entry_id: Number(req.params.id),
              voucher_no: oldRow.voucher_no || null,
              details: {
                previous_status: oldRow.status || "pending",
              },
            });
            removeCashEntryFromMongo(req.params.id).catch((err) => {
              console.error("Mongo mirror error:", err.message);
            });
            return res.json({ message: "Cash entry deleted permanently" });
          });
        }
      );
    }

    const sql = `
      UPDATE cash_entries
      SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `;
    db.run(sql, [req.params.id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: "Entry not found" });

      writeCashAuditLog({
        req,
        action: "delete",
        entry_id: Number(req.params.id),
        voucher_no: oldRow.voucher_no || null,
        details: {
          before_status: oldRow.status || "pending",
          after_status: "cancelled",
        },
      });
      updateMongoCashEntryFields(Number(req.params.id), {
        status: "cancelled",
        updated_at: new Date(),
      }).catch((err) => {
        console.error("Mongo mirror error:", err.message);
      });
      return res.json({ message: "Cash entry cancelled successfully" });
    });
  });
});

// Get cash summary (income vs expense by warehouse)
router.get("/summary/by-warehouse", (req, res) => {
  const { from_date, to_date } = req.query;

  let where = ["1=1"];
  const params = [];

  if (from_date) {
    where.push("ce.entry_date >= ?");
    params.push(from_date);
  }
  if (to_date) {
    where.push("ce.entry_date <= ?");
    params.push(to_date);
  }

  const sql = `
    SELECT
      w.name AS warehouse_name,
      ce.entry_type,
      SUM(ce.amount) AS total_amount,
      COUNT(*) AS entry_count
    FROM cash_entries ce
    LEFT JOIN warehouses w ON w.id = ce.warehouse_id
    WHERE ${where.join(" AND ")}
    GROUP BY ce.warehouse_id, ce.entry_type
    ORDER BY w.name ASC, ce.entry_type ASC
  `;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// Get total cash balance (income - expense)
router.get("/summary/total-balance", (req, res) => {
  const { from_date, to_date } = req.query;

  let where = ["1=1"];
  const params = [];

  if (from_date) {
    where.push("ce.entry_date >= ?");
    params.push(from_date);
  }
  if (to_date) {
    where.push("ce.entry_date <= ?");
    params.push(to_date);
  }

  const sql = `
    SELECT
      SUM(CASE WHEN ce.entry_type = 'income' THEN ce.amount ELSE 0 END) AS total_income,
      SUM(CASE WHEN ce.entry_type = 'expense' THEN ce.amount ELSE 0 END) AS total_expense,
      SUM(CASE WHEN ce.entry_type = 'income' THEN ce.amount ELSE -ce.amount END) AS net_balance
    FROM cash_entries ce
    WHERE ${where.join(" AND ")}
  `;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows[0] || { total_income: 0, total_expense: 0, net_balance: 0 });
  });
});

module.exports = router;
