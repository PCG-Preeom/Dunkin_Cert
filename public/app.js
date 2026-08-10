import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cfg = window.CASE_WATCH_CONFIG || {};
if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
  document.getElementById('syncStatus').textContent = 'config.js is missing — see README';
  throw new Error('Missing public/config.js — copy config.js.example and fill in your Supabase URL/anon key.');
}

const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const TIER_LABELS = {
  fyi: 'FYI',
  guest_contact: 'Guest Contact',
  second_escalation: 'Second Escalation',
  unknown: 'Unknown',
};

// First 3 letters of the month word are enough to recover the month even
// from sheet-tab typos like "Nove 2025" or "Janury 2024".
const MONTH_INDEX = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function tabSortKey(tab) {
  const match = tab.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!match) return -Infinity; // non-month tabs (e.g. "year Sum") sink to the bottom
  const monthIdx = MONTH_INDEX[match[1].slice(0, 3).toLowerCase()];
  if (monthIdx === undefined) return -Infinity;
  return Number(match[2]) * 12 + monthIdx;
}

// Complaint text now comes from pasted emails, which can contain "&", "<",
// ">" etc. — escape it so it renders as text instead of breaking the markup.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

const state = {
  cases: [],
  filter: 'all',
  search: '',
  month: 'all',
};

const caseListEl = document.getElementById('caseList');
const emptyStateEl = document.getElementById('emptyState');
const leaderboardEl = document.getElementById('leaderboardList');
const syncStatusEl = document.getElementById('syncStatus');
const monthFilterEl = document.getElementById('monthFilter');
const modalBackdropEl = document.getElementById('modalBackdrop');
const modalBodyEl = document.getElementById('modalBody');
const modalCloseEl = document.getElementById('modalClose');

let lastFocusedEl = null;

