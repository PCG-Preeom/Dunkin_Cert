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

const SEVERITY_LABELS = {
  worst: 'Worst',
  concerning: 'Concerning',
  attention: 'Needs attention',
  minor: 'Minor',
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
let currentCaseId = null;

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
    if (!byStore.has(key)) byStore.set(key, { count: 0, worst: 0, concerning: 0, attention: 0, minor: 0 });
    const entry = byStore.get(key);
    entry.count += 1;
    entry[c.severity_label] += 1;
  }

  const ranked = [...byStore.entries()]
    .map(([pc, v]) => ({ pc, ...v, weighted: v.worst * 4 + v.concerning * 2 + v.attention }))
    .sort((a, b) => b.weighted - a.weighted || b.count - a.count)
    .slice(0, 10);

  leaderboardEl.innerHTML = ranked
    .map((s, i) => {
      const pct = (n) => (s.count ? (n / s.count) * 100 : 0);
      return `
      <div class="store-card">
        <div class="rank">#${i + 1}</div>
        <div class="pc">PC ${escapeHtml(s.pc)}</div>
        <div class="store-bar" role="img" aria-label="${s.worst} worst, ${s.concerning} concerning, ${s.attention} needs attention, ${s.minor} minor out of ${s.count} cases">
          <span class="seg worst" style="width:${pct(s.worst)}%"></span>
          <span class="seg concerning" style="width:${pct(s.concerning)}%"></span>
          <span class="seg attention" style="width:${pct(s.attention)}%"></span>
          <span class="seg minor" style="width:${pct(s.minor)}%"></span>
        </div>
        <div class="count"><strong>${s.count}</strong> case${s.count === 1 ? '' : 's'}</div>
      </div>`;
    })
    .join('');
}

