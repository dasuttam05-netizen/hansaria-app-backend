const mongoose = require("mongoose");
const dns = require("node:dns");

require("dotenv").config();

mongoose.set("bufferCommands", false);

const rawMongoUri =
  process.env.MONGODB_URI?.trim() || "";
const rawMongoLegacyUri =
  process.env.MONGODB_URI_LEGACY?.trim() || "";

const mongoMirrorEnabled =
  String(
    process.env.MONGODB_MIRROR_ENABLED || "true"
  ).toLowerCase() !== "false";

const configuredDnsServers = String(
  process.env.MONGODB_DNS_SERVERS || ""
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (configuredDnsServers.length) {
  try {
    dns.setServers(configuredDnsServers);
    console.log(
      `Using MongoDB DNS servers: ${configuredDnsServers.join(", ")}`
    );
  } catch (dnsError) {
    console.warn(
      `Could not set MongoDB DNS servers: ${dnsError.message}`
    );
  }
}

function normalizeAtlasUri(uri) {
  if (
    !uri ||
    !uri.startsWith("mongodb+srv://")
  ) {
    return uri;
  }

  return uri.replace(
    /\/([^/?#=]+)=([^/?#]+)$/,
    "/$1?retryWrites=true&w=majority&appName=$2"
  );
}

const mongodbUri =
  normalizeAtlasUri(rawMongoUri);
const fallbackMongoUri =
  rawMongoLegacyUri || "";

const hasMongoUri =
  Boolean(mongodbUri) &&
  !mongodbUri.includes("username:password");
const hasFallbackMongoUri =
  Boolean(fallbackMongoUri) &&
  fallbackMongoUri.startsWith("mongodb://");

const mongoMirrorConfigured =
  mongoMirrorEnabled &&
  hasMongoUri;

function isMongoMirrorReady() {
  return (
    mongoMirrorEnabled &&
    mongoose.connection.readyState === 1
  );
}

const mirrorRowCollectionName = "mirrorrows";
let mirrorRowMigrationPromise = null;

async function migrateMirrorRowCollection() {
  if (!isMongoMirrorReady() || !mongoose.connection?.db) {
    return;
  }

  const db = mongoose.connection.db;
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  const targetExists = collections.some((entry) => entry.name === mirrorRowCollectionName);
  const legacyCollection = collections.find(
    (entry) => entry.name !== mirrorRowCollectionName && /mirrorrows?$/i.test(entry.name)
  );

  if (!legacyCollection) {
    return;
  }

  if (!targetExists) {
    await db.collection(legacyCollection.name).rename(mirrorRowCollectionName, { dropTarget: true });
    return;
  }

  const source = db.collection(legacyCollection.name);
  const target = db.collection(mirrorRowCollectionName);
  const cursor = source.find({});
  const batch = [];

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!doc?.table || doc.row_id === undefined || doc.row_id === null) {
      continue;
    }

    const { _id, ...rest } = doc;
    batch.push({
      updateOne: {
        filter: { table: doc.table, row_id: doc.row_id },
        update: { $set: rest, $setOnInsert: { _id } },
        upsert: true,
      },
    });

    if (batch.length >= 500) {
      await target.bulkWrite(batch, { ordered: false });
      batch.length = 0;
    }
  }

  if (batch.length) {
    await target.bulkWrite(batch, { ordered: false });
  }

  await source.drop();
}

function scheduleMirrorRowMigration() {
  if (mirrorRowMigrationPromise) {
    return mirrorRowMigrationPromise;
  }

  mirrorRowMigrationPromise = migrateMirrorRowCollection().catch((err) => {
    console.warn("Mirror row collection migration skipped:", err.message);
  });

  return mirrorRowMigrationPromise;
}

if (!mongoMirrorEnabled) {
  console.log(
    "MongoDB mirror disabled (MONGODB_MIRROR_ENABLED=false)."
  );
} else if (!hasMongoUri) {
  if (hasFallbackMongoUri) {
    console.log("Using legacy MongoDB URI from MONGODB_URI_LEGACY.");
  } else {
    console.log(
      "MongoDB URI is not configured or contains placeholder credentials. Skipping MongoDB mirror."
    );
  }
} else if (
  mongoose.connection.readyState === 0
) {
  if (mongodbUri !== rawMongoUri) {
    console.log(
      "Normalized MongoDB URI format from legacy value in .env."
    );
  }

  mongoose
    .connect(mongodbUri, {
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 45000,
      maxPoolSize: 20,
      minPoolSize: 5,
      maxIdleTimeMS: 45000,
      retryWrites: true,
      retryReads: true,
    })
    .then(() => {
      console.log(
        "Connected to MongoDB"
      );
      scheduleMirrorRowMigration();
    })
    .catch((err) => {
      if (
        err?.syscall === "querySrv" ||
        (
          err?.code === "ECONNREFUSED" &&
          /_mongodb\._tcp/i.test(
            String(
              err?.hostname ||
                err?.message ||
                ""
            )
          )
        )
      ) {
        console.error(
          "MongoDB SRV DNS lookup failed. Current DNS could not resolve Atlas SRV records."
        );
        console.error(
          "If your network blocks SRV lookups, use the non-SRV Atlas connection string instead."
        );
      }

      if (hasFallbackMongoUri) {
        console.log("Retrying with MONGODB_URI_LEGACY.");
        mongoose.connect(fallbackMongoUri, {
          serverSelectionTimeoutMS: 15000,
          socketTimeoutMS: 45000,
          maxPoolSize: 20,
          minPoolSize: 5,
          maxIdleTimeMS: 45000,
          retryWrites: true,
          retryReads: true,
        }).then(() => {
          console.log("Connected to MongoDB using legacy URI");
          scheduleMirrorRowMigration();
        }).catch((legacyErr) => {
          console.error("MongoDB legacy URI connection error:", legacyErr.message);
        });
      }

      console.error(
        "MongoDB Connection Error:",
        err.message
      );
    });
} else {
  console.log(
    "MongoDB connection already initialized."
  );
}

/*
====================================================
LOCATION
====================================================
*/

const locationSchema =
  new mongoose.Schema({
    name: {
      type: String,
      required: true,
    },

    address: String,

    abbr: String,

    hsn_code: String,

    created_at: {
      type: Date,
      default: Date.now,
    },

    updated_at: {
      type: Date,
      default: Date.now,
    },
  });

/*
====================================================
EMPLOYEE
====================================================
*/

const employeeSchema =
  new mongoose.Schema({
    name: {
      type: String,
      required: true,
    },

    employee_id: {
      type: String,
      unique: true,
      sparse: true,
    },

    address: String,

    mobile: String,

    location_id:
      mongoose.Schema.Types.ObjectId,

    location_ids: [
      {
        type:
          mongoose.Schema.Types.ObjectId,
        ref: "Location",
      },
    ],

    all_location_access: {
      type: Boolean,
      default: false,
    },

    username: {
      type: String,
      unique: true,
      sparse: true,
    },

    password: String,

    role: {
      type: String,
      default: "staff",
    },

    permissions: {
      type: [String],
      default: [],
    },

    opening_balance: {
      type: Number,
      default: 0,
    },

    opening_balance_type: {
      type: String,
      default: "dr",
    },

    assigned_warehouse_ids: [
      {
        type:
          mongoose.Schema.Types.ObjectId,
        ref: "Warehouse",
      },
    ],

    all_warehouse_access: {
      type: Boolean,
      default: false,
    },

    created_at: {
      type: Date,
      default: Date.now,
    },

    updated_at: {
      type: Date,
      default: Date.now,
    },
  });

/*
====================================================
ROLE
====================================================
*/

const roleSchema =
  new mongoose.Schema({
    name: {
      type: String,
      required: true,
      unique: true,
    },

    permissions: {
      type: [String],
      default: [],
    },

    is_admin: {
      type: Number,
      default: 0,
    },

    created_at: {
      type: Date,
      default: Date.now,
    },

    updated_at: {
      type: Date,
      default: Date.now,
    },
  });

/*
====================================================
COMPANY
====================================================
*/

const companySchema =
  new mongoose.Schema({
    name: {
      type: String,
      required: true,
    },

    address: String,

    mobile: String,

    shortage_percent: {
      type: Number,
      default: null,
    },

    opening_balance: {
      type: Number,
      default: 0,
    },

    opening_balance_type: {
      type: String,
      default: "dr",
    },

    created_at: {
      type: Date,
      default: Date.now,
    },

    updated_at: {
      type: Date,
      default: Date.now,
    },
  });

/*
====================================================
COMPANY ACCOUNT
====================================================
*/

const companyAccountSchema =
  new mongoose.Schema({
    account_name: {
      type: String,
      required: true,
    },

    address: String,

    company_id: {
      type:
        mongoose.Schema.Types.ObjectId,
      required: true,
    },

    pan_no: String,

    mobile: String,

    shortage_percent: {
      type: Number,
      default: null,
    },

    created_at: {
      type: Date,
      default: Date.now,
    },

    updated_at: {
      type: Date,
      default: Date.now,
    },
  });

/*
====================================================
WAREHOUSE
====================================================
*/

const warehouseSchema =
  new mongoose.Schema({
    name: {
      type: String,
      required: true,
    },

    address: String,

    pincode: String,

    state: String,

    district: String,

    city: String,

    room_floor_building: String,

    street_locality_landmark: String,

    location_id:
      mongoose.Schema.Types.ObjectId,

    employee_id:
      mongoose.Schema.Types.ObjectId,

    employee_ids: [
      {
        type:
          mongoose.Schema.Types.ObjectId,
        ref: "Employee",
      },
    ],

    company_id:
      mongoose.Schema.Types.ObjectId,

    monthly_rent: {
      type: Number,
      default: 0,
    },

    opening_balance: {
      type: Number,
      default: 0,
    },

    opening_balance_type: {
      type: String,
      default: "dr",
    },

    created_at: {
      type: Date,
      default: Date.now,
    },

    updated_at: {
      type: Date,
      default: Date.now,
    },
  });

/*
====================================================
PRODUCT
====================================================
*/

const productSchema =
  new mongoose.Schema({
    name: {
      type: String,
      required: true,
    },

    hsn_code: String,

    created_at: {
      type: Date,
      default: Date.now,
    },

    updated_at: {
      type: Date,
      default: Date.now,
    },
  });

/*
====================================================
BUYER NAME
====================================================
*/

/*
====================================================
FARMER
====================================================
*/

const farmerSchema =
  new mongoose.Schema(
    {
      legacy_id: {
        type: Number,
        index: true,
        sparse: true,
      },

      name: {
        type: String,
        required: true,
      },

      mobile: String,
      email: String,
      address: String,
      village: String,
      pincode: String,
      state: String,
      district: String,
      city: String,
      room_floor_building: String,
      street_locality_landmark: String,

      opening_balance: {
        type: Number,
        default: 0,
      },

      opening_balance_type: {
        type: String,
        default: "dr",
      },

      created_at: {
        type: Date,
        default: Date.now,
      },

      updated_at: {
        type: Date,
        default: Date.now,
      },
    },
    {
      strict: false,
      minimize: false,
    }
  );

const buyerNameSchema =
  new mongoose.Schema({
    legacy_id: {
      type: Number,
      unique: true,
      sparse: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
    },

    mobile: String,

    email: String,

    address: String,

    gst_no: String,

    pan_no: String,

    state: String,

    location: String,

    created_at: {
      type: Date,
      default: Date.now,
    },

    updated_at: {
      type: Date,
      default: Date.now,
    },
  });

/*
====================================================
CONSIGNEE NAME
====================================================
*/

const consigneeNameSchema =
  new mongoose.Schema({
    legacy_id: {
      type: Number,
      unique: true,
      sparse: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
    },

    buyer_id: Number,

    buyer_ids: [String],

    mobile: String,

    email: String,

    address: String,

    gst_no: String,

    pan_no: String,

    state: String,

    location: String,

    created_at: {
      type: Date,
      default: Date.now,
    },

    updated_at: {
      type: Date,
      default: Date.now,
    },
  });

buyerNameSchema.index({
  name: 1,
});

consigneeNameSchema.index({
  name: 1,
});

consigneeNameSchema.index({
  buyer_ids: 1,
});

/*
====================================================
INWARD
====================================================
*/

const inwardSchema =
  new mongoose.Schema({
    legacy_id: {
      type: Number,
      index: true,
      sparse: true,
    },

    sl_no: {
      type: Number,
      index: true,
      sparse: true,
    },

    voucher_no: {
      type: String,
      index: true,
      sparse: true,
    },

    date: Date,

    employee_id:
      mongoose.Schema.Types.Mixed,

    location_id:
      mongoose.Schema.Types.Mixed,

    warehouse_id:
      mongoose.Schema.Types.Mixed,

    product_id:
      mongoose.Schema.Types.Mixed,

    company_id:
      mongoose.Schema.Types.Mixed,

    company_account_id:
      mongoose.Schema.Types.Mixed,

    employee_name: String,

    location_name: String,

    warehouse_name: String,

    product_name: String,

    company_name: String,

    company_account_name: String,

    lorry_no: String,

    location: String,

    inward_no: String,

    company: String,

    company_account: String,

    product: String,

    quantity: Number,

    weight: Number,

    remaining_qty: Number,

    rate: Number,

    amount: Number,

    shortage_percent: Number,

    narration: String,

    created_at: {
      type: Date,
      default: Date.now,
    },

    updated_at: {
      type: Date,
      default: Date.now,
    },
  });

inwardSchema.index({
  date: -1,
  legacy_id: -1,
});

inwardSchema.index({
  voucher_no: 1,
});

/*
====================================================
OUTWARD
====================================================
*/

const outwardSchema =
  new mongoose.Schema({
    legacy_id: {
      type: Number,
      index: true,
      sparse: true,
    },

    sl_no: {
      type: Number,
      index: true,
      sparse: true,
    },

    voucher_no: {
      type: String,
      index: true,
      sparse: true,
    },

    date: Date,

    location: String,

    outward_no: String,

    employee_id:
      mongoose.Schema.Types.Mixed,

    location_id:
      mongoose.Schema.Types.Mixed,

    warehouse_id:
      mongoose.Schema.Types.Mixed,

    product_id:
      mongoose.Schema.Types.Mixed,

    company_id:
      mongoose.Schema.Types.Mixed,

    company_account_id:
      mongoose.Schema.Types.Mixed,

    employee_name: String,

    location_name: String,

    warehouse_name: String,

    product_name: String,

    company_name: String,

    company_account_name: String,

    party_name: String,

    buyer: String,

    buyer_id:
      mongoose.Schema.Types.Mixed,

    buyer_name: String,

    consignee_id:
      mongoose.Schema.Types.Mixed,

    consignee_name: String,

    product: String,

    quantity: Number,

    weight: Number,

    rate: Number,

    amount: Number,

    transporter: String,

    lorry_no: String,

    inv_no: String,

    self_loading: String,

    status: {
      type: String,
      default: "Pending",
    },

    narration: String,

    created_at: {
      type: Date,
      default: Date.now,
    },

    updated_at: {
      type: Date,
      default: Date.now,
    },
  });

outwardSchema.index({
  date: -1,
  legacy_id: -1,
});

outwardSchema.index({
  voucher_no: 1,
});

outwardSchema.index({
  outward_no: 1,
});

outwardSchema.index({
  warehouse_id: 1,
  product_id: 1,
  status: 1,
});

outwardSchema.index({
  company_id: 1,
  date: -1,
});

/*
====================================================
ADJUSTMENT
====================================================
*/

const adjustmentSchema =
  new mongoose.Schema({
    date: Date,

    location: String,

    product: String,

    old_quantity: Number,

    new_quantity: Number,

    reason: String,

    created_at: {
      type: Date,
      default: Date.now,
    },

    updated_at: {
      type: Date,
      default: Date.now,
    },
  });

/*
====================================================
BUYER ADJUSTMENT
====================================================
*/

const buyerAdjustmentSchema =
  new mongoose.Schema({
    outward_id: {
      type: Number,
      required: true,
      index: true,
    },

    buyer_id: Number,

    buyer_name: String,

    consignee_name: String,

    unloading_date: Date,

    weight: {
      type: Number,
      default: 0,
    },

    qty: {
      type: Number,
      default: 0,
    },

    rate: {
      type: Number,
      default: 0,
    },

    claim: {
      type: Number,
      default: 0,
    },

    other_deduction: {
      type: Number,
      default: 0,
    },

    shortage: {
      type: Number,
      default: 0,
    },

    shortage_amount: {
      type: Number,
      default: 0,
    },

    status: {
      type: String,
      default: "Pending",
    },

    created_at: {
      type: Date,
      default: Date.now,
    },

    updated_at: {
      type: Date,
      default: Date.now,
    },
  });

/*
====================================================
STOCK
====================================================
*/

const stockSchema =
  new mongoose.Schema({
    location: String,

    product: String,

    quantity: {
      type: Number,
      default: 0,
    },

    updated_at: {
      type: Date,
      default: Date.now,
    },
  });

/*
====================================================
TRANSPORTER
====================================================
*/

const transporterSchema =
  new mongoose.Schema({
    legacy_id: {
      type: Number,
      unique: true,
      sparse: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
    },

    mobile: String,

    address: String,

    pan_no: String,

    gst_no: String,

    aadhar_no: String,

    created_at: {
      type: Date,
      default: Date.now,
    },

    updated_at: {
      type: Date,
      default: Date.now,
    },
  });

/*
====================================================
EXPENSE
====================================================
*/

const expenseSchema =
  new mongoose.Schema(
    {
      id: {
        type: Number,
        index: true,
        unique: true,
        sparse: true,
      },

      expense_date: String,

      date: Date,

      voucher_no: String,

      location_id: Number,

      employee_id: mongoose.Schema.Types.Mixed,

      product_id: Number,

      company_id: mongoose.Schema.Types.Mixed,

      company_account_id: mongoose.Schema.Types.Mixed,

      warehouse_id: mongoose.Schema.Types.Mixed,

      reg_from_company_id: mongoose.Schema.Types.Mixed,

      send_to_company_id: mongoose.Schema.Types.Mixed,

      reg_from_consignee_id:
        Number,

      send_to_party_id:
        Number,

      send_to_kind: String,

      send_to_ref_id: Number,

      work_description: String,

      reg_lorry_no: String,

      loading: Number,

      unloading: Number,

      shortage: Number,

      excess: Number,

      shortage_excess: Number,

      balance: Number,

      net_weight: Number,

      new_lorry_no: String,

      new_weight: Number,

      challan_weight: Number,

      mb_no: String,

      paid_by: String,

      paid_by_mobile: String,

      status: String,

      receive_cash_from_party:
        Number,

      receive_cash_from_driver:
        Number,

      grand_total: Number,

      total_expense_amount:
        Number,

      narration: String,

      posted_to_inward:
        Number,

      inward_id: Number,

      posted_to_outward:
        Number,

      outward_id: Number,

      palti_posted: Number,

      palti_lorry_id: Number,

      items: {
        type: Array,
        default: [],
      },

      created_at: {
        type: Date,
        default: Date.now,
      },

      updated_at: {
        type: Date,
        default: Date.now,
      },
    },
    {
      strict: false,
      minimize: false,
    }
  );

expenseSchema.index({
  expense_date: -1,
  id: -1,
});

expenseSchema.index({
  status: 1,
  warehouse_id: 1,
  expense_date: -1,
});

/*
====================================================
CASH ENTRY
====================================================
*/

const cashEntryAdjustmentSchema =
  new mongoose.Schema({
    target_entry_id: Number,

    adjusted_amount: Number,
  });

const cashEntrySchema =
  new mongoose.Schema({
    id: {
      type: Number,
      index: true,
      unique: true,
    },

    voucher_no: String,

    journal_group_no: String,

    entry_date: Date,

    entry_type: {
      type: String,
      enum: [
        "income",
        "expense",
      ],
    },

    warehouse_id: mongoose.Schema.Types.Mixed,

    company_id: mongoose.Schema.Types.Mixed,

    company_account_id: mongoose.Schema.Types.Mixed,

    description: String,

    amount: Number,

    payment_method: String,

    reference_no: String,

    narration: String,

    created_by: Number,

    employee_id: mongoose.Schema.Types.Mixed,

    fund_source: String,

    status: String,

    source_expense_id: mongoose.Schema.Types.Mixed,

    linked_entry_id: mongoose.Schema.Types.Mixed,

    adjustments: [
      cashEntryAdjustmentSchema,
    ],

    created_at: {
      type: Date,
      default: Date.now,
    },

    updated_at: {
      type: Date,
      default: Date.now,
    },
  });

cashEntrySchema.index({
  entry_date: 1,
});

/*
====================================================
CASH BOOK SETTINGS
====================================================
*/

/*
====================================================
CASH BOOK SETTINGS
====================================================
*/

const cashBookSettingsSchema = new mongoose.Schema(
    {
      /*
    Fixed settings document.
    MongoDB counterpart:
    single document with id = 1
    */
      id: {
      type: Number,
      unique: true,
      index: true,
      default: 1,
      immutable: true,
    },

    /*
    Main Cash Book Opening Balance
    */
    main_opening_balance: {
      type: Number,
      default: 0,
      min: 0,
    },

    /*
    dr = Debit
    cr = Credit
    */
    main_opening_type: {
      type: String,
      enum: ["dr", "cr"],
      default: "dr",
    },

    /*
    0 = unlocked
    1 = locked
    */
    opening_locked: {
      type: Number,
      enum: [0, 1],
      default: 0,
    },

    /*
    User who locked/unlocked
    */
    opening_locked_by: {
      type: Number,
      default: null,
    },

    /*
    Time of lock
    */
    opening_locked_at: {
      type: Date,
      default: null,
    },

    /*
    Last user who updated
    */
    updated_by: {
      type: Number,
      default: null,
    },

    /*
    Last update time
    */
    updated_at: {
      type: Date,
      default: Date.now,
    },

    /*
    Creation time
    */
    created_at: {
      type: Date,
      default: Date.now,
    },
  },
  {
    collection: "cashbooksettings",
    minimize: false,
  }
);

cashBookSettingsSchema.index(
  { id: 1 },
  { unique: true }
);

/*
====================================================
NATIVE PAYMENT VOUCHER
====================================================
*/

const nativePaymentVoucherSchema =
  new mongoose.Schema(
    {
      id: {
        type: Number,
        unique: true,
        index: true,
      },

      voucher_no: {
        type: String,
        index: true,
      },

      date: String,

      warehouse_id:
        mongoose.Schema.Types.Mixed,

      farmer_id:
        mongoose.Schema.Types.Mixed,

      company_account_id:
        mongoose.Schema.Types.Mixed,

      amount: {
        type: Number,
        default: 0,
      },

      reference_type: String,

      reference_id: String,

      payment_mode: String,

      employee_id:
        mongoose.Schema.Types.Mixed,

      location_id:
        mongoose.Schema.Types.Mixed,

      description: String,

      outstanding_after: {
        type: Number,
        default: 0,
      },

      created_at: {
        type: Date,
        default: Date.now,
      },

      updated_at: {
        type: Date,
        default: Date.now,
      },
    },
    {
      strict: false,
      minimize: false,
      collection: "paymentvouchers_native",
    }
  );

nativePaymentVoucherSchema.index({
  date: -1,
  id: -1,
});

/*
====================================================
NATIVE PAYMENT ADJUSTMENT
====================================================
*/

const nativePaymentAdjustmentSchema =
  new mongoose.Schema(
    {
      id: {
        type: Number,
        unique: true,
        index: true,
      },

      payment_id: {
        type: Number,
        index: true,
      },

      purchase_id:
        mongoose.Schema.Types.Mixed,

      adjusted_amount: {
        type: Number,
        default: 0,
      },

      voucher_no: String,

      created_at: {
        type: Date,
        default: Date.now,
      },

      updated_at: {
        type: Date,
        default: Date.now,
      },
    },
    {
      strict: false,
      minimize: false,
      collection: "paymentadjustments_native",
    }
  );

nativePaymentAdjustmentSchema.index({
  payment_id: 1,
  id: 1,
});
/*
====================================================
MIRROR ROW
====================================================
*/

const mirrorRowSchema =
  new mongoose.Schema(
    {
      table: {
        type: String,
        required: true,
        index: true,
      },

      row_id: {
        type: Number,
        required: true,
      },

      data: {
        type:
          mongoose.Schema.Types.Mixed,
        default: {},
      },

      updated_at: {
        type: Date,
        default: Date.now,
      },
    },
    {
      minimize: false,
      collection: mirrorRowCollectionName,
    }
  );

mirrorRowSchema.index(
  {
    table: 1,
    row_id: 1,
  },
  {
    unique: true,
  }
);

/*
====================================================
PAYMENT VOUCHER
====================================================
*/

const paymentVoucherSchema =
  new mongoose.Schema(
    {
      id: {
        type: Number,
        unique: true,
        sparse: true,
        index: true,
      },

      voucher_no: {
        type: String,
        index: true,
      },

      date: String,

      warehouse_id:
        mongoose.Schema.Types.Mixed,

      farmer_id:
        mongoose.Schema.Types.Mixed,

      company_account_id:
        mongoose.Schema.Types.Mixed,

      amount: {
        type: Number,
        default: 0,
      },

      reference_type: String,

      reference_id: String,

      payment_mode: String,

      employee_id:
        mongoose.Schema.Types.Mixed,

      location_id:
        mongoose.Schema.Types.Mixed,

      description: String,

      outstanding_after: {
        type: Number,
        default: 0,
      },

      created_at: Date,

      updated_at: Date,
    },
    {
      strict: false,
      collection: "paymentvouchers",
    }
  );

/*
====================================================
PAYMENT ADJUSTMENT
====================================================
*/

const paymentAdjustmentSchema =
  new mongoose.Schema(
    {
      id: {
        type: Number,
        unique: true,
        sparse: true,
        index: true,
      },

      payment_id:
        mongoose.Schema.Types.Mixed,

      purchase_id:
        mongoose.Schema.Types.Mixed,

      adjusted_amount: {
        type: Number,
        default: 0,
      },

      created_at: Date,

      updated_at: Date,
    },
    {
      strict: false,
      collection: "paymentadjustments",
    }
  );

/*
====================================================
RECEIPT VOUCHER
====================================================
*/

const receiptVoucherSchema =
  new mongoose.Schema(
    {
      id: {
        type: Number,
        unique: true,
        sparse: true,
        index: true,
      },

      voucher_no: {
        type: String,
        index: true,
      },

      date: String,

      warehouse_id:
        mongoose.Schema.Types.Mixed,

      company_id:
        mongoose.Schema.Types.Mixed,

      company_account_id:
        mongoose.Schema.Types.Mixed,

      consignee_id:
        mongoose.Schema.Types.Mixed,

      amount: {
        type: Number,
        default: 0,
      },

      reference_type: String,

      reference_id: String,

      employee_id:
        mongoose.Schema.Types.Mixed,

      location_id:
        mongoose.Schema.Types.Mixed,

      description: String,

      created_at: Date,

      updated_at: Date,
    },
    {
      strict: false,
      collection: "receiptvouchers",
    }
  );

/*
====================================================
RECEIPT ADJUSTMENT
====================================================
*/

const receiptAdjustmentSchema =
  new mongoose.Schema(
    {
      id: {
        type: Number,
        unique: true,
        sparse: true,
        index: true,
      },

      receipt_id:
        mongoose.Schema.Types.Mixed,

      sale_id:
        mongoose.Schema.Types.Mixed,

      adjusted_amount: {
        type: Number,
        default: 0,
      },

      created_at: Date,

      updated_at: Date,
    },
    {
      strict: false,
      collection:
        "receiptadjustments",
    }
  );

/*
====================================================
JOURNAL VOUCHER
====================================================
*/

const journalVoucherSchema =
  new mongoose.Schema(
    {
      id: {
        type: Number,
        unique: true,
        sparse: true,
        index: true,
      },
    },
    {
      strict: false,
      collection:
        "journalvouchers",
    }
  );

/*
====================================================
EXPORTS
====================================================
*/

module.exports = {
  mongoose,

  isMongoMirrorReady,

  mongoMirrorEnabled,

  mongoMirrorConfigured,

  Location:
    mongoose.models.Location ||
    mongoose.model(
      "Location",
      locationSchema
    ),

  Employee:
    mongoose.models.Employee ||
    mongoose.model(
      "Employee",
      employeeSchema
    ),

  Role:
    mongoose.models.Role ||
    mongoose.model(
      "Role",
      roleSchema
    ),

  Company:
    mongoose.models.Company ||
    mongoose.model(
      "Company",
      companySchema
    ),

  CompanyAccount:
    mongoose.models.CompanyAccount ||
    mongoose.model(
      "CompanyAccount",
      companyAccountSchema
    ),

  Warehouse:
    mongoose.models.Warehouse ||
    mongoose.model(
      "Warehouse",
      warehouseSchema
    ),

  Product:
    mongoose.models.Product ||
    mongoose.model(
      "Product",
      productSchema
    ),

  Farmer:
    mongoose.models.Farmer ||
    mongoose.model(
      "Farmer",
      farmerSchema
    ),

  BuyerName:
    mongoose.models.BuyerName ||
    mongoose.model(
      "BuyerName",
      buyerNameSchema
    ),

  ConsigneeName:
    mongoose.models.ConsigneeName ||
    mongoose.model(
      "ConsigneeName",
      consigneeNameSchema
    ),

  Inward:
    mongoose.models.Inward ||
    mongoose.model(
      "Inward",
      inwardSchema
    ),

  Outward:
    mongoose.models.Outward ||
    mongoose.model(
      "Outward",
      outwardSchema
    ),

  Adjustment:
    mongoose.models.Adjustment ||
    mongoose.model(
      "Adjustment",
      adjustmentSchema
    ),

  BuyerAdjustment:
    mongoose.models.BuyerAdjustment ||
    mongoose.model(
      "BuyerAdjustment",
      buyerAdjustmentSchema
    ),

  Stock:
    mongoose.models.Stock ||
    mongoose.model(
      "Stock",
      stockSchema
    ),

  Transporter:
    mongoose.models.Transporter ||
    mongoose.model(
      "Transporter",
      transporterSchema
    ),

  Expense:
    mongoose.models.Expense ||
    mongoose.model(
      "Expense",
      expenseSchema
    ),

  CashEntry:
    mongoose.models.CashEntry ||
    mongoose.model(
      "CashEntry",
      cashEntrySchema
    ),

  CashBookSettings:
    mongoose.models.CashBookSettings ||
    mongoose.model(
      "CashBookSettings",
      cashBookSettingsSchema
    ),

  PaymentVoucher:
    mongoose.models.PaymentVoucher ||
    mongoose.model(
      "PaymentVoucher",
      paymentVoucherSchema
    ),

  PaymentVoucherNative:
    mongoose.models.PaymentVoucherNative ||
    mongoose.model(
      "PaymentVoucherNative",
      nativePaymentVoucherSchema
    ),

  PaymentAdjustmentNative:
    mongoose.models.PaymentAdjustmentNative ||
    mongoose.model(
      "PaymentAdjustmentNative",
      nativePaymentAdjustmentSchema
    ),

  PaymentAdjustment:
    mongoose.models.PaymentAdjustment ||
    mongoose.model(
      "PaymentAdjustment",
      paymentAdjustmentSchema
    ),

  ReceiptVoucher:
    mongoose.models.ReceiptVoucher ||
    mongoose.model(
      "ReceiptVoucher",
      receiptVoucherSchema
    ),

  ReceiptAdjustment:
    mongoose.models.ReceiptAdjustment ||
    mongoose.model(
      "ReceiptAdjustment",
      receiptAdjustmentSchema
    ),

  JournalVoucher:
    mongoose.models.JournalVoucher ||
    mongoose.model(
      "JournalVoucher",
      journalVoucherSchema
    ),

  MirrorRow:
    mongoose.models.MirrorRow ||
    mongoose.model(
      "MirrorRow",
      mirrorRowSchema
    ),
};


