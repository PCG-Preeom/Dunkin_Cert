// Parses rows from the "CC Gift card Reinbursment" sheet into structured
// case records, and derives a severity score/label since the sheet itself
// has no explicit rating column.
//
// The Case column looks like one of:
//   "DBI Case # CCC11087978 - FYI Guest Contact: Taste - PC # 354865-DD"
//   "DBI Case # (CCC11076736) - Guest Contact: Out of Stock Item - PC # (351050-DD)"
//   "DBI Case # CCC10954000 - Second Escalation - Unresolved Guest Issue - PC # ..."

const TIER_PATTERNS = [
  { tier: 'second_escalation', regex: /second escalation/i },
  { tier: 'fyi', regex: /FYI guest contact/i },
  { tier: 'guest_contact', regex: /guest contact/i },
];

export function extractCaseId(raw) {
  const match = String(raw || '').match(/DBI Case #\s*\(?([A-Z0-9]+)\)?/i);
  return match ? match[1].toUpperCase() : null;
}

export function extractStorePc(raw) {
  // Grabs the digits right after "PC #", ignoring an optional "(" and any
  // trailing "-DD" style suffix.
  const match = String(raw || '').match(/PC\s*#\s*\(?(\d+)/i);
  return match ? match[1] : null;
}

export function extractTier(raw) {
  const text = String(raw || '');
  for (const { tier, regex } of TIER_PATTERNS) {
    if (regex.test(text)) return tier;
  }
  return 'unknown';
}

export function extractComplaintCategory(raw) {
  // Text between the tier's colon and " - PC", e.g. "Taste", "Order Accuracy".
  // Some rows have an extra dash right after the colon (e.g. "Contact: - Taste - PC"),
  // so an optional leading "- " is skipped before capturing the category.
  const match = String(raw || '').match(/:\s*-?\s*([^-]+?)\s*-\s*PC/i);
  return match ? match[1].trim() : null;
}

export function normalizeDate(value) {
  if (!value) return null;
  const parts = String(value).split('/');
  if (parts.length === 3) {
    const [m, d, yRaw] = parts;
    // Some rows use a 2-digit year (e.g. "5/1/26") — treat as 2000s.
    const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
    const yNum = Number(y);
    const mNum = Number(m);
    const dNum = Number(d);
    if (!/^\d{4}$/.test(y)) return null;
    // Round-trip through Date to catch invalid combos (Feb 30, Feb 29 on a
    // non-leap year, etc.) that a plain 1-31/1-12 range check would miss.
    const check = new Date(Date.UTC(yNum, mNum - 1, dNum));
    if (
      check.getUTCFullYear() !== yNum ||
      check.getUTCMonth() !== mNum - 1 ||
      check.getUTCDate() !== dNum
    ) {
      return null;
    }
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null; // unrecognized format — leave it out rather than guess
}

export function parseAmount(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// These push a case up regardless of its escalation tier — a "FYI" case that
// mentions a lawyer or a hospital visit shouldn't stay buried just because
// nobody re-categorized it in the sheet. Matched case-insensitively against
// the actual complaint text (when there is any).
const ESCALATION_KEYWORDS = [
  'lawyer', 'attorney', 'legal action', 'lawsuit', 'sue', 'health department',
  'corporate office', 'news station', 'social media', 'never coming back',
  'boycott', 'better business bureau', 'bbb',
];

const HEALTH_SAFETY_KEYWORDS = [
  'mold', 'sick', 'illness', 'allergic', 'allergy', 'hospital',
  'injur', 'foreign object', 'hair in', 'bug in', 'insect', 'roach',
  'cockroach', 'contamin', 'food poison', 'burned', 'scald', 'blood',
  'glass in',
];

const CONDUCT_KEYWORDS = [
  'rude', 'yelled', 'screamed', 'discriminat', 'racist', 'racial',
  'unprofessional', 'curse', 'hung up on', 'disrespect',
  'threatened', 'harass',
];

// Word-boundary match on the START of each keyword only (some, like "injur",
// are deliberately partial so they also catch "injury"/"injured") — a plain
// substring check would false-positive constantly, e.g. "sue" inside
// "issue", which shows up in nearly every one of these complaint emails.
function textHasAny(text, keywords) {
  const lower = String(text || '').toLowerCase();
  return keywords.some((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(lower));
}

// Escalation tier is the strongest tier-based signal, and (absent any
// keyword override below) it caps how severe a case can be: only an actual
// Second Escalation reaches "worst" on tier alone. A filled-in Amount
// (reimbursement went out) or Comments (manual intervention) still raise the
// score within that cap.
//
// But the complaint text itself can override that cap — legal/escalation
// threats, health & safety issues, and serious conduct complaints all raise
// a floor under the score, because a "FYI" case mentioning a lawyer is not
// actually minor just because nobody re-tagged it.
export function computeSeverity({ tier, amount, comments, complaintText }) {
  let score = 0;
  if (tier === 'second_escalation') score += 60;
  else if (tier === 'guest_contact') score += 25;
  else if (tier === 'fyi') score += 10;

  if (amount && amount > 0) score += 15;
  if (comments && String(comments).trim().length > 0) score += 10;

  if (tier !== 'second_escalation') score = Math.min(score, 74);

  let floor = 0;
  if (complaintText) {
    if (textHasAny(complaintText, ESCALATION_KEYWORDS)) {
      score += 35;
      floor = Math.max(floor, 75);
    }
    if (textHasAny(complaintText, HEALTH_SAFETY_KEYWORDS)) {
      score += 30;
      floor = Math.max(floor, 50);
    }
    if (textHasAny(complaintText, CONDUCT_KEYWORDS)) {
      score += 20;
      floor = Math.max(floor, 25);
    }
  }

  score = Math.max(score, floor);
  score = Math.min(score, 100);

  let label = 'minor';
  if (score >= 75) label = 'worst';
  else if (score >= 50) label = 'concerning';
  else if (score >= 25) label = 'attention';

  return { score, label };
}

// Some tabs have the same case entered twice (a data-entry duplicate, not a
// real second case). Supabase's upsert fails outright if the same case_id
// appears twice in one batch, so keep only the last occurrence — whichever
// row is lower in the sheet is treated as the most current one.
export function dedupeByCaseId(cases) {
  const byId = new Map();
  for (const c of cases) byId.set(c.case_id, c);
  return [...byId.values()];
}

// row = { Case, CustomerName, CustomerComplaint, DateInSent, Amount, Email, Phone, Comments }
export function parseCaseRow(row, sheetTab) {
  const raw = row.Case || '';
  const caseId = extractCaseId(raw);
  if (!caseId) return null; // skips header rows, blank rows, section dividers

  const tier = extractTier(raw);
  const amount = parseAmount(row.Amount);
  const { score, label } = computeSeverity({
    tier,
    amount,
    comments: row.Comments,
    complaintText: row.CustomerComplaint,
  });

  return {
    case_id: caseId,
    raw_label: raw.trim(),
    case_tier: tier,
    complaint_category: extractComplaintCategory(raw),
    store_pc: extractStorePc(raw),
    customer_name: row.CustomerName || null,
    customer_complaint: row.CustomerComplaint || null,
    date_in_sent: normalizeDate(row.DateInSent),
    amount,
    email: row.Email || null,
    phone: row.Phone || null,
    comments: row.Comments || null,
    severity_score: score,
    severity_label: label,
    sheet_tab: sheetTab,
    last_synced_at: new Date().toISOString(),
  };
}
