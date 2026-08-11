import { google } from 'googleapis';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY env vars');
  }
  return new google.auth.JWT(email, undefined, key, [
    'https://www.googleapis.com/auth/spreadsheets.readonly',
  ]);
}

// Tab name convention seen in the sheet: "August 2026", "July 2026", etc.
export function currentMonthTabName(date = new Date()) {
  return `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
}

export async function listTabNames() {
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });
  const res = await sheets.spreadsheets.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
  });
  return (res.data.sheets || []).map((s) => s.properties.title);
}

// Accepted header text per field — matched case/whitespace-insensitively so
// small variations ("Date In Sent" vs "Date Sent") still resolve, and listed
// in priority order in case a tab has more than one plausible match.
const HEADER_ALIASES = {
  Case: ['case'],
  CustomerName: ['customer name', 'name'],
  CustomerComplaint: ['customer complaint', 'complaint'],
  DateInSent: ['date in sent', 'date sent', 'date'],
  Amount: ['amount'],
  Email: ['email'],
  Phone: ['phone'],
  Comments: ['comments', 'comment'],
};
// Strip punctuation like "/" and "#" too — real headers include "Date in/
// Sent" and "Phone#", which otherwise never match a plain-word alias.
const normalizeHeader = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

// Row 3 in the sheet is the header (Case, Customer Name, ...), data starts row 4.
// Column order isn't assumed to be fixed A-H — some month tabs have an extra or
// reordered column (confirmed directly: a tab with an inserted column shifted
// every field after it, so Email came back holding a dollar amount and Phone
// held an email address). Reading the header row and mapping by name instead
// of position means a reordered/inserted column can't silently scramble data.
export async function fetchTabRows(tabName) {
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  // One batchGet instead of two separate .get() calls — fetching the header
  // and data ranges separately doubled our Sheets API request count and
  // tripped the per-minute read quota when resyncing all ~40 tabs back to
  // back.
  const batchRes = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    ranges: [`'${tabName}'!A3:Z3`, `'${tabName}'!A4:Z2000`],
  });
  const [headerRange, dataRange] = batchRes.data.valueRanges;

  const headerRow = (headerRange.values || [[]])[0] || [];
  const normalizedHeaders = headerRow.map(normalizeHeader);

  // Build field -> column index by matching against HEADER_ALIASES. Falls back
  // to the original fixed A-H position for any field whose header can't be
  // found at all, so a totally blank/malformed header row doesn't stop the
  // sync outright — but logs it, since that fallback is the exact scenario
  // that caused this bug in the first place.
  const FALLBACK_INDEX = { Case: 0, CustomerName: 1, CustomerComplaint: 2, DateInSent: 3, Amount: 4, Email: 5, Phone: 6, Comments: 7 };
  const colIndex = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = normalizedHeaders.findIndex((h) => aliases.includes(h));
    if (idx === -1) {
      console.warn(`[sheets] "${tabName}": couldn't find a header for ${field} (saw: ${headerRow.join(' | ')}) — falling back to column ${FALLBACK_INDEX[field]}`);
      colIndex[field] = FALLBACK_INDEX[field];
    } else {
      colIndex[field] = idx;
    }
  }

  const rows = dataRange.values || [];
  return rows
    .filter((r) => r && r[colIndex.Case]) // skip fully blank rows
    .map((r) => ({
      Case: r[colIndex.Case],
      CustomerName: r[colIndex.CustomerName],
      CustomerComplaint: r[colIndex.CustomerComplaint],
      DateInSent: r[colIndex.DateInSent],
      Amount: r[colIndex.Amount],
      Email: r[colIndex.Email],
      Phone: r[colIndex.Phone],
      Comments: r[colIndex.Comments],
    }));
}
