// reconcile.js
// Compares dates present in data/ + historic_data/ against expected trading
// days (weekdays minus official NSE holidays). Flags real gaps vs holidays.
//
// Note: I couldn't live-test the holiday endpoint from my sandbox (nseindia.com
// isn't on my allowed network list there) — this follows the schema documented
// by open-source NSE clients (jugaad-data / nsepython). If NSE has changed the
// response shape, this will print the raw payload so you can adjust the parser.

const fs = require('fs');
const path = require('path');
const { getSessionCookie, nseGet } = require('./lib/nseClient');

const DATA_DIRS = ['data', 'historic_data'];
const FILENAME_RE = /^cm(\d{2})([A-Z]{3})(\d{4})bhav\.csv(\.zip)?$/;
const MONTHS = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

function collectLocalDates() {
  const dates = new Set();
  for (const dir of DATA_DIRS) {
    const dirPath = path.join(__dirname, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const file of fs.readdirSync(dirPath)) {
      const m = file.match(FILENAME_RE);
      if (!m) continue;
      const [, dd, mmm, yyyy] = m;
      const month = MONTHS[mmm];
      if (month === undefined) continue;
      dates.add(`${yyyy}-${String(month + 1).padStart(2, '0')}-${dd}`);
    }
  }
  return dates;
}

async function fetchHolidays(cookie, year) {
  const res = await nseGet(`/api/holiday-master?type=trading`, cookie, {
    Accept: 'application/json',
  });

  if (res.status !== 200) {
    console.warn(`Holiday API returned status ${res.status}. Raw body:`);
    console.warn(JSON.stringify(res.data).slice(0, 500));
    return new Set();
  }

  // Expected shape: { CM: [{ tradingDate: "26-Jan-2026", ... }], FO: [...], ... }
  const cmHolidays = res.data?.CM;
  if (!Array.isArray(cmHolidays)) {
    console.warn('Unexpected holiday payload shape. Raw body:');
    console.warn(JSON.stringify(res.data).slice(0, 500));
    return new Set();
  }

  const set = new Set();
  for (const h of cmHolidays) {
    // tradingDate like "26-Jan-2026"
    const parts = h.tradingDate?.split('-');
    if (!parts || parts.length !== 3) continue;
    const [dd, mmmRaw, yyyy] = parts;
    const month = MONTHS[mmmRaw.toUpperCase()];
    if (month === undefined) continue;
    set.add(`${yyyy}-${String(month + 1).padStart(2, '0')}-${dd.padStart(2, '0')}`);
  }
  return set;
}

function generateWeekdays(startDate, endDate) {
  const days = [];
  const d = new Date(startDate);
  while (d <= endDate) {
    const day = d.getDay(); // 0 = Sun, 6 = Sat
    if (day !== 0 && day !== 6) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      days.push(`${yyyy}-${mm}-${dd}`);
    }
    d.setDate(d.getDate() + 1);
  }
  return days;
}

async function main() {
  const lookbackDays = Number(process.argv[2]) || 45; // default: check last 45 days
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - lookbackDays);

  console.log(`Checking trading days from ${startDate.toDateString()} to ${endDate.toDateString()}`);

  const localDates = collectLocalDates();
  console.log(`Found ${localDates.size} local bhavcopy dates on disk.`);

  const cookie = await getSessionCookie();
  const years = new Set([startDate.getFullYear(), endDate.getFullYear()]);
  let holidays = new Set();
  for (const year of years) {
    const yearHolidays = await fetchHolidays(cookie, year);
    holidays = new Set([...holidays, ...yearHolidays]);
  }
  console.log(`Fetched ${holidays.size} known holiday dates.`);

  const expectedWeekdays = generateWeekdays(startDate, endDate);

  const missing = [];
  const explainedHolidays = [];

  for (const date of expectedWeekdays) {
    if (localDates.has(date)) continue;
    if (holidays.has(date)) {
      explainedHolidays.push(date);
    } else {
      missing.push(date);
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    range: { from: startDate.toISOString().slice(0, 10), to: endDate.toISOString().slice(0, 10) },
    expected_trading_days: expectedWeekdays.length,
    present: expectedWeekdays.length - missing.length - explainedHolidays.length,
    explained_holidays: explainedHolidays,
    unexplained_gaps: missing,
  };

  fs.writeFileSync(
    path.join(__dirname, 'reconciliation_report.json'),
    JSON.stringify(report, null, 2)
  );

  console.log(`\n--- Reconciliation Summary ---`);
  console.log(`Expected trading days: ${report.expected_trading_days}`);
  console.log(`Present: ${report.present}`);
  console.log(`Explained by holidays: ${explainedHolidays.length}`);
  console.log(`Unexplained gaps: ${missing.length}`);

  if (missing.length > 0) {
    console.log(`\nDates needing attention: ${missing.join(', ')}`);
    process.exitCode = 1; // non-zero so the Action run visibly shows "issues found"
  }
}

main().catch((err) => {
  console.error('Reconciliation failed:', err.message);
  process.exitCode = 1;
});
