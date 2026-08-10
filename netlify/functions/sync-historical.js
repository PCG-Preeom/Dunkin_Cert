import { fetchTabRows, listTabNames, currentMonthTabName } from './lib/sheets.js';
import { parseCaseRow, dedupeByCaseId } from './lib/parseCase.js';
import { getSupabaseAdmin } from './lib/supabaseAdmin.js';

// Only touch tabs that look like "August 2026" — skips any other sheet
// (notes tabs, templates, etc.) you might add later.
const MONTH_TAB_RE = /^[A-Za-z]+ \d{4}$/;

export default async () => {
  const startedAt = new Date().toISOString();
  const supabase = getSupabaseAdmin();
  const currentTab = currentMonthTabName();

  try {
    const allTabs = await listTabNames();
    const historicalTabs = allTabs.filter((t) => t !== currentTab && MONTH_TAB_RE.test(t));

    let totalRows = 0;
    for (const tab of historicalTabs) {
      const rows = await fetchTabRows(tab);
      const parsed = dedupeByCaseId(rows.map((r) => parseCaseRow(r, tab)).filter(Boolean));
      if (parsed.length > 0) {
        const { error } = await supabase.from('cases').upsert(parsed, { onConflict: 'case_id' });
        if (error) throw error;
        totalRows += parsed.length;
      }
    }

    await supabase.from('sync_runs').insert({
      run_type: 'historical',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      rows_synced: totalRows,
      tabs_synced: historicalTabs,
    });

    return new Response(JSON.stringify({ ok: true, tabs: historicalTabs, rows: totalRows }), { status: 200 });
  } catch (err) {
    await supabase.from('sync_runs').insert({
      run_type: 'historical',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      error: String(err?.message || err),
    });
    return new Response(JSON.stringify({ ok: false, error: String(err?.message || err) }), { status: 500 });
  }
};

export const config = { schedule: '@weekly' };
