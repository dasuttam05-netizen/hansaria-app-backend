const path = require("path");
const { installSqliteMongoMirror } = require("./sqliteMongoSync");

// Only load sqlite3 in development - not needed in production on Render
let sqlite3;
let db = null;

if (true) {
  sqlite3 = require("sqlite3").verbose();
  const dbPath = path.join(__dirname, "database.sqlite");

  db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("DB Connection Error:", err.message);
    else console.log("Connected to SQLite database");
  });

  db.configure("busyTimeout", 5000);

  db.serialize(() => {
    db.run("PRAGMA journal_mode = WAL;");

  db.run(`
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT,
      hsn_code TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT,
      location_id INTEGER,
      username TEXT UNIQUE,
      password TEXT,
      role TEXT DEFAULT 'staff',
      permissions TEXT DEFAULT '[]',
      FOREIGN KEY(location_id) REFERENCES locations(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      permissions TEXT DEFAULT '[]',
      is_admin INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT,
      mobile TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS company_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_name TEXT NOT NULL,
      address TEXT,
      company_id INTEGER NOT NULL,
      pan_no TEXT,
      mobile TEXT,
      FOREIGN KEY(company_id) REFERENCES companies(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT,
      location_id INTEGER,
      employee_id INTEGER,
      FOREIGN KEY(location_id) REFERENCES locations(id),
      FOREIGN KEY(employee_id) REFERENCES employees(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      hsn_code TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS buyer_names (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      mobile TEXT,
      email TEXT,
      address TEXT,
      gst_no TEXT,
      pan_no TEXT,
      state TEXT,
      location TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS consignee_names (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      buyer_id INTEGER,
      name TEXT NOT NULL UNIQUE,
      mobile TEXT,
      email TEXT,
      address TEXT,
      gst_no TEXT,
      pan_no TEXT,
      state TEXT,
      location TEXT,
      FOREIGN KEY(buyer_id) REFERENCES buyer_names(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS inward (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sl_no INTEGER NOT NULL,
      voucher_no TEXT UNIQUE,
      date TEXT NOT NULL,
      employee_id INTEGER,
      location_id INTEGER,
      warehouse_id INTEGER,
      product_id INTEGER,
      company_id INTEGER,
      company_account_id INTEGER,
      lorry_no TEXT,
      weight REAL DEFAULT 0,
      remaining_qty REAL DEFAULT 0,
      labour_charges REAL DEFAULT 0,
      rent REAL DEFAULT 0,
      shortage REAL DEFAULT 0,
      narration TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(employee_id) REFERENCES employees(id),
      FOREIGN KEY(location_id) REFERENCES locations(id),
      FOREIGN KEY(warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY(product_id) REFERENCES products(id),
      FOREIGN KEY(company_id) REFERENCES companies(id),
      FOREIGN KEY(company_account_id) REFERENCES company_accounts(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS outward (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sl_no INTEGER NOT NULL,
      voucher_no TEXT UNIQUE,
      date TEXT NOT NULL,
      employee_id INTEGER,
      location_id INTEGER,
      warehouse_id INTEGER,
      product_id INTEGER,
      company_id INTEGER,
      company_account_id INTEGER,
      lorry_no TEXT,
      weight REAL DEFAULT 0,
      quantity REAL DEFAULT 0,
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      buyer_name TEXT,
      consignee_name TEXT,
      inv_no TEXT,
      narration TEXT,
      labour_charges REAL DEFAULT 0,
      total_freight REAL DEFAULT 0,
      rent REAL DEFAULT 0,
      shortage REAL DEFAULT 0,
      status TEXT DEFAULT 'Pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(employee_id) REFERENCES employees(id),
      FOREIGN KEY(location_id) REFERENCES locations(id),
      FOREIGN KEY(warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY(product_id) REFERENCES products(id),
      FOREIGN KEY(company_id) REFERENCES companies(id),
      FOREIGN KEY(company_account_id) REFERENCES company_accounts(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS adjustment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outward_id INTEGER,
      inward_id INTEGER,
      qty REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(outward_id) REFERENCES outward(id),
      FOREIGN KEY(inward_id) REFERENCES inward(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS outward_settlement (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outward_id INTEGER UNIQUE,
      dispatch_qty REAL DEFAULT 0,
      unloading_qty REAL DEFAULT 0,
      billable_qty REAL DEFAULT 0,
      sale_rate REAL DEFAULT 0,
      company_rate REAL DEFAULT 0,
      sale_amount REAL DEFAULT 0,
      company_amount REAL DEFAULT 0,
      gross_amount REAL DEFAULT 0,
      receivable_amount REAL DEFAULT 0,
      freight REAL DEFAULT 0,
      outward_labour_charges REAL DEFAULT 0,
      other_charges REAL DEFAULT 0,
      charge_bearer TEXT DEFAULT 'self',
      gross_profit REAL DEFAULT 0,
      net_profit REAL DEFAULT 0,
      company_payable REAL DEFAULT 0,
      narration TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(outward_id) REFERENCES outward(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS transporters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT,
      pan_no TEXT,
      gst_no TEXT,
      aadhar_no TEXT,
      mobile TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
  CREATE TABLE IF NOT EXISTS transport_bilti (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    outward_id INTEGER,
    bilti_no TEXT UNIQUE,
    transporter_id INTEGER,
    voucher_no TEXT,
    outward_date TEXT,
    dispatch_date TEXT,
    destination TEXT,
    days INTEGER DEFAULT 0,
    company_name TEXT,
    account_name TEXT,
    warehouse_name TEXT,
    product_name TEXT,
    lorry_no TEXT,
    buyer_name TEXT,
    consignee_name TEXT,
    outward_qty REAL DEFAULT 0,
    dispatch_qty REAL DEFAULT 0,
    shortage_qty REAL DEFAULT 0,
    outward_rate REAL DEFAULT 0,
    shortage_amount REAL DEFAULT 0,
    transport_rate REAL DEFAULT 0,
    gross_freight REAL DEFAULT 0,
    detain_amount REAL DEFAULT 0,
    others_exp REAL DEFAULT 0,
    advance_amount REAL DEFAULT 0,
    tds_percent REAL DEFAULT 0,
    tds_amount REAL DEFAULT 0,
    net_amount REAL DEFAULT 0,
    payable_amount REAL DEFAULT 0,
    narration TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(outward_id) REFERENCES outward(id),
    FOREIGN KEY(transporter_id) REFERENCES transporters(id)
  )
`);

  db.run(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_no TEXT UNIQUE,
      expense_date TEXT NOT NULL,
      warehouse_id INTEGER,
      employee_id INTEGER,
      product_id INTEGER,
      company_id INTEGER,
      company_account_id INTEGER,
      reg_from_company_id INTEGER,
      send_to_company_id INTEGER,
      reg_from_consignee_id INTEGER,
      send_to_party_id INTEGER,
      send_to_kind TEXT,
      send_to_ref_id INTEGER,
      work_description TEXT,
      reg_lorry_no TEXT,
      loading REAL DEFAULT 0,
      unloading REAL DEFAULT 0,
      balance REAL DEFAULT 0,
      net_weight REAL DEFAULT 0,
      new_lorry_no TEXT,
      new_weight REAL DEFAULT 0,
      challan_weight REAL DEFAULT 0,
      mb_no TEXT,
      paid_by TEXT,
      paid_by_mobile TEXT,
      status TEXT DEFAULT 'PENDING',
      receive_cash_from_party REAL DEFAULT 0,
      receive_cash_from_driver REAL DEFAULT 0,
      grand_total REAL DEFAULT 0,
      total_expense_amount REAL DEFAULT 0,
      narration TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY(employee_id) REFERENCES employees(id),
      FOREIGN KEY(product_id) REFERENCES products(id),
      FOREIGN KEY(company_id) REFERENCES companies(id),
      FOREIGN KEY(company_account_id) REFERENCES company_accounts(id),
      FOREIGN KEY(reg_from_company_id) REFERENCES companies(id),
      FOREIGN KEY(send_to_company_id) REFERENCES companies(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS expense_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_id INTEGER NOT NULL,
      line_no INTEGER NOT NULL,
      particular_name TEXT NOT NULL,
      bags REAL DEFAULT 0,
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      FOREIGN KEY(expense_id) REFERENCES expenses(id) ON DELETE CASCADE
    )
  `);

  db.run(
    `ALTER TABLE expenses ADD COLUMN narration TEXT`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("expenses narration add error:", err.message);
      }
    }
  );
  db.run(`ALTER TABLE expenses ADD COLUMN reg_from_company_id INTEGER`, () => {});
  db.run(`ALTER TABLE expenses ADD COLUMN send_to_company_id INTEGER`, () => {});
  db.run(`ALTER TABLE expenses ADD COLUMN reg_lorry_no TEXT`, () => {});
  db.run(`ALTER TABLE expenses ADD COLUMN loading REAL DEFAULT 0`, () => {});
  db.run(`ALTER TABLE expenses ADD COLUMN unloading REAL DEFAULT 0`, () => {});
  db.run(`ALTER TABLE expenses ADD COLUMN balance REAL DEFAULT 0`, () => {});
  db.run(`ALTER TABLE expenses ADD COLUMN net_weight REAL DEFAULT 0`, () => {});
  db.run(`ALTER TABLE expenses ADD COLUMN new_lorry_no TEXT`, () => {});
  db.run(`ALTER TABLE expenses ADD COLUMN new_weight REAL DEFAULT 0`, () => {});
  db.run(`ALTER TABLE expenses ADD COLUMN challan_weight REAL DEFAULT 0`, () => {});
  db.run(`ALTER TABLE expenses ADD COLUMN mb_no TEXT`, () => {});
  db.run(
    `ALTER TABLE expenses ADD COLUMN reg_from_consignee_id INTEGER`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("expenses reg_from_consignee_id add error:", err.message);
      }
    }
  );
  db.run(
    `ALTER TABLE expenses ADD COLUMN send_to_party_id INTEGER`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("expenses send_to_party_id add error:", err.message);
      }
    }
  );
  db.run(
    `ALTER TABLE expenses ADD COLUMN send_to_kind TEXT`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("expenses send_to_kind add error:", err.message);
      }
    }
  );
  db.run(
    `ALTER TABLE expenses ADD COLUMN send_to_ref_id INTEGER`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("expenses send_to_ref_id add error:", err.message);
      }
    }
  );

  const addColIgnoreDup = (sql, label) => {
    db.run(sql, (err) => {
      if (err && !String(err.message).includes("duplicate column")) {
        console.log(`${label} add error:`, err.message);
      }
    });
  };
  addColIgnoreDup(`ALTER TABLE buyer_names ADD COLUMN mobile TEXT`, "buyer_names mobile");
  addColIgnoreDup(`ALTER TABLE buyer_names ADD COLUMN email TEXT`, "buyer_names email");
  addColIgnoreDup(`ALTER TABLE buyer_names ADD COLUMN address TEXT`, "buyer_names address");
  addColIgnoreDup(`ALTER TABLE buyer_names ADD COLUMN gst_no TEXT`, "buyer_names gst_no");
  addColIgnoreDup(`ALTER TABLE buyer_names ADD COLUMN pan_no TEXT`, "buyer_names pan_no");
  addColIgnoreDup(`ALTER TABLE buyer_names ADD COLUMN state TEXT`, "buyer_names state");
  addColIgnoreDup(`ALTER TABLE buyer_names ADD COLUMN location TEXT`, "buyer_names location");
  addColIgnoreDup(`ALTER TABLE consignee_names ADD COLUMN buyer_id INTEGER`, "consignee_names buyer_id");
  addColIgnoreDup(`ALTER TABLE consignee_names ADD COLUMN mobile TEXT`, "consignee_names mobile");
  addColIgnoreDup(`ALTER TABLE consignee_names ADD COLUMN email TEXT`, "consignee_names email");
  addColIgnoreDup(`ALTER TABLE consignee_names ADD COLUMN address TEXT`, "consignee_names address");
  addColIgnoreDup(`ALTER TABLE consignee_names ADD COLUMN gst_no TEXT`, "consignee_names gst_no");
  addColIgnoreDup(`ALTER TABLE consignee_names ADD COLUMN pan_no TEXT`, "consignee_names pan_no");
  addColIgnoreDup(`ALTER TABLE consignee_names ADD COLUMN state TEXT`, "consignee_names state");
  addColIgnoreDup(`ALTER TABLE consignee_names ADD COLUMN location TEXT`, "consignee_names location");
  addColIgnoreDup(`ALTER TABLE transporters ADD COLUMN gst_no TEXT`, "transporters gst_no");
  addColIgnoreDup(`ALTER TABLE transporters ADD COLUMN aadhar_no TEXT`, "transporters aadhar_no");
  addColIgnoreDup(`ALTER TABLE outward ADD COLUMN inv_no TEXT`, "outward inv_no");

  db.run(
    `ALTER TABLE employees ADD COLUMN role TEXT DEFAULT 'staff'`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("employees role add error:", err.message);
      }
    }
  );

  db.run(
    `ALTER TABLE employees ADD COLUMN permissions TEXT DEFAULT '[]'`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("employees permissions add error:", err.message);
      }
    }
  );

  db.run(
    `ALTER TABLE employees ADD COLUMN opening_balance REAL DEFAULT 0`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("employees opening_balance add error:", err.message);
      }
    }
  );

  db.run(
    `ALTER TABLE companies ADD COLUMN opening_balance REAL DEFAULT 0`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("companies opening_balance add error:", err.message);
      }
    }
  );
  db.run(
    `ALTER TABLE employees ADD COLUMN opening_balance_type TEXT DEFAULT 'dr'`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("employees opening_balance_type add error:", err.message);
      }
    }
  );
  db.run(
    `ALTER TABLE companies ADD COLUMN opening_balance_type TEXT DEFAULT 'dr'`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("companies opening_balance_type add error:", err.message);
      }
    }
  );

  db.run(
    `
    UPDATE employees
    SET role = CASE
      WHEN LOWER(TRIM(username)) = 'admin' THEN 'admin'
      WHEN role IS NULL OR TRIM(role) = '' THEN 'staff'
      WHEN LOWER(TRIM(role)) IN ('admin', 'manager', 'staff', 'viewer') THEN LOWER(TRIM(role))
      ELSE 'staff'
    END
    `,
    (err) => {
      if (err) {
        console.log("employees role sync error:", err.message);
      }
    }
  );

  db.run(
    `
    UPDATE employees
    SET permissions = CASE
      WHEN role = 'admin' OR LOWER(TRIM(username)) = 'admin' THEN '["all"]'
      WHEN permissions IS NULL OR TRIM(permissions) = '' THEN '[]'
      ELSE permissions
    END
    `,
    (err) => {
      if (err) {
        console.log("employees permissions sync error:", err.message);
      }
    }
  );

  db.run(
    `ALTER TABLE outward_settlement ADD COLUMN gross_amount REAL DEFAULT 0`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("outward_settlement gross_amount add error:", err.message);
      }
    }
  );

  db.run(
    `ALTER TABLE outward_settlement ADD COLUMN receivable_amount REAL DEFAULT 0`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("outward_settlement receivable_amount add error:", err.message);
      }
    }
  );

  db.run(
    `ALTER TABLE inward ADD COLUMN narration TEXT`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("inward narration add error:", err.message);
      }
    }
  );

  db.run(
    `ALTER TABLE outward ADD COLUMN narration TEXT`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("outward narration add error:", err.message);
      }
    }
  );

  db.run(
    `ALTER TABLE inward ADD COLUMN remaining_qty REAL DEFAULT 0`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("remaining_qty add error:", err.message);
      }
    }
  );

  db.run(
    `ALTER TABLE transport_bilti ADD COLUMN transporter_id INTEGER`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("transport_bilti transporter_id add error:", err.message);
      }
    }
  );

  db.run(
    `ALTER TABLE transport_bilti ADD COLUMN voucher_no TEXT`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("transport_bilti voucher_no add error:", err.message);
      }
    }
  );

  db.run(
    `ALTER TABLE transport_bilti ADD COLUMN outward_date TEXT`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("transport_bilti outward_date add error:", err.message);
      }
    }
  );

  db.run(
    `ALTER TABLE transport_bilti ADD COLUMN company_name TEXT`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("transport_bilti company_name add error:", err.message);
      }
    }
  );

  db.run(
    `ALTER TABLE transport_bilti ADD COLUMN account_name TEXT`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("transport_bilti account_name add error:", err.message);
      }
    }
  );

  db.run(
    `ALTER TABLE transport_bilti ADD COLUMN warehouse_name TEXT`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("transport_bilti warehouse_name add error:", err.message);
      }
    }
  );

  db.run(
    `ALTER TABLE transport_bilti ADD COLUMN product_name TEXT`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("transport_bilti product_name add error:", err.message);
      }
    }
  );

  db.run(
    `ALTER TABLE transport_bilti ADD COLUMN lorry_no TEXT`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("transport_bilti lorry_no add error:", err.message);
      }
    }
  );

  db.run(
    `ALTER TABLE transport_bilti ADD COLUMN buyer_name TEXT`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("transport_bilti buyer_name add error:", err.message);
      }
    }
  );

  db.run(
    `ALTER TABLE transport_bilti ADD COLUMN consignee_name TEXT`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("transport_bilti consignee_name add error:", err.message);
      }
    }
  );

  db.run(
    `ALTER TABLE transport_bilti ADD COLUMN shortage_free_kg REAL DEFAULT 100`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.log("transport_bilti shortage_free_kg add error:", err.message);
      }
    }
  );

  db.run(
    `
    UPDATE inward
    SET remaining_qty = weight
    WHERE remaining_qty IS NULL OR remaining_qty = 0
    `,
    (err) => {
      if (err) {
        console.log("remaining_qty sync error:", err.message);
      } else {
        console.log("remaining_qty synced with weight");
      }
    }
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS cash_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_no TEXT UNIQUE,
      entry_date TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      warehouse_id INTEGER,
      company_id INTEGER,
      company_account_id INTEGER,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT DEFAULT 'Cash',
      reference_no TEXT,
      narration TEXT,
      created_by INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY(company_id) REFERENCES companies(id),
      FOREIGN KEY(company_account_id) REFERENCES company_accounts(id),
      FOREIGN KEY(created_by) REFERENCES employees(id)
    )
  `);

  const addCashCol = (sql, label) => {
    db.run(sql, (err) => {
      if (err && !String(err.message).includes("duplicate column")) {
        console.log(`${label} add error:`, err.message);
      }
    });
  };
  addCashCol(`ALTER TABLE cash_entries ADD COLUMN payment_method TEXT DEFAULT 'Cash'`, "cash_entries payment_method");
  addCashCol(`ALTER TABLE cash_entries ADD COLUMN reference_no TEXT`, "cash_entries reference_no");
  addCashCol(`ALTER TABLE cash_entries ADD COLUMN created_by INTEGER`, "cash_entries created_by");
  addCashCol(`ALTER TABLE cash_entries ADD COLUMN employee_id INTEGER`, "cash_entries employee_id");
  addCashCol(`ALTER TABLE cash_entries ADD COLUMN status TEXT DEFAULT 'pending'`, "cash_entries status");
  addCashCol(`ALTER TABLE cash_entries ADD COLUMN source_expense_id INTEGER`, "cash_entries source_expense_id");
  addCashCol(`ALTER TABLE cash_entries ADD COLUMN linked_entry_id INTEGER`, "cash_entries linked_entry_id");
  addCashCol(`ALTER TABLE cash_entries ADD COLUMN fund_source TEXT DEFAULT 'main_cash'`, "cash_entries fund_source");

  db.run(`
    CREATE TABLE IF NOT EXISTS cash_entry_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_entry_id INTEGER NOT NULL,
      target_entry_id INTEGER NOT NULL,
      adjusted_amount REAL NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(source_entry_id) REFERENCES cash_entries(id) ON DELETE CASCADE,
      FOREIGN KEY(target_entry_id) REFERENCES cash_entries(id) ON DELETE CASCADE
    )
  `);

  // Reset cash entries on startup only when explicitly requested.
  if (process.env.RESET_CASH_ENTRIES_ON_START === "true") {
    db.run(`DELETE FROM cash_entry_adjustments`, (adjErr) => {
      if (adjErr) {
        console.log("cash_entry_adjustments reset error:", adjErr.message);
      }
    });
    db.run(`DELETE FROM cash_entries`, (entryErr) => {
      if (entryErr) {
        console.log("cash_entries reset error:", entryErr.message);
      }
    });
    db.run(
      `DELETE FROM sqlite_sequence WHERE name IN ('cash_entries','cash_entry_adjustments')`,
      (seqErr) => {
        if (seqErr) {
          console.log("cash_entries sequence reset error:", seqErr.message);
        } else {
          console.log("Cash entries reset: voucher will restart from 00001");
        }
      }
    );
  } else if (process.env.NODE_ENV !== "production") {
    console.log("Skipping cash entries reset on startup. Set RESET_CASH_ENTRIES_ON_START=true to enable.");
  }
  });
} else {
  console.log("Running in production mode - SQLite disabled, using MongoDB only");
}

if (db) {
  installSqliteMongoMirror(db);
}

module.exports = db;