function renderFilterCounts() {
  const scoped = monthFiltered();
  const counts = { all: scoped.length, worst: 0, concerning: 0, attention: 0, minor: 0 };
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

// These rows were mostly pasted straight from Gmail's web UI, which drags
// along on-screen chrome that isn't part of the actual message: the
// "DBI Case # ..." line (already shown in the badges above), then
// External / Inbox / "Summarize this email" / sender / timestamp / "to me"
// — all before the real message text starts. Strip that block out.
function stripEmailChrome(text) {
  const lines = String(text).split('\n');
  if (lines[0] && /^DBI Case #/i.test(lines[0].trim())) lines.shift();

  const toLineIdx = lines.findIndex((l) => /^to\s/i.test(l.trim()));
  if (toLineIdx !== -1 && toLineIdx < 10) {
    lines.splice(0, toLineIdx + 1);
  }
  return lines.join('\n');
}

// Gmail's export also leaves a lot of blank lines (between header fields,
// around signature blocks, etc.) — collapse runs of them down to a single
// blank line so the modal isn't mostly whitespace.
function formatLongText(text) {
  const collapsed = stripEmailChrome(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return escapeHtml(collapsed).replace(/\n/g, '<br>');
}

function renderCommentItem(comment) {
  const when = new Date(comment.created_at);
  const stamp = Number.isNaN(when.getTime())
    ? ''
    : when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `
    <div class="comment-item">
      <div class="comment-meta">
        <span class="comment-author">${escapeHtml(comment.author_name)}</span>
        <span class="comment-time">${escapeHtml(stamp)}</span>
      </div>
      <div class="comment-text">${escapeHtml(comment.comment_text)}</div>
    </div>`;
}

// Comments live in their own table (case_id, author_name, comment_text,
// created_at) shared with the other app that also captures these
// complaints — fetched separately from the case list since it's per-case
// detail, not something worth loading for every row up front.
async function loadAndRenderComments(caseId) {
  const { data, error } = await supabase
    .from('case_comments')
    .select('*')
    .eq('case_id', caseId)
    .order('created_at', { ascending: true });

  // The modal may have closed, or moved on to a different case, while this
  // fetch was in flight — don't clobber whatever's showing now.
  if (currentCaseId !== caseId) return;
  const listEl = document.getElementById('commentsList');
  if (!listEl) return;

  if (error) {
    listEl.innerHTML = `<p class="modal-text">Couldn't load comments: ${escapeHtml(error.message)}</p>`;
    return;
  }
  listEl.innerHTML = data.length ? data.map(renderCommentItem).join('') : '<p class="modal-text">No comments yet.</p>';
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
      <span class="meter-label">${c.severity_score} / 100 — ${escapeHtml(SEVERITY_LABELS[c.severity_label] || c.severity_label)}</span>
      <div class="meter-track">
        <div class="meter-fill ${c.severity_label}" style="width:${c.severity_score}%"></div>
      </div>
    </div>

    ${detailRow('Store', c.store_pc ? `PC ${c.store_pc}` : null)}
    ${detailRow('Date', c.date_in_sent)}
    ${detailRow('Time', c.incident_time)}
    ${detailRow('Amount', amount)}
    ${detailRow('Email', c.email)}
    ${detailRow('Phone', c.phone)}
    ${detailRow('Month', c.sheet_tab)}

    <div class="modal-section">
      <h3>Complaint</h3>
      <p class="modal-text">${c.customer_complaint ? formatLongText(c.customer_complaint) : 'No complaint text recorded yet.'}</p>
    </div>

    <div class="modal-section">
      <h3>Comments</h3>
      <div class="comments-list" id="commentsList"><p class="modal-text">Loading comments…</p></div>
      <form class="comment-form" id="commentForm">
        <input type="text" id="commentAuthor" placeholder="Your name" value="${escapeHtml(localStorage.getItem('caseWatchCommenterName') || '')}" required />
        <textarea id="commentText" placeholder="Add a comment…" required></textarea>
        <div class="comment-form-footer">
          <button type="submit" id="commentSubmit">Post comment</button>
          <span class="comment-status" id="commentStatus"></span>
        </div>
      </form>
    </div>

    ${c.comments ? `<div class="modal-section"><h3>Notes from sheet</h3><p class="modal-text">${formatLongText(c.comments)}</p></div>` : ''}

    <div class="modal-section">
      <h3>Raw case label</h3>
      <p class="modal-text modal-raw">${escapeHtml(c.raw_label)}</p>
    </div>
  `;

  currentCaseId = c.case_id;
  lastFocusedEl = document.activeElement;
  modalBackdropEl.hidden = false;
  modalCloseEl.focus();

  loadAndRenderComments(c.case_id);
}

function closeModal() {
  modalBackdropEl.hidden = true;
  modalBodyEl.innerHTML = '';
  currentCaseId = null;
  if (lastFocusedEl) lastFocusedEl.focus();
}

modalBodyEl.addEventListener('submit', async (e) => {
  const form = e.target.closest('#commentForm');
  if (!form) return;
  e.preventDefault();
  if (!currentCaseId) return;

  const authorEl = document.getElementById('commentAuthor');
  const textEl = document.getElementById('commentText');
  const submitEl = document.getElementById('commentSubmit');
  const statusEl = document.getElementById('commentStatus');
  const listEl = document.getElementById('commentsList');

  const author = authorEl.value.trim();
  const text = textEl.value.trim();
  if (!author || !text) return;

  submitEl.disabled = true;
  statusEl.textContent = 'Posting…';
  statusEl.className = 'comment-status';

  try {
    const res = await fetch('/.netlify/functions/add-comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseId: currentCaseId, author, text }),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error || 'Failed to post comment');

    localStorage.setItem('caseWatchCommenterName', author);

    if (listEl) {
      if (!listEl.querySelector('.comment-item')) listEl.innerHTML = '';
      listEl.insertAdjacentHTML('beforeend', renderCommentItem(result.comment));
    }
    textEl.value = '';
    statusEl.textContent = result.sheetError ? 'Saved (sheet update failed — check logs)' : 'Posted';
    statusEl.className = result.sheetError ? 'comment-status warn' : 'comment-status ok';
  } catch (err) {
    statusEl.textContent = err.message || 'Failed to post comment';
    statusEl.className = 'comment-status error';
  } finally {
    submitEl.disabled = false;
  }
});

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
