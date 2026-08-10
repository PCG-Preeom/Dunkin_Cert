/**
 * Case Watch — auto-fill Customer Complaint column from Gmail.
 *
 * Install: open the sheet -> Extensions -> Apps Script -> paste this whole
 * file in (replacing the default Code.gs content) -> Save -> reload the
 * sheet. A "Case Watch" menu appears -> "Fill complaints from Gmail".
 *
 * First run will prompt for Gmail + Sheets permission — approve it (it's
 * your own account being authorized, not a service account, so this only
 * ever sees what you can already see in Gmail).
 *
 * Runs on the currently ACTIVE tab only, so switch to whichever month
 * you're working on before running it. Skips any row that already has
 * complaint text, so it's safe to re-run repeatedly as new rows show up.
 */

const CASE_COLUMN = 1;       // A
const COMPLAINT_COLUMN = 3;  // C
const FIRST_DATA_ROW = 4;    // matches the sheet's header-on-row-3 layout

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Case Watch')
    .addItem('Fill complaints from Gmail', 'fillComplaintsFromGmail')
    .addToUi();
}

function extractCaseId(raw) {
  const match = String(raw || '').match(/DBI Case #\s*\(?([A-Z0-9]+)\)?/i);
  return match ? match[1].toUpperCase() : null;
}

function fillComplaintsFromGmail() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const lastRow = sheet.getLastRow();
  console.log('Sheet: ' + sheet.getName() + ', last row: ' + lastRow);
  if (lastRow < FIRST_DATA_ROW) {
    console.log('Nothing to do — sheet has no data rows.');
    return;
  }

  const numRows = lastRow - FIRST_DATA_ROW + 1;
  const caseValues = sheet.getRange(FIRST_DATA_ROW, CASE_COLUMN, numRows, 1).getValues();
  const complaintValues = sheet.getRange(FIRST_DATA_ROW, COMPLAINT_COLUMN, numRows, 1).getValues();

  let filled = 0;
  let skippedHadText = 0;
  let skippedNoMatch = 0;
  let skippedNoCaseId = 0;

  for (let i = 0; i < numRows; i++) {
    const rowNum = FIRST_DATA_ROW + i;
    const existing = String(complaintValues[i][0] || '').trim();
    if (existing) { skippedHadText++; continue; } // already has text — leave it alone

    const caseId = extractCaseId(caseValues[i][0]);
    if (!caseId) { skippedNoCaseId++; continue; } // blank/header/divider row

    const threads = GmailApp.search('"' + caseId + '"', 0, 1);
    if (threads.length === 0) {
      console.log('Row ' + rowNum + ' (' + caseId + '): no Gmail thread found');
      skippedNoMatch++;
      continue;
    }

    const messages = threads[0].getMessages();
    const body = messages[messages.length - 1].getPlainBody();
    sheet.getRange(rowNum, COMPLAINT_COLUMN).setValue(body);
    console.log('Row ' + rowNum + ' (' + caseId + '): filled');
    filled++;

    // Gmail search has a per-day quota — pace it slightly to be safe on
    // large tabs.
    if (filled % 50 === 0) Utilities.sleep(1000);
  }

  const summary = 'Done: filled ' + filled + ' row(s). ' +
    skippedHadText + ' already had text, ' +
    skippedNoMatch + ' had no matching Gmail thread, ' +
    skippedNoCaseId + ' had no case ID.';
  console.log(summary);

  // getUi() only works when triggered from the sheet's own menu, not when
  // run directly from the Apps Script editor — so don't let it blow up
  // the whole run just because there's no dialog to show it in.
  try {
    SpreadsheetApp.getUi().alert(summary);
  } catch (e) {
    console.log('(no UI available to show the summary popup — check this log instead)');
  }
}
