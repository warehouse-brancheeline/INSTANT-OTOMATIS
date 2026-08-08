const axios = require('axios');
const config = require('../config');

let token = null;
let tokenObtainedAt = 0;
const TOKEN_TTL_MS = 11 * 60 * 60 * 1000; // refresh a bit before the real 12h expiry

const http = axios.create({
  baseURL: config.jubelioApiBase,
  timeout: 30000,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function login() {
  const res = await http.post('/login', {
    email: config.jubelioEmail,
    password: config.jubelioPassword,
  });
  token = res.data.token;
  tokenObtainedAt = Date.now();
  return token;
}

async function getToken() {
  const isStale = !token || Date.now() - tokenObtainedAt > TOKEN_TTL_MS;
  if (isStale) {
    await login();
  }
  return token;
}

/**
 * Authenticated request with auto re-login on 401 and backoff retry on 429/5xx.
 */
async function request(method, url, { params, data, retries = 3 } = {}) {
  const authToken = await getToken();

  try {
    const res = await http.request({
      method,
      url,
      params,
      data,
      headers: { authorization: authToken },
    });
    return res.data;
  } catch (err) {
    const status = err.response && err.response.status;

    if (status === 401) {
      token = null; // force re-login
      if (retries > 0) {
        await getToken();
        return request(method, url, { params, data, retries: retries - 1 });
      }
    }

    if (status === 429 || (status >= 500 && status < 600)) {
      if (retries > 0) {
        const backoffMs = (4 - retries) * 2000;
        await sleep(backoffMs);
        return request(method, url, { params, data, retries: retries - 1 });
      }
    }

    throw err;
  }
}

module.exports = {
  get: (url, params) => request('GET', url, { params }),
  post: (url, data) => request('POST', url, { data }),
};
