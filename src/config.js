require('dotenv').config();

const required = ['JUBELIO_EMAIL', 'JUBELIO_PASSWORD'];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var ${key}. Copy .env.example to .env and fill it in.`);
  }
}

module.exports = {
  jubelioEmail: process.env.JUBELIO_EMAIL,
  jubelioPassword: process.env.JUBELIO_PASSWORD,
  jubelioApiBase: process.env.JUBELIO_API_BASE || 'https://api2.jubelio.com',
  port: Number(process.env.PORT) || 4123,
};
