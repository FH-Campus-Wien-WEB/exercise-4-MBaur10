// Load .env file into process.env
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// Load configuration from environment variables
module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  omdbApiKey: process.env.OMDB_API_KEY || '136b28ad',
  sessionSecret: process.env.SESSION_SECRET || 'your-secret-key',
  omdbTimeoutMs: 5000 // 5 second timeout for external API calls
};
