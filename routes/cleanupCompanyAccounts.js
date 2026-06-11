const mongoose = require("mongoose");

require("dotenv").config();

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  console.error("MONGODB_URI is required for cleanupCompanyAccounts.js");
  process.exit(1);
}

mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const companyAccountSchema = new mongoose.Schema({
  account_name: { type: String, required: true },
  address: String,
  company_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  pan_no: String,
  mobile: String,
  created_at: { type: Date, default: Date.now },
});

const CompanyAccount = mongoose.model("CompanyAccount", companyAccountSchema);

const companySchema = new mongoose.Schema({
  name: String,
  address: String,
  mobile: String,
  opening_balance: { type: Number, default: 0 },
  opening_balance_type: { type: String, default: "dr" },
}, { timestamps: true });

const Company = mongoose.model("Company", companySchema);

async function cleanup() {
  try {
    await mongoose.connection;
    console.log("Connected to MongoDB");

    // Find all company accounts
    const allAccounts = await CompanyAccount.find();
    console.log(`Found ${allAccounts.length} company accounts`);

    let fixed = 0;
    let deleted = 0;

    for (const account of allAccounts) {
      try {
        // Check if company_id is valid ObjectId
        if (!mongoose.Types.ObjectId.isValid(account.company_id)) {
          console.log(`Invalid company_id in account "${account.account_name}": ${account.company_id}`);
          
          // If company_id is a string (likely a company name), try to find the company
          if (typeof account.company_id === "string") {
            const company = await Company.findOne({ name: account.company_id });
            if (company) {
              account.company_id = company._id;
              await account.save();
              console.log(`  Fixed: linked to company ${company.name} (${company._id})`);
              fixed++;
            } else {
              console.log(`  Deleting: no matching company found for "${account.company_id}"`);
              await CompanyAccount.deleteOne({ _id: account._id });
              deleted++;
            }
          }
        }
      } catch (err) {
        console.error(`Error processing account ${account._id}:`, err.message);
      }
    }

    console.log(`\nCleanup complete:`);
    console.log(`  Fixed: ${fixed}`);
    console.log(`  Deleted: ${deleted}`);

    mongoose.connection.close();
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

cleanup();
