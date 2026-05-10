const mongoose = require("mongoose");

require("dotenv").config();

mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/warehouse", {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const companySchema = new mongoose.Schema({
  name: String,
  address: String,
  mobile: String,
  opening_balance: { type: Number, default: 0 },
  opening_balance_type: { type: String, default: "dr" },
}, { timestamps: true });

const Company = mongoose.model("Company", companySchema);

async function updateCompanies() {
  try {
    await mongoose.connection;
    console.log("Connected to MongoDB");

    // First, check what companies exist
    const allCompanies = await Company.find();
    console.log(`Found ${allCompanies.length} companies`);

    if (allCompanies.length > 0) {
      console.log("Sample company data:", JSON.stringify(allCompanies[0], null, 2));
    }

    // Update companies that don't have opening_balance
    const result = await Company.updateMany(
      { 
        $or: [
          { opening_balance: { $exists: false } },
          { opening_balance_type: { $exists: false } }
        ]
      },
      {
        $set: {
          opening_balance: 0,
          opening_balance_type: "dr",
        },
      }
    );

    console.log(`Updated ${result.modifiedCount} companies`);

    // Verify after update
    const updatedCompanies = await Company.find();
    if (updatedCompanies.length > 0) {
      console.log("Updated sample company data:", JSON.stringify(updatedCompanies[0], null, 2));
    }

    mongoose.connection.close();
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

updateCompanies();