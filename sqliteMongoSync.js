const {
  SqliteMirrorRow,
  isMongoMirrorReady,
  mongoMirrorConfigured,
  mongoose,
} = require("./db-mongodb");

const TRACKED_TABLES = new Set([
  "locations",
  "employees",
  "roles",
  "companies",
  "company_accounts",
  "warehouses",
  "products",
  "buyer_names",
  "consignee_names",
  "inward",
  "outward",
  "adjustment",
  "outward_settlement",
  "transporters",
  "transport_bilti",
  "expenses",
  "expense_items",
  "cash_entries",
  "cash_entry_adjustments",
]);

const TABLE_NAME_REGEX = /^[a-z_][a-z0-9_]*$/i;
const fullSyncInProgress = new Set();
const fullSyncPending = new Set();
const pendingTasks = [];
const mongoRestoreEnabled = String(process.env.MONGODB_RESTORE_SQLITE_ON_START || "true").toLowerCase() !== "false";
let waitingForMongoConnection = false;
let initialBackfillDone = false;
let restoreInProgress = false;

function logMirror(message, error) {
  if (error) {
    console.error(`[MongoMirror] ${message}:`, error.message || error);
    return;
  }
  console.log(`[MongoMirror] ${message}`);
}

function countPlaceholders(sqlFragment) {
  return (sqlFragment.match(/\?/g) || []).length;
}

function normalizeMutationSql(sql) {
  return String(sql || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMutation(sql) {
  const normalized = normalizeMutationSql(sql);

  const insertMatch = normalized.match(/^INSERT\s+INTO\s+([a-z_][a-z0-9_]*)\b/i);
  if (insertMatch) {
    return { operation: "insert", table: insertMatch[1].toLowerCase(), normalized };
  }

  const updateMatch = normalized.match(/^UPDATE\s+([a-z_][a-z0-9_]*)\s+SET\b/i);
  if (updateMatch) {
    return { operation: "update", table: updateMatch[1].toLowerCase(), normalized };
  }

  const deleteMatch = normalized.match(/^DELETE\s+FROM\s+([a-z_][a-z0-9_]*)\b/i);
  if (deleteMatch) {
    return { operation: "delete", table: deleteMatch[1].toLowerCase(), normalized };
  }

  return null;
}

function normalizeRunArgs(args) {
  const mutableArgs = Array.isArray(args) ? [...args] : [];
  let callback = null;

  if (mutableArgs.length > 0 && typeof mutableArgs[mutableArgs.length - 1] === "function") {
    callback = mutableArgs.pop();
  }

  let params = [];
  if (mutableArgs.length === 1 && (Array.isArray(mutableArgs[0]) || typeof mutableArgs[0] === "object")) {
    params = mutableArgs[0];
  } else if (mutableArgs.length > 0) {
    params = mutableArgs;
  }

  return { argsWithoutCallback: mutableArgs, callback, params };
}

function sanitizeTableName(table) {
  if (!TABLE_NAME_REGEX.test(table)) return null;
  return table.toLowerCase();
}

function dbAllAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows || []);
    });
  });
}

function dbRunAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }
      resolve({
        lastID: Number(this?.lastID),
        changes: Number(this?.changes || 0),
      });
    });
  });
}

