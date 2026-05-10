const mongoose = require('mongoose');
const dns = require('node:dns');

require('dotenv').config();

mongoose.set('bufferCommands', false);

const rawMongoUri = process.env.MONGODB_URI?.trim() || '';
const mongoMirrorEnabled = String(process.env.MONGODB_MIRROR_ENABLED || 'true').toLowerCase() !== 'false';
const mongoDnsServers = String(process.env.MONGODB_DNS_SERVERS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

if (mongoDnsServers.length > 0) {
  dns.setServers(mongoDnsServers);
  console.log(`Using custom DNS servers for MongoDB: ${mongoDnsServers.join(', ')}`);
}

function normalizeAtlasUri(uri) {
  if (!uri || !uri.startsWith('mongodb+srv://')) return uri;
  return uri.replace(
    /\/([^/?#=]+)=([^/?#]+)$/,
    '/$1?retryWrites=true&w=majority&appName=$2'
  );
}

const mongodbUri = normalizeAtlasUri(rawMongoUri);
const hasMongoUri = mongodbUri && !mongodbUri.includes('username:password');
const mongoMirrorConfigured = mongoMirrorEnabled && hasMongoUri;

function isMongoMirrorReady() {
  return mongoMirrorEnabled && mongoose.connection.readyState === 1;
}

if (!mongoMirrorEnabled) {
  console.log('MongoDB mirror disabled (MONGODB_MIRROR_ENABLED=false).');
} else if (!hasMongoUri) {
  console.log('MongoDB URI is not configured or contains placeholder credentials. Skipping MongoDB mirror.');
} else {
  if (mongodbUri !== rawMongoUri) {
    console.log('Normalized MongoDB URI format from legacy value in .env.');
  }

  mongoose
    .connect(mongodbUri, {
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 45000,
    })
    .then(() => console.log('Connected to MongoDB'))
    .catch((err) => {
      if (err?.syscall === 'querySrv') {
        console.error('MongoDB SRV DNS lookup failed. Switch DNS server or use Atlas non-SRV URI.');
      }
      console.error('MongoDB Connection Error:', err.message);
    });
}

// Define Schemas and Models
const locationSchema = new mongoose.Schema({
  name: { type: String, required: true },
  address: String,
  hsn_code: String,
  created_at: { type: Date, default: Date.now },
});

const employeeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  address: String,
  location_id: mongoose.Schema.Types.ObjectId,
  username: { type: String, unique: true, sparse: true },
  password: String,
  role: { type: String, default: 'staff' },
  permissions: { type: [String], default: [] },
  created_at: { type: Date, default: Date.now },
});

const roleSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  permissions: { type: [String], default: [] },
  is_admin: { type: Number, default: 0 },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

const companySchema = new mongoose.Schema({
  name: { type: String, required: true },
  address: String,
  mobile: String,
  opening_balance: { type: Number, default: 0 },
  opening_balance_type: { type: String, default: "dr" },
  created_at: { type: Date, default: Date.now },
});

const companyAccountSchema = new mongoose.Schema({
  account_name: { type: String, required: true },
  address: String,
  company_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  pan_no: String,
  mobile: String,
  created_at: { type: Date, default: Date.now },
});

const warehouseSchema = new mongoose.Schema({
  name: { type: String, required: true },
  address: String,
  location_id: mongoose.Schema.Types.ObjectId,
  employee_id: mongoose.Schema.Types.ObjectId,
  created_at: { type: Date, default: Date.now },
});

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  hsn_code: String,
  created_at: { type: Date, default: Date.now },
});

const buyerNameSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  mobile: String,
  email: String,
  address: String,
  gst_no: String,
  pan_no: String,
  state: String,
  created_at: { type: Date, default: Date.now },
});

const consigneeNameSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  mobile: String,
  email: String,
  address: String,
  gst_no: String,
  state: String,
  created_at: { type: Date, default: Date.now },
});

const inwardSchema = new mongoose.Schema({
  date: Date,
  location: String,
  inward_no: String,
  company: String,
  company_account: String,
  product: String,
  quantity: Number,
  rate: Number,
  amount: Number,
  narration: String,
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

const outwardSchema = new mongoose.Schema({
  date: Date,
  location: String,
  outward_no: String,
  buyer: String,
  product: String,
  quantity: Number,
  rate: Number,
  amount: Number,
  transporter: String,
  narration: String,
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

const adjustmentSchema = new mongoose.Schema({
  date: Date,
  location: String,
  product: String,
  old_quantity: Number,
  new_quantity: Number,
  reason: String,
  created_at: { type: Date, default: Date.now },
});

const stockSchema = new mongoose.Schema({
  location: String,
  product: String,
  quantity: { type: Number, default: 0 },
  updated_at: { type: Date, default: Date.now },
});

const transporterSchema = new mongoose.Schema({
  name: { type: String, required: true },
  mobile: String,
  address: String,
  gst_no: String,
  created_at: { type: Date, default: Date.now },
});

const expenseSchema = new mongoose.Schema({
  date: Date,
  location: String,
  category: String,
  amount: Number,
  description: String,
  created_at: { type: Date, default: Date.now },
});

const cashEntryAdjustmentSchema = new mongoose.Schema({
  target_entry_id: Number,
  adjusted_amount: Number,
});

const cashEntrySchema = new mongoose.Schema({
  id: { type: Number, index: true, unique: true },
  voucher_no: String,
  journal_group_no: String,
  entry_date: Date,
  entry_type: { type: String, enum: ['income', 'expense'] },
  warehouse_id: Number,
  company_id: Number,
  company_account_id: Number,
  description: String,
  amount: Number,
  payment_method: String,
  reference_no: String,
  narration: String,
  created_by: Number,
  employee_id: Number,
  fund_source: String,
  status: String,
  source_expense_id: Number,
  linked_entry_id: Number,
  adjustments: [cashEntryAdjustmentSchema],
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

cashEntrySchema.index({ entry_date: 1 });

const sqliteMirrorRowSchema = new mongoose.Schema(
  {
    table: { type: String, required: true, index: true },
    row_id: { type: Number, required: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    updated_at: { type: Date, default: Date.now },
  },
  {
    minimize: false,
  }
);

sqliteMirrorRowSchema.index({ table: 1, row_id: 1 }, { unique: true });

// Export models
module.exports = {
  mongoose,
  isMongoMirrorReady,
  mongoMirrorEnabled,
  mongoMirrorConfigured,
  Location: mongoose.model('Location', locationSchema),
  Employee: mongoose.model('Employee', employeeSchema),
  Role: mongoose.model('Role', roleSchema),
  Company: mongoose.model('Company', companySchema),
  CompanyAccount: mongoose.model('CompanyAccount', companyAccountSchema),
  Warehouse: mongoose.model('Warehouse', warehouseSchema),
  Product: mongoose.model('Product', productSchema),
  BuyerName: mongoose.model('BuyerName', buyerNameSchema),
  ConsigneeName: mongoose.model('ConsigneeName', consigneeNameSchema),
  Inward: mongoose.model('Inward', inwardSchema),
  Outward: mongoose.model('Outward', outwardSchema),
  Adjustment: mongoose.model('Adjustment', adjustmentSchema),
  Stock: mongoose.model('Stock', stockSchema),
  Transporter: mongoose.model('Transporter', transporterSchema),
  Expense: mongoose.model('Expense', expenseSchema),
  CashEntry: mongoose.model('CashEntry', cashEntrySchema),
  SqliteMirrorRow: mongoose.model('SqliteMirrorRow', sqliteMirrorRowSchema),
};
