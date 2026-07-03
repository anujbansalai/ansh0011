// dataDownloader.js
// Fetches the daily NSE full Bhavcopy (sec_bhavdata_full format) and saves it into ./data
//
// NOTE: this replaces an earlier version that targeted the older
// cmDDMMMYYYYbhav.csv.zip archive path. That format appears to be legacy —
// tilak999/NSE-Data-bank's actively-updated data/ folder uses
// sec_bhavdata_full_DDMMYYYY.csv, which matches NSE's current daily feed.
//
// Usage:
//   node dataDownloader.js            -> fetches today's date
//   node dataDownloader.js 03072026   -> fetches a specific date (DDMMYYYY), for backfill/testing

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BASE_URL = 'https://www.nseindia.com';
const PRODUCTS_URL = 'https://nsearchives.nseindia.com/products/content';

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

function formatDate(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return { dd, mm, yyyy };
}

function parseDateArg(arg) {
  // arg format: DDMMYYYY
  const dd = arg.slice(0, 2);
  const mm = arg.slice(2, 4);
  const yyyy = arg.slice(4, 8);
  return new Date(`${yyyy}-${mm}-${dd}`);
}

async function downloadBhavcopy(date, cookie, retries = 3) {
  const { dd, mm, yyyy } = formatDate(date);
  const filename = `sec_bhavdata_full_${dd}${mm}${yyyy}.csv`;
  const url = `${PRODUCTS_URL}/${filename}`;

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
        console.log(`No file for ${dd}-${mm}-${yyyy} (likely a holiday/weekend).`);
        return false;
      }

      console.warn(`Attempt ${attempt}: unexpected status ${res.status} for ${url}`);
    } catch (err) {
      console.warn(`Attempt ${attempt} failed: ${err.code || err.message}`);
    }

    await new Promise((r) => setTimeout(r, attempt * 2000));
  }

  console.error(`Giving up on ${filename} after ${retries} attempts.`);
  return false;
}

(async () => {
  try {
    const cookie = await getSessionCookie();
    const dateArg = process.argv[2];
    const targetDate = dateArg ? parseDateArg(dateArg) : new Date();
    await downloadBhavcopy(targetDate, cookie);
  } catch (err) {
    console.error('Run failed:', err.message);
    process.exitCode = 1;
  }
})();
