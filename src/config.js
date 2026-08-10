require('dotenv').config();

const required = ['JUBELIO_EMAIL', 'JUBELIO_PASSWORD', 'DASHBOARD_USERNAME', 'DASHBOARD_PASSWORD', 'SESSION_SECRET'];
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
  dashboardUsername: process.env.DASHBOARD_USERNAME,
  dashboardPassword: process.env.DASHBOARD_PASSWORD,
  sessionSecret: process.env.SESSION_SECRET,
  // Firebase "Sign in with Google" login - alternative to username/password,
  // only this one email is allowed through regardless of who signs into
  // Google with the popup.
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID || 'web-instant-bcl',
  allowedLoginEmail: process.env.ALLOWED_LOGIN_EMAIL || 'headwarehouse.brancheeline@gmail.com',
  // The GitHub Pages page is the only stable origin Firebase's OAuth popup can
  // be authorized for (the Cloudflare quick tunnel origin rotates), so it's
  // also the only origin allowed to call /api/login-firebase cross-origin.
  firebaseLoginOrigin: process.env.FIREBASE_LOGIN_ORIGIN || 'https://warehouse-brancheeline.github.io',
};
