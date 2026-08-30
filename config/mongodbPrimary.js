const mongoose = require("mongoose");

/**
 * MongoDB-primary configuration.
 * This module never drops collections, deletes documents, or mirrors legacy data.
 */
function getMongoUri() {
  const raw = process.env.MONGODB_URI;
  if (!raw || !raw.trim()) {
    throw new Error("MONGODB_URI is required. Set it in Render Environment Variables.");
  }

  const uri = raw.trim();

  // Guard against the common malformed Atlas form:
  // mongodb+srv://.../?finance=Cluster0
  if (/[?&]finance(?:=|&|$)/i.test(uri)) {
    throw new Error(
      'Invalid MONGODB_URI: "finance" is being passed as a MongoDB option. ' +
      'Use /Warehouse?retryWrites=true&w=majority&appName=Cluster0 instead.'
    );
  }

  return uri;
}

async function connectMongoPrimary() {
  const uri = getMongoUri();

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 15000,
  });

  const dbName = mongoose.connection.db.databaseName;
  console.log(`✅ MongoDB Primary Connected: ${dbName}`);
  if (dbName.toLowerCase() !== "warehouse") {
    console.warn(`⚠️ Expected MongoDB database "Warehouse", but connected to "${dbName}".`);
  }
}

module.exports = { getMongoUri, connectMongoPrimary };
