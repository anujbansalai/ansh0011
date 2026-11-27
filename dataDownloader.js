// dataDownloader.js
// Downloads NSE's daily full bhavcopy (sec_bhavdata_full_DDMMYYYY.csv) into ./data
//
// How it fetches:
//   NSE publishes these files as plain public downloads on its archive host. The
//   file is requested directly — there is no visit to the nseindia.com homepage,
//   no session cookie and no browser imitation. (The old version fetched a
//   homepage cookie first; that homepage now refuses GitHub's servers with HTTP
//   403, which stopped every download even though the archive host itself
//   serves the files normally.)
//
// Usage:
//   node dataDownloader.js                     -> catch-up: every missing trading day in the last
//                                                 LOOKBACK_WEEKDAYS weekdays (default 10), up to today (IST)
//   node dataDownloader.js 26112026            -> one specific date (DDMMYYYY), weekends allowed
//   node dataDownloader.js 19112026,20112026   -> several specific dates
//
// Exit codes:
//   0 -> nothing went wrong (files saved, or nothing new published yet)
//   1 -> a request was blocked or errored (e.g. HTTP 403/5xx/network) — the run shows red
//
// Writes the list of saved dates to $GITHUB_OUTPUT as `saved=...` for the commit message.

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const HOSTS = (process.env.BHAV_HOSTS ||
  'https://nsearchives.nseindia.com/products/content,https://archives.nseindia.com/products/content')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);
const LOOKBACK_WEEKDAYS = Number(process.env.LOOKBACK_WEEKDAYS || 10);
const RETRIES = Number(process.env.BHAV_RETRIES || 3);
const RETRY_DELAY_MS = Number(process.env.BHAV_RETRY_DELAY_MS || 4000);
const DATA_DIR = path.join(__dirname, 'data');
const HOLIDAYS_FILE = path.join(__dirname, 'nse_holidays.json');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- date helpers (all calendar dates are plain {y,m,d}; "today" is taken in IST) ----
function todayIST() {
  const now = process.env.FAKE_NOW ? new Date(process.env.FAKE_NOW) : new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  return { y: ist.getUTCFullYear(), m: ist.getUTCMonth() + 1, d: ist.getUTCDate() };
}
const toUTC = ({ y, m, d }) => new Date(Date.UTC(y, m - 1, d));
const fromUTC = (dt) => ({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });
const pad = (n) => String(n).padStart(2, '0');
const ddmmyyyy = ({ y, m, d }) => `${pad(d)}${pad(m)}${y}`;
const iso = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;
const nseDate1 = ({ y, m, d }) => `${pad(d)}-${MONTHS[m - 1]}-${y}`; // e.g. 26-Nov-2026

function parseDDMMYYYY(s) {
  if (!/^\d{8}$/.test(s)) throw new Error(`Bad date "${s}" — expected DDMMYYYY, e.g. 26112026`);
  const date = { d: +s.slice(0, 2), m: +s.slice(2, 4), y: +s.slice(4, 8) };
  const check = fromUTC(toUTC(date));
  if (check.d !== date.d || check.m !== date.m) throw new Error(`Bad date "${s}" — no such calendar day`);
  return date;
}

function loadHolidays() {
  try {
    const raw = JSON.parse(fs.readFileSync(HOLIDAYS_FILE, 'utf8'));
    return new Set(Object.values(raw.holidays || {}).flat());
  } catch {
    return new Set();
  }
}

function catchUpTargets(holidays) {
  const out = [];
  let dt = toUTC(todayIST());
  while (out.length < LOOKBACK_WEEKDAYS) {
    const dow = dt.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(fromUTC(dt));
    dt = new Date(dt.getTime() - 86400000);
  }
  return out.reverse().filter((dt) => !holidays.has(iso(dt)));
}

// ---- download ----
// Returns { status: 'saved' | 'exists' | 'not_published' | 'holiday_copy' | 'error', detail }
async function fetchOne(date) {
  const filename = `sec_bhavdata_full_${ddmmyyyy(date)}.csv`;
  const outFile = path.join(DATA_DIR, filename);
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) return { status: 'exists' };

  const errors = [];
  let notFoundEverywhere = true;
  for (const host of HOSTS) {
    const url = `${host}/${filename}`;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      let res;
      try {
        res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000, validateStatus: () => true });
      } catch (err) {
        errors.push(`${url} attempt ${attempt}: ${err.code || err.message}`);
        notFoundEverywhere = false;
        if (attempt < RETRIES) await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      if (res.status === 404) break; // not published (yet) on this host — try the next host
      if (res.status !== 200) {
        errors.push(`${url} attempt ${attempt}: HTTP ${res.status}`);
        notFoundEverywhere = false;
        if (attempt < RETRIES) await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }

      const text = Buffer.from(res.data).toString('utf8');
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      const header = (lines[0] || '').split(',').map((c) => c.trim());
      const iDate = header.indexOf('DATE1');
      if (header[0] !== 'SYMBOL' || iDate < 0 || lines.length < 100) {
        errors.push(`${url}: response is not a valid bhavcopy (${lines.length} lines, header "${lines[0]?.slice(0, 60)}")`);
        notFoundEverywhere = false;
        break; // a broken file won't fix itself on retry; try the other host
      }
      const fileDate = (lines[1].split(',')[iDate] || '').trim();
      if (fileDate !== nseDate1(date)) {
        // NSE serves a copy of the previous session under a holiday's name — don't store it.
        return { status: 'holiday_copy', detail: `file holds ${fileDate}` };
      }
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(outFile, res.data);
      return { status: 'saved', detail: `${lines.length - 1} rows from ${new URL(url).host}` };
    }
  }
  if (notFoundEverywhere && errors.length === 0) return { status: 'not_published' };
  return { status: 'error', detail: errors.join(' ; ') };
}

(async () => {
  const arg = (process.argv[2] || '').trim();
  const holidays = loadHolidays();
  let targets;
  try {
    targets = arg ? arg.split(',').map((s) => parseDDMMYYYY(s.trim())) : catchUpTargets(holidays);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log(arg ? `Specific date(s): ${targets.map(iso).join(', ')}`
    : `Catch-up mode: checking ${targets.length} weekday(s) ${iso(targets[0])} .. ${iso(targets[targets.length - 1])} (IST), holidays excluded`);

  const saved = [];
  const failed = [];
  for (const date of targets) {
    const r = await fetchOne(date);
    const label = { saved: 'SAVED', exists: 'already present', not_published: 'not published (404)',
      holiday_copy: 'skipped — holiday copy', error: 'ERROR' }[r.status];
    console.log(`${iso(date)}: ${label}${r.detail ? ` — ${r.detail}` : ''}`);
    if (r.status === 'saved') saved.push(ddmmyyyy(date));
    if (r.status === 'error') failed.push(iso(date));
  }

  console.log(`\nSaved ${saved.length}: ${saved.join(', ') || '-'}; errors ${failed.length}: ${failed.join(', ') || '-'}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `saved=${saved.join(',')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### Bhavcopy download\n- Saved: ${saved.join(', ') || 'none'}\n- Errors: ${failed.join(', ') || 'none'}\n`);
  }
  if (failed.length) {
    console.error(`\nDownload errors for ${failed.join(', ')} — failing the run so it is noticed.`);
    process.exitCode = 1;
  }
})();
