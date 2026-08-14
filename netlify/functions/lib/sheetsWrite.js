import { google } from 'googleapis';
import { extractCaseId } from './parseCase.js';

// Separate from the read-only auth in sheets.js — this needs the full
// spreadsheets scope (read/write), and the sheet must be shared with this
// service account as Editor, not just Viewer, for writes to succeed.
function getWriteAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY env vars');
  }
  return new google.auth.JWT(email, undefined, key, [
    'https://www.googleapis.com/auth/spreadsheets',
  ]);
}

const normalizeHeader = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

function columnIndexToLetter(idx) {
  let n = idx + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

// Finds the case's row within its tab (by scanning the Case column, same
// way the sync reads it) and appends commentLine to whatever's already in
// that row's Comments cell — never overwrites, since there may already be
// a note there from before this feature existed.
export async function appendCommentToSheet({ tabName, caseId, commentLine }) {
  const sheets = google.sheets({ version: 'v4', auth: getWriteAuth() });
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName}'!A3:Z3`,
  });
  const headerRow = (headerRes.data.values || [[]])[0] || [];
  const normalizedHeaders = headerRow.map(normalizeHeader);
  const caseColIdx = normalizedHeaders.findIndex((h) => h === 'case');
  const commentsColIdx = normalizedHeaders.findIndex((h) => ['comments', 'comment'].includes(h));
  if (caseColIdx === -1 || commentsColIdx === -1) {
    throw new Error(`Couldn't find Case/Comments header columns in tab "${tabName}" (saw: ${headerRow.join(' | ')})`);
  }

  const caseColLetter = columnIndexToLetter(caseColIdx);
  const commentsColLetter = columnIndexToLetter(commentsColIdx);

  const caseColRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName}'!${caseColLetter}4:${caseColLetter}2000`,
  });
  const caseValues = caseColRes.data.values || [];
  const rowOffset = caseValues.findIndex((r) => extractCaseId(r[0]) === caseId);
  if (rowOffset === -1) {
    throw new Error(`Case ${caseId} not found in tab "${tabName}" — it may have moved or been edited since the last sync`);
  }
  const rowNumber = 4 + rowOffset;
  const commentsRange = `'${tabName}'!${commentsColLetter}${rowNumber}`;

  const currentRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: commentsRange });
  const currentValue = (currentRes.data.values || [[]])[0]?.[0] || '';
  const newValue = currentValue ? `${currentValue}\n${commentLine}` : commentLine;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: commentsRange,
    valueInputOption: 'RAW',
    requestBody: { values: [[newValue]] },
  });
}
