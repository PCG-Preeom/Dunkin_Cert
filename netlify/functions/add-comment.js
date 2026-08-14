import { getSupabaseAdmin } from './lib/supabaseAdmin.js';
import { appendCommentToSheet } from './lib/sheetsWrite.js';

function formatCommentLine(author, text) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return `[${stamp} UTC] ${author}: ${text}`;
}

// Not a scheduled function — a normal HTTP endpoint the dashboard calls
// directly when someone submits a comment from the case detail modal.
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
  const { data: existing, error: fetchError } = await supabase
    .from('cases')
    .select('comments, sheet_tab')
    .eq('case_id', caseId)
    .single();

  if (fetchError || !existing) {
    return new Response(JSON.stringify({ ok: false, error: 'Case not found' }), { status: 404 });
  }

  const line = formatCommentLine(author, text);
  const newComments = existing.comments ? `${existing.comments}\n${line}` : line;

  // Supabase is the source of truth for the dashboard — write it first and
  // treat that as the success condition. The sheet write happens after and
  // its failure is reported but doesn't roll back the comment, since losing
  // a comment entirely because the sheet moved/changed would be worse than
  // a comment that's in the DB but not (yet) in the sheet.
  const { error: updateError } = await supabase
    .from('cases')
    .update({ comments: newComments })
    .eq('case_id', caseId);

  if (updateError) {
    return new Response(JSON.stringify({ ok: false, error: updateError.message }), { status: 500 });
  }

  let sheetError = null;
  try {
    await appendCommentToSheet({ tabName: existing.sheet_tab, caseId, commentLine: line });
  } catch (err) {
    sheetError = String(err?.message || err);
  }

  return new Response(JSON.stringify({ ok: true, comments: newComments, sheetError }), { status: 200 });
};