function timeAgo(iso) {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

async function loadSyncStatus() {
  const { data, error } = await supabase
    .from('sync_runs')
    .select('run_type, finished_at, error')
    .order('started_at', { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) {
    syncStatusEl.textContent = 'No sync runs yet';
    return;
  }

  const last = data[0];
  if (last.error) {
    syncStatusEl.textContent = `Last sync failed — ${timeAgo(last.finished_at)}`;
    syncStatusEl.className = 'sync-status stale';
  } else {
    syncStatusEl.textContent = `Synced ${timeAgo(last.finished_at)}`;
    syncStatusEl.className = 'sync-status ok';
  }
}

function populateMonthFilter() {
  const tabs = [...new Set(state.cases.map((c) => c.sheet_tab))].sort((a, b) => tabSortKey(b) - tabSortKey(a));
  for (const tab of tabs) {
    const opt = document.createElement('option');
    opt.value = tab;
    opt.textContent = tab;
    monthFilterEl.appendChild(opt);
  }
}

// Supabase/PostgREST caps a single select() at 1000 rows, and this table has
// more than that — page through in batches of 1000 until a page comes back
// short, which signals there's nothing left to fetch.
async function loadCases() {
  const pageSize = 1000;
  const all = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from('cases')
      .select('*')
      .order('severity_score', { ascending: false })
      .range(page * pageSize, page * pageSize + pageSize - 1);

    if (error) {
      caseListEl.innerHTML = `<p class="empty-state">Couldn't load cases: ${error.message}</p>`;
      return;
    }
    all.push(...data);
    if (data.length < pageSize) break;
  }

  state.cases = all;
  populateMonthFilter();
  renderAll();
}

function monthFiltered() {
  if (state.month === 'all') return state.cases;
  return state.cases.filter((c) => c.sheet_tab === state.month);
}

function renderAll() {
  renderLeaderboard();
  renderFilterCounts();
  renderCaseList();
}

function renderLeaderboard() {
  const byStore = new Map();
  for (const c of monthFiltered()) {
    const key = c.store_pc || 'Unknown';
    if (!byStore.has(key)) byStore.set(key, { count: 0, high: 0, medium: 0, low: 0 });
    const entry = byStore.get(key);
    entry.count += 1;
    entry[c.severity_label] += 1;
  }

  const ranked = [...byStore.entries()]
    .map(([pc, v]) => ({ pc, ...v, weighted: v.high * 3 + v.medium }))
    .sort((a, b) => b.weighted - a.weighted || b.count - a.count)
    .slice(0, 10);

  leaderboardEl.innerHTML = ranked
    .map((s, i) => {
      const pct = (n) => (s.count ? (n / s.count) * 100 : 0);
      return `
      <div class="store-card">
        <div class="rank">#${i + 1}</div>
        <div class="pc">PC ${escapeHtml(s.pc)}</div>
        <div class="store-bar" role="img" aria-label="${s.high} worst, ${s.medium} needs attention, ${s.low} good out of ${s.count} cases">
          <span class="seg high" style="width:${pct(s.high)}%"></span>
          <span class="seg medium" style="width:${pct(s.medium)}%"></span>
          <span class="seg low" style="width:${pct(s.low)}%"></span>
        </div>
        <div class="count"><strong>${s.count}</strong> case${s.count === 1 ? '' : 's'}</div>
      </div>`;
    })
    .join('');
}

function renderFilterCounts() {
  const scoped = monthFiltered();
  const counts = { all: scoped.length, high: 0, medium: 0, low: 0 };
  for (const c of scoped) counts[c.severity_label] = (counts[c.severity_label] || 0) + 1;
  document.querySelectorAll('.chip-count').forEach((el) => {
    const key = el.dataset.countFor;
    el.textContent = ` (${counts[key] || 0})`;
  });
}

function matchesFilter(c) {
  if (state.filter !== 'all' && c.severity_label !== state.filter) return false;
  if (!state.search) return true;
  const haystack = `${c.case_id} ${c.store_pc} ${c.customer_name} ${c.complaint_category}`.toLowerCase();
  return haystack.includes(state.search.toLowerCase());
}

function renderCaseList() {
  const visible = monthFiltered().filter(matchesFilter);
  emptyStateEl.hidden = visible.length > 0;

  caseListEl.innerHTML = visible
    .map((c) => {
      const amount = c.amount ? `$${Number(c.amount).toFixed(2)}` : null;
      const tierLabel = TIER_LABELS[c.case_tier] || c.case_tier;
      return `
      <div class="case-row" role="button" tabindex="0" data-case-id="${escapeHtml(c.case_id)}" aria-label="View details for case ${escapeHtml(c.case_id)}">
        <div class="meter-wrap" role="img" aria-label="Severity ${c.severity_score} of 100, ${c.severity_label}">
          <span class="meter-label">${c.severity_score}</span>
          <div class="meter-track">
            <div class="meter-fill ${c.severity_label}" style="width:${c.severity_score}%"></div>
          </div>
        </div>
        <div class="main">
          <div class="main-head">
            <span class="case-id">${escapeHtml(c.case_id)}</span>
            <span class="badge tier-${c.case_tier}">${escapeHtml(tierLabel)}</span>
            ${c.complaint_category ? `<span class="badge category">${escapeHtml(c.complaint_category)}</span>` : ''}
          </div>
          <div class="sub">${escapeHtml(c.customer_name || 'Unknown customer')}</div>
        </div>
        <div class="side">
          <div class="store">PC ${escapeHtml(c.store_pc || '—')}</div>
          <div>${escapeHtml(c.date_in_sent || 'No date logged')}</div>
          ${amount ? `<div class="amount">${amount}</div>` : ''}
        </div>
      </div>`;
    })
    .join('');
}

function detailRow(label, value) {
  if (!value) return '';
  return `<div class="modal-row"><span class="modal-row-label">${escapeHtml(label)}</span><span class="modal-row-value">${escapeHtml(value)}</span></div>`;
}

// Gmail's plain-text export leaves a lot of blank lines (between header
// fields, around signature blocks, etc.) — collapse runs of them down to a
// single blank line so the modal isn't mostly whitespace.
function formatLongText(text) {
  const collapsed = String(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return escapeHtml(collapsed).replace(/\n/g, '<br>');
}

function openModal(c) {
  const amount = c.amount ? `$${Number(c.amount).toFixed(2)}` : null;
  const tierLabel = TIER_LABELS[c.case_tier] || c.case_tier;

  modalBodyEl.innerHTML = `
    <div class="modal-head">
      <span class="case-id">${escapeHtml(c.case_id)}</span>
      <span class="badge tier-${c.case_tier}">${escapeHtml(tierLabel)}</span>
      ${c.complaint_category ? `<span class="badge category">${escapeHtml(c.complaint_category)}</span>` : ''}
    </div>
    <h2 id="modalTitle" class="modal-title">${escapeHtml(c.customer_name || 'Unknown customer')}</h2>
    <div class="meter-wrap modal-meter" role="img" aria-label="Severity ${c.severity_score} of 100, ${c.severity_label}">
      <span class="meter-label">${c.severity_score} / 100 — ${escapeHtml(c.severity_label)}</span>
      <div class="meter-track">
        <div class="meter-fill ${c.severity_label}" style="width:${c.severity_score}%"></div>
      </div>
    </div>

    ${detailRow('Store', c.store_pc ? `PC ${c.store_pc}` : null)}
    ${detailRow('Date', c.date_in_sent)}
    ${detailRow('Amount', amount)}
    ${detailRow('Email', c.email)}
    ${detailRow('Phone', c.phone)}
    ${detailRow('Month', c.sheet_tab)}

    <div class="modal-section">
      <h3>Complaint</h3>
      <p class="modal-text">${c.customer_complaint ? formatLongText(c.customer_complaint) : 'No complaint text recorded yet.'}</p>
    </div>

    ${c.comments ? `<div class="modal-section"><h3>Comments</h3><p class="modal-text">${formatLongText(c.comments)}</p></div>` : ''}

    <div class="modal-section">
      <h3>Raw case label</h3>
      <p class="modal-text modal-raw">${escapeHtml(c.raw_label)}</p>
    </div>
  `;

  lastFocusedEl = document.activeElement;
  modalBackdropEl.hidden = false;
  modalCloseEl.focus();
}

function closeModal() {
  modalBackdropEl.hidden = true;
  modalBodyEl.innerHTML = '';
  if (lastFocusedEl) lastFocusedEl.focus();
}

caseListEl.addEventListener('click', (e) => {
  const row = e.target.closest('.case-row');
  if (!row) return;
  const c = state.cases.find((x) => x.case_id === row.dataset.caseId);
  if (c) openModal(c);
});

caseListEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.case-row');
  if (!row) return;
  e.preventDefault();
  const c = state.cases.find((x) => x.case_id === row.dataset.caseId);
  if (c) openModal(c);
});

modalCloseEl.addEventListener('click', closeModal);

modalBackdropEl.addEventListener('click', (e) => {
  if (e.target === modalBackdropEl) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalBackdropEl.hidden) closeModal();
});

document.getElementById('filterChips').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  document.querySelectorAll('.chip').forEach((c) => {
    c.classList.remove('active');
    c.setAttribute('aria-pressed', 'false');
  });
  btn.classList.add('active');
  btn.setAttribute('aria-pressed', 'true');
  state.filter = btn.dataset.filter;
  renderCaseList();
});

document.getElementById('searchInput').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderCaseList();
});

monthFilterEl.addEventListener('change', (e) => {
  state.month = e.target.value;
  renderAll();
});

loadSyncStatus();
loadCases();
