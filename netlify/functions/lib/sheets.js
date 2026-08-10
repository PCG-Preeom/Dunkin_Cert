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

// Row 3 in the sheet is the header (Case, Customer Name, ...), data starts row 4.
export async function fetchTabRows(tabName) {
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });
  const range = `'${tabName}'!A4:H2000`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range,
  });
  const rows = res.data.values || [];
  return rows
    .filter((r) => r && r[0]) // skip fully blank rows
    .map((r) => ({
      Case: r[0],
      CustomerName: r[1],
      CustomerComplaint: r[2],
      DateInSent: r[3],
      Amount: r[4],
      Email: r[5],
      Phone: r[6],
      Comments: r[7],
    }));
}