function parseIdValues(sql, params) {
  if (!Array.isArray(params)) return [];

  const ids = [];
  const seen = new Set();
  const normalized = normalizeMutationSql(sql);

  const whereIdEqualsRegex = /\bWHERE\s+id\s*=\s*\?/gi;
  let equalsMatch = whereIdEqualsRegex.exec(normalized);
  while (equalsMatch) {
    const placeholderIndex = countPlaceholders(normalized.slice(0, equalsMatch.index + equalsMatch[0].length - 1));
    const rawValue = params[placeholderIndex];
    const numericValue = Number(rawValue);
    if (Number.isFinite(numericValue) && !seen.has(numericValue)) {
      seen.add(numericValue);
      ids.push(numericValue);
    }
    equalsMatch = whereIdEqualsRegex.exec(normalized);
  }

  const inMatch = normalized.match(/\bWHERE\s+id\s+IN\s*\(([^)]+)\)/i);
  if (inMatch) {
    const group = inMatch[1];
    const groupPlaceholders = countPlaceholders(group);
    if (groupPlaceholders > 0) {
      const groupStartIndex = normalized.indexOf(group);
      const beforeCount = countPlaceholders(normalized.slice(0, groupStartIndex));
      for (let i = 0; i < groupPlaceholders; i += 1) {
        const rawValue = params[beforeCount + i];
        const numericValue = Number(rawValue);
        if (Number.isFinite(numericValue) && !seen.has(numericValue)) {
          seen.add(numericValue);
          ids.push(numericValue);
        }
      }
    }
  }

  return ids;
}

function enqueueMirrorTask(task) {
  if (!mongoMirrorConfigured) return;

  if (isMongoMirrorReady()) {
    task().catch((error) => logMirror("Task failed", error));
    return;
  }

  if (pendingTasks.length >= 2000) {
    pendingTasks.shift();
    logMirror("Pending queue full; dropped oldest mirror task");
  }
  pendingTasks.push(task);

  if (!waitingForMongoConnection) {
    waitingForMongoConnection = true;
    mongoose.connection.once("connected", () => {
      waitingForMongoConnection = false;
      logMirror("MongoDB connected; flushing pending mirror tasks");

      const queuedTasks = pendingTasks.splice(0, pendingTasks.length);
      queuedTasks.forEach((queuedTask) => {
        queuedTask().catch((error) => logMirror("Queued task failed", error));
      });
    });
  }
}

function upsertMirrorRow(table, rowId, rowData) {
  return SqliteMirrorRow.updateOne(
    { table, row_id: Number(rowId) },
    {
      $set: {
        data: rowData,
        updated_at: new Date(),
      },
    },
    { upsert: true }
  ).exec();
}

