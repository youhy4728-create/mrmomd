require('dotenv').config();

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
