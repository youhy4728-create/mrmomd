require('dotenv').config();

// Validate critical env vars
const missing = [];
if (!process.env.GAS_ENDPOINT_URL) missing.push('GAS_ENDPOINT_URL');
if (!process.env.GAS_API_KEY) missing.push('GAS_API_KEY');
if (!process.env.JWT_ACCESS_SECRET) missing.push('JWT_ACCESS_SECRET');
if (!process.env.JWT_REFRESH_SECRET) missing.push('JWT_REFRESH_SECRET');

if (missing.length > 0) {
  console.error('');
  console.error('❌❌❌ MISSING ENVIRONMENT VARIABLES ❌❌❌');
  console.error('The following variables are required but not set:');
  missing.forEach(v => console.error('   →', v));
  console.error('');
  console.error('Please set them in Railway Dashboard → Variables');
  console.error('');
}

module.exports = {
  port: process.env.PORT || 4000,
  nodeEnv: process.env.NODE_ENV || 'development',
  clientOrigin: process.env.CLIENT_ORIGIN || '*',

  gas: {
    endpointUrl: process.env.GAS_ENDPOINT_URL,
    apiKey: process.env.GAS_API_KEY
  },

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpires: process.env.JWT_ACCESS_EXPIRES || '15m',
    refreshExpires: process.env.JWT_REFRESH_EXPIRES || '30d'
  },

  bootstrapAdmin: {
    username: process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin',
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD || 'admin123',
    name: process.env.BOOTSTRAP_ADMIN_NAME || 'Admin'
  }
};
