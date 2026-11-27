// reconcile.js
// Checks that every trading day in the last N calendar days has a bhavcopy file in data/ or historic_data/.
// Trading days = weekdays minus NSE holidays, plus special weekend sessions (both from nse_holidays.json).
// Today (IST) is not checked, because NSE publishes the file only in the evening.
//
// Works entirely offline — it no longer calls NSE's holiday API (that call needed the same homepage
// cookie that NSE now refuses to GitHub's servers).
//
// Usage: node reconcile.js [lookbackDays=45]
// Exit code 1 if any trading day is missing, so the workflow run shows red.

const fs = require('fs');
const path = require('path');

const DATA_DIRS = ['data', 'historic_data'];
const OLD_FORMAT_RE = /^cm(\d{2})([A-Z]{3})(\d{4})bhav\.csv(\.zip)?$/;
const NEW_FORMAT_RE = /^sec_bhavdata_full_(\d{2})(\d{2})(\d{4})\.csv$/;
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const pad = (n) => String(n).padStart(2, '0');
const isoUTC = (dt) => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;

function collectLocalDates() {
  const dates = new Set();
  for (const dir of DATA_DIRS) {
    const dirPath = path.join(__dirname, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const file of fs.readdirSync(dirPath)) {
      let m = file.match(NEW_FORMAT_RE);
      if (m) { dates.add(`${m[3]}-${m[2]}-${m[1]}`); continue; }
      m = file.match(OLD_FORMAT_RE);
      if (m && MONTHS[m[2]]) dates.add(`${m[3]}-${pad(MONTHS[m[2]])}-${m[1]}`);
    }
  }
  return dates;
}

function loadCalendar() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'nse_holidays.json'), 'utf8'));
  return {
    byYear: raw.holidays || {},
    special: new Set(raw.special_sessions || []),
    // sessions NSE never published under the standard file name — reported, but not counted as gaps
    unavailable: new Set(Object.keys(raw.unavailable_sessions || {})),
  };
}

function main() {
  const lookbackDays = Number(process.argv[2]) || 45;
  const now = process.env.FAKE_NOW ? new Date(process.env.FAKE_NOW) : new Date();
  const istToday = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const end = new Date(Date.UTC(istToday.getUTCFullYear(), istToday.getUTCMonth(), istToday.getUTCDate() - 1));
  const start = new Date(end.getTime() - (lookbackDays - 1) * 86400000);

  const { byYear, special, unavailable } = loadCalendar();
  const holidays = new Set(Object.values(byYear).flat());
  const local = collectLocalDates();

  const missing = [];
  const explained = [];
  const knownUnavailable = [];
  let expected = 0;
  const yearsWithoutList = new Set();
  for (let dt = new Date(start); dt <= end; dt = new Date(dt.getTime() + 86400000)) {
    const d = isoUTC(dt);
    const dow = dt.getUTCDay();
    const isWeekend = dow === 0 || dow === 6;
    if (!byYear[d.slice(0, 4)]) yearsWithoutList.add(d.slice(0, 4));
    if (isWeekend && !special.has(d)) continue;
    if (!isWeekend && holidays.has(d)) { explained.push(d); continue; }
    expected++;
    if (local.has(d)) continue;
    if (unavailable.has(d)) knownUnavailable.push(d);
    else missing.push(d);
  }

  const report = {
    generated_at: now.toISOString(),
    range: { from: isoUTC(start), to: isoUTC(end) },
    expected_trading_days: expected,
    present: expected - missing.length - knownUnavailable.length,
    explained_holidays: explained,
    known_unavailable: knownUnavailable,
    unexplained_gaps: missing,
  };
  fs.writeFileSync(path.join(__dirname, 'reconciliation_report.json'), JSON.stringify(report, null, 2) + '\n');

  console.log(`Checked ${report.range.from} .. ${report.range.to} (IST)`);
  console.log(`Expected trading days: ${expected} | present: ${report.present} | holidays: ${explained.length}`);
  if (yearsWithoutList.size) {
    console.warn(`WARNING: nse_holidays.json has no holiday list for ${[...yearsWithoutList].join(', ')} — add it.`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### Reconciliation (${report.range.from} .. ${report.range.to})\n- Missing trading days: ${missing.join(', ') || 'none'}\n`);
  }
  if (missing.length) {
    console.error(`Missing trading days: ${missing.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('No gaps.');
  }
}

main();
