// lib/nseClient.js
// Shared session handling for talking to NSE's endpoints.

const axios = require('axios');

const BASE_URL = 'https://www.nseindia.com';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Connection: 'keep-alive',
  Referer: `${BASE_URL}/`,
};

async function getSessionCookie() {
  const res = await axios.get(BASE_URL, {
    headers: HEADERS,
    timeout: 15000,
    validateStatus: () => true,
  });
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) {
    throw new Error(
      `No cookies returned from homepage (status ${res.status}). NSE may have changed their bot-check.`
    );
  }
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

async function nseGet(path, cookie, extraHeaders = {}) {
  const res = await axios.get(`${BASE_URL}${path}`, {
    headers: { ...HEADERS, ...extraHeaders, Cookie: cookie },
    timeout: 15000,
    validateStatus: () => true,
  });
  return res;
}

module.exports = { BASE_URL, HEADERS, getSessionCookie, nseGet };
