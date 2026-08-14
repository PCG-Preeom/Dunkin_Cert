import { getSupabaseAdmin } from './lib/supabaseAdmin.js';
import { appendCommentToSheet } from './lib/sheetsWrite.js';

function formatCommentLine(author, text, createdAt) {
  const stamp = createdAt.toISOString().slice(0, 16).replace('T', ' ');
  return `[${stamp} UTC] ${author}: ${text}`;
}

// Not a scheduled function — a normal HTTP endpoint the dashboard (and the
// other app that also captures these complaints) calls directly when
// someone submits a comment. Writes a structured row into the shared
// `case_comments` table (case_id, author_name, comment_text, created_at) —
// that table is the single source of truth for comments across both apps.
export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON body' }), { status: 400 });
  }

  const caseId = String(body?.caseId || '').trim();
  const author = String(body?.author || '').trim();
  const text = String(body?.text || '').trim();
  if (!caseId || !author || !text) {
    return new Response(JSON.stringify({ ok: false, error: 'caseId, author, and text are all required' }), { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { data: caseRow, error: caseError } = await supabase
    .from('cases')
    .select('sheet_tab')
    .eq('case_id', caseId)
    .single();

  if (caseError || !caseRow) {
    return new Response(JSON.stringify({ ok: false, error: 'Case not found' }), { status: 404 });
  }

  const { data: inserted, error: insertError } = await supabase
    .from('case_comments')
    .insert({ case_id: caseId, author_name: author, comment_text: text, source: 'case_watch' })
    .select()
    .single();

  if (insertError) {
    return new Response(JSON.stringify({ ok: false, error: insertError.message }), { status: 500 });
  }

  // The sheet write happens after and its failure is reported but doesn't
  // roll back the comment — losing a comment entirely because the sheet
  // moved/changed would be worse than a comment that's in the DB but not
  // (yet) in the sheet.
  let sheetError = null;
  try {
    const line = formatCommentLine(author, text, new Date(inserted.created_at));
    await appendCommentToSheet({ tabName: caseRow.sheet_tab, caseId, commentLine: line });
  } catch (err) {
    sheetError = String(err?.message || err);
  }

  return new Response(JSON.stringify({ ok: true, comment: inserted, sheetError }), { status: 200 });
};