function deleteMirrorRows(table, rowIds) {
  const numericIds = (rowIds || [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  if (numericIds.length === 0) return Promise.resolve();

  return SqliteMirrorRow.deleteMany({ table, row_id: { $in: numericIds } }).exec();
}

function syncRowById(db, table, rowId) {
  const safeTable = sanitizeTableName(table);
  const numericRowId = Number(rowId);
  if (!safeTable || !Number.isFinite(numericRowId)) return;

  db.get(`SELECT * FROM ${safeTable} WHERE id = ?`, [numericRowId], async (queryError, row) => {
    if (queryError) {
      logMirror(`Failed to load row ${safeTable}#${numericRowId}`, queryError);
      return;
    }

    try {
      if (!row) {
        await deleteMirrorRows(safeTable, [numericRowId]);
      } else {
        await upsertMirrorRow(safeTable, numericRowId, row);
      }
    } catch (mirrorError) {
      logMirror(`Failed to sync row ${safeTable}#${numericRowId}`, mirrorError);
    }
  });
}

async function updateSqliteSequence(db, table) {
  const safeTable = sanitizeTableName(table);
  if (!safeTable) return;

  try {
    const maxRows = await dbAllAsync(db, `SELECT MAX(id) AS max_id FROM ${safeTable}`);
    const maxId = Number(maxRows?.[0]?.max_id || 0);
    if (!Number.isFinite(maxId) || maxId <= 0) return;

    const updateResult = await dbRunAsync(
      db,
      `UPDATE sqlite_sequence SET seq = ? WHERE name = ?`,
      [maxId, safeTable]
    );

    if (!updateResult?.changes) {
      await dbRunAsync(
        db,
        `INSERT OR IGNORE INTO sqlite_sequence(name, seq) VALUES(?, ?)`,
        [safeTable, maxId]
      );
    }
  } catch (error) {
    logMirror(`Failed to update sqlite sequence for ${safeTable}`, error);
  }
}

async function restoreTableFromMongo(db, table) {
  const safeTable = sanitizeTableName(table);
  if (!safeTable || !TRACKED_TABLES.has(safeTable)) return 0;

  const localCountRows = await dbAllAsync(db, `SELECT COUNT(*) AS total FROM ${safeTable}`);
  const localCount = Number(localCountRows?.[0]?.total || 0);

  if (localCount > 0) {
    if (!(safeTable === "employees" && localCount === 1)) {
      return 0;
    }

    const localEmployeeRows = await dbAllAsync(db, `SELECT username FROM employees LIMIT 1`);
    const onlyUsername = String(localEmployeeRows?.[0]?.username || "").toLowerCase();
    if (onlyUsername !== "admin") {
      return 0;
    }
  }

  const mirrorRows = await SqliteMirrorRow.find({ table: safeTable })
    .sort({ row_id: 1 })
    .lean()
    .exec();

  if (!Array.isArray(mirrorRows) || mirrorRows.length === 0) return 0;

  const tableInfo = await dbAllAsync(db, `PRAGMA table_info(${safeTable})`);
  const allowedColumns = new Set((tableInfo || []).map((column) => String(column?.name || "")));
  if (!allowedColumns.has("id")) return 0;

  let inserted = 0;

  for (const mirrorRow of mirrorRows) {
    const rowId = Number(mirrorRow?.row_id);
    if (!Number.isFinite(rowId)) continue;

    const snapshot = mirrorRow?.data && typeof mirrorRow.data === "object" ? mirrorRow.data : {};
    const baseRow = { ...snapshot, id: rowId };

    const columns = Object.keys(baseRow).filter((column) => allowedColumns.has(column));
    if (!columns.includes("id")) {
      columns.unshift("id");
    }

    if (columns.length === 0) continue;

    const placeholders = columns.map(() => "?").join(", ");
    const values = columns.map((column) => baseRow[column]);

    try {
      const result = await dbRunAsync(
        db,
        `INSERT OR IGNORE INTO ${safeTable} (${columns.join(", ")}) VALUES (${placeholders})`,
        values
      );
      inserted += Number(result?.changes || 0);
    } catch (error) {
      logMirror(`Failed to restore row ${safeTable}#${rowId}`, error);
    }
  }

  await updateSqliteSequence(db, safeTable);
  return inserted;
}

async function restoreMissingRowsFromMongo(db) {
  if (!mongoRestoreEnabled) return;

  restoreInProgress = true;
  try {
    logMirror("Starting MongoDB -> SQLite restore for empty tables");

    for (const table of TRACKED_TABLES) {
      const inserted = await restoreTableFromMongo(db, table);
      if (inserted > 0) {
        logMirror(`Restored ${inserted} rows into ${table}`);
      }
    }
  } finally {
    restoreInProgress = false;
  }
}

function runFullTableSync(db, table) {
  const safeTable = sanitizeTableName(table);
  if (!safeTable || !TRACKED_TABLES.has(safeTable)) return;

  if (fullSyncInProgress.has(safeTable)) {
    fullSyncPending.add(safeTable);
    return;
  }

  fullSyncInProgress.add(safeTable);

  db.all(`SELECT * FROM ${safeTable}`, async (queryError, rows) => {
    try {
      if (queryError) {
        logMirror(`Failed to load full table ${safeTable}`, queryError);
        return;
      }

      const safeRows = Array.isArray(rows) ? rows : [];
      const now = new Date();

      const bulkOps = safeRows
        .map((row) => ({ row, rowId: Number(row?.id) }))
        .filter((entry) => Number.isFinite(entry.rowId))
        .map((entry) => ({
          updateOne: {
            filter: { table: safeTable, row_id: entry.rowId },
            update: {
              $set: {
                data: entry.row,
                updated_at: now,
              },
            },
            upsert: true,
          },
        }));

      if (bulkOps.length > 0) {
        await SqliteMirrorRow.bulkWrite(bulkOps, { ordered: false });
      }

      const keepIds = bulkOps.map((operation) => operation.updateOne.filter.row_id);
      if (keepIds.length > 0) {
        await SqliteMirrorRow.deleteMany({ table: safeTable, row_id: { $nin: keepIds } }).exec();
      } else {
        await SqliteMirrorRow.deleteMany({ table: safeTable }).exec();
      }
    } catch (mirrorError) {
      logMirror(`Failed to mirror full table ${safeTable}`, mirrorError);
    } finally {
      fullSyncInProgress.delete(safeTable);
      if (fullSyncPending.has(safeTable)) {
        fullSyncPending.delete(safeTable);
        runFullTableSync(db, safeTable);
      }
    }
  });
}

function scheduleMutationSync(db, mutation, sql, params, statementContext) {
  if (!mongoMirrorConfigured) return;

  const safeTable = sanitizeTableName(mutation.table);
  if (!safeTable || !TRACKED_TABLES.has(safeTable)) return;

  if (mutation.operation === "insert") {
    const insertedId = Number(statementContext?.lastID);
    if (Number.isFinite(insertedId) && insertedId > 0) {
      enqueueMirrorTask(async () => syncRowById(db, safeTable, insertedId));
      return;
    }

    enqueueMirrorTask(async () => runFullTableSync(db, safeTable));
    return;
  }

  const ids = parseIdValues(sql, params);
  if (ids.length > 0) {
    if (mutation.operation === "delete") {
      enqueueMirrorTask(async () => deleteMirrorRows(safeTable, ids));
    } else {
      enqueueMirrorTask(async () => {
        ids.forEach((id) => syncRowById(db, safeTable, id));
      });
    }
    return;
  }

  enqueueMirrorTask(async () => runFullTableSync(db, safeTable));
}

function patchRunMethod(db) {
  const originalRun = db.run.bind(db);

  db.run = function patchedRun(sql, ...args) {
    const mutation = parseMutation(sql);
    if (!mutation) {
      return originalRun(sql, ...args);
    }

    const { argsWithoutCallback, callback, params } = normalizeRunArgs(args);
    const wrappedCallback = function wrappedRunCallback(error) {
      if (!error && !restoreInProgress) {
        scheduleMutationSync(db, mutation, sql, params, this);
      }
      if (typeof callback === "function") {
        callback.apply(this, arguments);
      }
    };

    return originalRun(sql, ...argsWithoutCallback, wrappedCallback);
  };
}

function runInitialBackfill(db) {
  if (!mongoMirrorConfigured || initialBackfillDone) return;
  initialBackfillDone = true;

  const syncAllTables = async () => {
    if (mongoRestoreEnabled) {
      await restoreMissingRowsFromMongo(db);
    }

    logMirror("Starting initial SQLite to MongoDB backfill");
    TRACKED_TABLES.forEach((table) => runFullTableSync(db, table));
  };

  if (isMongoMirrorReady()) {
    syncAllTables().catch((error) => logMirror("Initial backfill failed", error));
    return;
  }

  mongoose.connection.once("connected", () => {
    syncAllTables().catch((error) => logMirror("Initial backfill failed", error));
  });
}

function installSqliteMongoMirror(db) {
  if (!db || typeof db.run !== "function") {
    throw new Error("installSqliteMongoMirror requires a valid sqlite3 database instance");
  }

  if (!mongoMirrorConfigured) {
    logMirror("Mongo mirror is inactive (check MONGODB_URI / MONGODB_MIRROR_ENABLED)");
    return;
  }

  patchRunMethod(db);
  runInitialBackfill(db);
  logMirror("SQLite mutation hook installed");
}

module.exports = {
  installSqliteMongoMirror,
};
