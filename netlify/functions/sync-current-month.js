import { fetchTabRows, currentMonthTabName } from './lib/sheets.js';
import { parseCaseRow, dedupeByCaseId } from './lib/parseCase.js';
import { getSupabaseAdmin } from './lib/supabaseAdmin.js';

export default async () => {
  const startedAt = new Date().toISOString();
  const tab = currentMonthTabName();
  const supabase = getSupabaseAdmin();

  try {
    const rows = await fetchTabRows(tab);
    const parsed = dedupeByCaseId(rows.map((r) => parseCaseRow(r, tab)).filter(Boolean));

    if (parsed.length > 0) {
      const { error } = await supabase.from('cases').upsert(parsed, { onConflict: 'case_id' });
      if (error) throw error;
    }

    await supabase.from('sync_runs').insert({
      run_type: 'current_month',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      rows_synced: parsed.length,
      tabs_synced: [tab],
    });

    return new Response(JSON.stringify({ ok: true, tab, rows: parsed.length }), { status: 200 });
  } catch (err) {
    await supabase.from('sync_runs').insert({
      run_type: 'current_month',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      error: String(err?.message || err),
    });
    return new Response(JSON.stringify({ ok: false, error: String(err?.message || err) }), { status: 500 });
  }
};

export const config = { schedule: '@hourly' };
