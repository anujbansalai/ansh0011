// dataDownloader.js
// Fetches the daily NSE Equity Bhavcopy and saves it into ./data
// Mirrors the approach used by tilak999/NSE-Data-bank so you're not dependent on his repo.

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BASE_URL = 'https://www.nseindia.com';
const ARCHIVE_URL = 'https://nsearchives.nseindia.com';

// Browser-like headers. This is what gets you past the basic bot-check —
// NSE is checking for a realistic client, not doing deep fingerprinting.
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Connection: 'keep-alive',
  Referer: `${BASE_URL}/`,
};

// Step 1: warm up a session. NSE sets cookies on the homepage that are
// required for subsequent data requests to succeed.
async function getSessionCookie() {
  const res = await axios.get(BASE_URL, {
    headers: HEADERS,
    timeout: 15000,
    validateStatus: () => true, // inspect status ourselves
  });

  const setCookie = res.headers['set-cookie'];
  if (!setCookie) {
    throw new Error(
      `No cookies returned from homepage (status ${res.status}). NSE may have changed their bot-check.`
    );
  }
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

function formatDate(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mmm = date.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  const yyyy = date.getFullYear();
  return { dd, mmm, yyyy };
}

// Step 2: use the session cookie to fetch the actual file.
async function downloadBhavcopy(date, cookie, retries = 3) {
  const { dd, mmm, yyyy } = formatDate(date);
  const filename = `cm${dd}${mmm}${yyyy}bhav.csv.zip`;
  const url = `${ARCHIVE_URL}/content/historical/EQUITIES/${yyyy}/${mmm}/${filename}`;

  const outDir = path.join(__dirname, 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, filename);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, {
        headers: { ...HEADERS, Cookie: cookie },
        responseType: 'arraybuffer',
        timeout: 20000,
        validateStatus: () => true,
      });

      if (res.status === 200 && res.data?.length > 0) {
        fs.writeFileSync(outFile, res.data);
        console.log(`Saved ${outFile}`);
        return true;
      }

      if (res.status === 404) {
        console.log(`No file for ${dd}-${mmm}-${yyyy} (likely a holiday/weekend).`);
        return false;
      }

      console.warn(`Attempt ${attempt}: unexpected status ${res.status} for ${url}`);
    } catch (err) {
      console.warn(`Attempt ${attempt} failed: ${err.code || err.message}`);
    }

    // Backoff before retrying — no need to hammer the server.
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }

  console.error(`Giving up on ${filename} after ${retries} attempts.`);
  return false;
}

(async () => {
  try {
    const cookie = await getSessionCookie();
    const today = new Date();
    await downloadBhavcopy(today, cookie);
  } catch (err) {
    console.error('Run failed:', err.message);
    process.exitCode = 1;
  }
})();
