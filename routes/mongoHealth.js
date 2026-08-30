const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const db = mongoose.connection.db;
    if (!db) return res.status(503).json({ ok: false, error: "MongoDB not connected" });

    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    const names = collections.map(c => c.name).sort();
    const counts = {};
    for (const name of names) {
      try {
        counts[name] = await db.collection(name).countDocuments();
      } catch (countErr) {
        counts[name] = { error: countErr.message };
      }
    }

    res.json({
      ok: true,
      database: db.databaseName,
      collections: names,
      counts,
      destructiveMigration: false,
    });
  } catch (err) {
    console.error("Mongo health error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
