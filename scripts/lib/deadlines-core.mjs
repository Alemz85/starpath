// deadlines-core.mjs — pure deadline-extraction and bucketing logic for the
// deadlines mode (`/career-ops deadlines` → scripts/deadlines.mjs).
//
// Reads closing dates from TWO sources:
//   • data/applications.md  (all rows with a Deadline cell)
//   • data/scouting.md      (T1/T2 rows with a Deadline cell)
//
// Parses every deadline value, buckets each entry by true urgency, and renders
// a clear "act today / this week / watch" breakdown — the three questions the
// mode must answer.
//
// All functions are pure (no I/O, no globals, no Date.now() calls). The CLI
// wrapper (scripts/deadlines.mjs) supplies file content and today's date so
// this file is exhaustively testable in isolation.
//
// Reuses parseAppRow / parseScoutingRow from tracker-core / scouting-core so
// the deadline-column detection logic (the 9-vs-10-col / 10-vs-11-col gap) is
// NOT duplicated here.

import { parseAppRow } from './tracker-core.mjs';
import { parseScoutingRow } from './scouting-core.mjs';

/* ───── Bucket definitions ──────────────────────────────────────────────────
 *
 * Urgency bucket → criteria → "act today / this week / watch" mapping:
 *
 *   urgent   ≤ 7 days left (or same day)   → act today / tomorrow
 *   near     8–30 days                      → this month
 *   medium   31–60 days                     → next month
 *   far      > 60 days                      → further out
 *   rolling  "Rolling" deadline             → always open; list separately
 *   missed   deadline already passed        → action already overdue / skip
 *   unknown  n/d / unparseable              → tracked in count, not listed
 */
export const BUCKETS = ['urgent', 'near', 'medium', 'far', 'rolling', 'missed'];

export const BUCKET_LABELS = {
  urgent: 'URGENT (closes ≤ 7 days)',
  near: 'THIS MONTH (8–30 days)',
  medium: 'NEXT MONTH (31–60 days)',
  far: 'FURTHER OUT (> 60 days)',
  rolling: 'ROLLING (no fixed deadline)',
  missed: 'MISSED (deadline passed)',
};

/* ───── Date helpers (string-based, no Date.now()) ──────────────────────────*/

/**
 * Parse a deadline string into a canonical YYYY-MM-DD date or a bucket code.
 *
 * Returns one of:
 *   { kind: 'date', iso: 'YYYY-MM-DD' }      — parseable date
 *   { kind: 'rolling' }                        — Rolling / open until filled
 *   { kind: 'unknown', raw }                   — n/d or truly unparseable
 *
 * Supports:
 *   - Exact ISO: 2026-06-30
 *   - Year-month: 2026-06 → 2026-06-30 (end of month)
 *   - "End of May" / "end of Q2" / "end of Q2 2026" / "Q2 2026" → last day
 *   - "Rolling" / "open until filled" / "ongoing"
 *   - "6mo" (promotion hints) → unknown (not a deadline)
 */
export function parseDeadline(raw) {
  const s = String(raw || '').trim();
  if (!s || s === 'n/d' || s === '-' || s === '—') {
    return { kind: 'unknown', raw: s || 'n/d' };
  }

  // Rolling / open
  if (/^rolling$/i.test(s) || /open\s+until\s+filled/i.test(s) || /^ongoing$/i.test(s)) {
    return { kind: 'rolling' };
  }

  // Exact ISO date: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return { kind: 'date', iso: s };
  }

  // Year-month: YYYY-MM → end of that month
  if (/^\d{4}-\d{2}$/.test(s)) {
    const iso = endOfMonth(s + '-01');
    return iso ? { kind: 'date', iso } : { kind: 'unknown', raw: s };
  }

  // "End of <Month>" → last day of that month in the current or next year
  const eomMatch = s.match(/^end\s+of\s+([a-z]+)\s*(\d{4})?$/i);
  if (eomMatch) {
    const iso = monthNameToEndOfMonth(eomMatch[1], eomMatch[2] || null);
    return iso ? { kind: 'date', iso } : { kind: 'unknown', raw: s };
  }

  // "Q1 2026" / "Q2" / "end of Q3" / "end of Q3 2026" → last day of quarter
  const qMatch = s.match(/(?:end\s+of\s+)?Q([1-4])(?:\s+(\d{4}))?/i);
  if (qMatch) {
    const iso = quarterEndDate(parseInt(qMatch[1], 10), qMatch[2] ? parseInt(qMatch[2], 10) : null);
    return iso ? { kind: 'date', iso } : { kind: 'unknown', raw: s };
  }

  // Plain month name only ("May 2026", "June") — common in JDs
  const plainMonth = s.match(/^([a-z]+)\s*(\d{4})?$/i);
  if (plainMonth) {
    const iso = monthNameToEndOfMonth(plainMonth[1], plainMonth[2] || null);
    return iso ? { kind: 'date', iso } : { kind: 'unknown', raw: s };
  }

  return { kind: 'unknown', raw: s };
}

/**
 * Given a date ISO string and today's ISO string, return the number of calendar
 * days from today to the date (negative = in the past).
 */
export function daysFromToday(dateIso, todayIso) {
  const [ty, tm, td] = todayIso.split('-').map(Number);
  const [dy, dm, dd] = dateIso.split('-').map(Number);
  return Math.round(
    (Date.UTC(dy, dm - 1, dd) - Date.UTC(ty, tm - 1, td)) / 86_400_000
  );
}

/**
 * Assign an entry to a bucket given a pre-computed `daysLeft` value.
 * `daysLeft` is the result of `daysFromToday(dateIso, todayIso)`.
 *
 *   < 0                → 'missed'
 *   0..7  (≤ 7)        → 'urgent'
 *   8..30 (this month) → 'near'
 *   31..60             → 'medium'
 *   > 60               → 'far'
 */
export function assignBucket(daysLeft) {
  if (daysLeft < 0) return 'missed';
  if (daysLeft <= 7) return 'urgent';
  if (daysLeft <= 30) return 'near';
  if (daysLeft <= 60) return 'medium';
  return 'far';
}

/* ───── Source parsers ──────────────────────────────────────────────────────*/

/**
 * Parse all rows from applications.md content and return an array of deadline
 * entries (one per row that has a parseable deadline cell).
 *
 * Each entry:
 *   { source: 'applications', num, company, role, status, deadline, parsed }
 *
 * Rows with status Discarded / SKIP / Rejected are excluded — they are terminal
 * and tracking their deadline adds noise.
 */
export function parseApplicationsDeadlines(content) {
  const lines = String(content || '').split('\n');
  const entries = [];
  for (const line of lines) {
    const row = parseAppRow(line);
    if (!row) continue;

    // Skip terminal statuses
    const statusClean = row.status.replace(/\*\*/g, '').trim().toLowerCase();
    if (['discarded', 'rejected', 'skip', 'descartado', 'descartada', 'rechazado', 'rechazada', 'no aplicar', 'no_aplicar'].includes(statusClean)) {
      continue;
    }

    const deadline = row.deadline;
    if (!deadline || deadline === 'n/d') continue; // no deadline → count only

    const parsed = parseDeadline(deadline);
    entries.push({
      source: 'applications',
      num: row.num,
      company: row.company,
      role: row.role,
      status: row.status.replace(/\*\*/g, '').trim(),
      deadline,
      parsed,
    });
  }
  return entries;
}

/**
 * Parse all rows from scouting.md content and return deadline entries for
 * T1 and T2 rows only (T3/T4 are not actionable).
 *
 * Each entry:
 *   { source: 'scouting', num, company, role, tier, score, deadline, parsed }
 *
 * Rows with Deadline = n/d are excluded (no deadline data to track).
 */
export function parseScoutingDeadlines(content) {
  const lines = String(content || '').split('\n');
  const entries = [];
  for (const line of lines) {
    const row = parseScoutingRow(line);
    if (!row) continue;

    const tier = String(row.tier || '').trim().toUpperCase();
    if (tier !== 'T1' && tier !== 'T2') continue;

    const deadline = row.deadline;
    if (!deadline || deadline === 'n/d') continue;

    const parsed = parseDeadline(deadline);
    entries.push({
      source: 'scouting',
      num: row.num,
      company: row.company,
      role: row.role,
      tier,
      score: row.score,
      deadline,
      parsed,
    });
  }
  return entries;
}

/* ───── Bucketing ────────────────────────────────────────────────────────────*/

/**
 * Classify a flat list of deadline entries (mixed source) into buckets.
 * Returns a structured result:
 *
 * {
 *   asOf: YYYY-MM-DD,
 *   buckets: {
 *     urgent: [...],    // sorted ascending by daysLeft (most urgent first)
 *     near: [...],
 *     medium: [...],
 *     far: [...],
 *     rolling: [...],
 *     missed: [...],    // sorted descending by daysLeft (most-recently-missed first)
 *   },
 *   counts: { urgent, near, medium, far, rolling, missed, unknown },
 *   ndCount: { applications, scouting },  // how many were skipped (n/d)
 * }
 *
 * Each bucketed entry gains `daysLeft` (integer, may be negative for missed).
 */
export function classifyDeadlines(entries, todayIso) {
  const result = {
    asOf: todayIso,
    buckets: Object.fromEntries(BUCKETS.map(b => [b, []])),
    counts: Object.fromEntries([...BUCKETS, 'unknown'].map(b => [b, 0])),
    ndCount: { applications: 0, scouting: 0 },
  };

  for (const entry of entries) {
    const { parsed } = entry;

    if (parsed.kind === 'unknown') {
      result.counts.unknown++;
      // still want to track n/d count per source
      continue;
    }

    if (parsed.kind === 'rolling') {
      result.buckets.rolling.push({ ...entry, daysLeft: null });
      result.counts.rolling++;
      continue;
    }

    // parsed.kind === 'date'
    const daysLeft = daysFromToday(parsed.iso, todayIso);
    const bucket = assignBucket(daysLeft);
    result.buckets[bucket].push({ ...entry, daysLeft });
    result.counts[bucket]++;
  }

  // Sort each date-keyed bucket: urgent/near/medium/far ascending daysLeft
  for (const b of ['urgent', 'near', 'medium', 'far']) {
    result.buckets[b].sort((a, b_) => a.daysLeft - b_.daysLeft);
  }
  // Missed: most-recently-missed first (daysLeft is least negative)
  result.buckets.missed.sort((a, b_) => b_.daysLeft - a.daysLeft);

  return result;
}

/* ───── n/d counter (separate pass, called from CLI) ─────────────────────────
 *
 * Count how many rows have deadline = n/d in each source so the mode can
 * report "X scouting + Y application entries have no deadline data".
 */

/**
 * Count rows with Deadline = n/d in applications.md content that are NOT
 * terminal (same filter as parseApplicationsDeadlines).
 */
export function countMissingApplicationsDeadlines(content) {
  let count = 0;
  for (const line of String(content || '').split('\n')) {
    const row = parseAppRow(line);
    if (!row) continue;
    const statusClean = row.status.replace(/\*\*/g, '').trim().toLowerCase();
    if (['discarded', 'rejected', 'skip', 'descartado', 'descartada', 'rechazado', 'rechazada', 'no aplicar', 'no_aplicar'].includes(statusClean)) {
      continue;
    }
    const deadline = row.deadline;
    if (!deadline || deadline === 'n/d') count++;
  }
  return count;
}

/**
 * Count T1/T2 scouting rows with Deadline = n/d.
 */
export function countMissingScoutingDeadlines(content) {
  let count = 0;
  for (const line of String(content || '').split('\n')) {
    const row = parseScoutingRow(line);
    if (!row) continue;
    const tier = String(row.tier || '').trim().toUpperCase();
    if (tier !== 'T1' && tier !== 'T2') continue;
    const deadline = row.deadline;
    if (!deadline || deadline === 'n/d') count++;
  }
  return count;
}

/* ───── Renderer ─────────────────────────────────────────────────────────────
 *
 * Pure: classification result → markdown string (printed to chat, not written
 * to disk — the mode is read-only).
 *
 * Layout mirrors the output template in modes/deadlines.md.
 */

/**
 * Format a single entry row for the markdown table.
 * Applications entries show `Status`; scouting entries show `Tier`.
 */
function entryTierStatus(entry) {
  return entry.source === 'scouting' ? entry.tier : entry.status;
}

function daysLeftLabel(daysLeft) {
  if (daysLeft === null) return '—';
  if (daysLeft < 0) return `${Math.abs(daysLeft)}d ago`;
  if (daysLeft === 0) return '< 1 day';
  return `${daysLeft}d`;
}

function tableRow(entry) {
  const tierOrStatus = entryTierStatus(entry);
  const deadlineDisplay = entry.parsed.kind === 'rolling' ? 'Rolling' : entry.deadline;
  const daysLabel = daysLeftLabel(entry.daysLeft);
  return `| ${entry.num} | ${entry.company} | ${entry.role} | ${tierOrStatus} | ${deadlineDisplay} | ${daysLabel} |`;
}

function tableRowRolling(entry) {
  const tierOrStatus = entryTierStatus(entry);
  const notes = entry.source === 'scouting'
    ? (entry.score ? `Score: ${entry.score}` : '')
    : (entry.status || '');
  return `| ${entry.num} | ${entry.company} | ${entry.role} | ${tierOrStatus} | ${notes} |`;
}

const TABLE_HEADER = `| # | Company | Role | Tier/Status | Deadline | Days left |
|---|---------|------|-------------|----------|-----------|`;

const TABLE_HEADER_ROLLING = `| # | Company | Role | Tier/Status | Notes |
|---|---------|------|-------------|-------|`;

/**
 * Build a one-line action summary for the urgent bucket.
 * E.g. "2 URGENT entries — Revolut (T2, 3d) and Celonis (Applied, 6d)."
 */
function urgentSummary(urgentEntries) {
  if (!urgentEntries.length) return null;
  const n = urgentEntries.length;
  if (n === 1) {
    const e = urgentEntries[0];
    return `1 URGENT entry — ${e.company} (${entryTierStatus(e)}, ${daysLeftLabel(e.daysLeft)}) needs a decision now.`;
  }
  const names = urgentEntries.slice(0, 3).map(e => `${e.company} (${entryTierStatus(e)}, ${daysLeftLabel(e.daysLeft)})`);
  const rest = n > 3 ? ` and ${n - 3} more` : '';
  return `${n} URGENT entries need decisions in the next week — ${names.join(', ')}${rest}.`;
}

/**
 * Render the full deadlines output.
 *
 * @param {object} classified   result of classifyDeadlines()
 * @param {number} ndApps       count from countMissingApplicationsDeadlines()
 * @param {number} ndScouting   count from countMissingScoutingDeadlines()
 * @returns {string}  markdown string ready to print to chat
 */
export function renderDeadlines(classified, ndApps, ndScouting) {
  const lines = [];
  const { asOf, buckets, counts } = classified;
  const total = BUCKETS.reduce((s, b) => s + counts[b], 0);

  lines.push(`## Deadlines — ${asOf}`);
  lines.push('');

  if (total === 0 && !ndApps && !ndScouting) {
    lines.push('_No deadline data found. Run `/career-ops scouting` to evaluate listings and populate deadline fields._');
    return lines.join('\n');
  }

  // Headline summary
  const urgentCount = counts.urgent;
  if (urgentCount > 0) {
    const summary = urgentSummary(buckets.urgent);
    lines.push(`> **${summary}**`);
    lines.push('');
  } else if (counts.near > 0) {
    lines.push(`> ${counts.near} listing(s) closing this month — no urgent deadlines today.`);
    lines.push('');
  } else if (total > 0) {
    lines.push(`> No deadlines in the next 30 days. ${total} listing(s) tracked in later buckets.`);
    lines.push('');
  }

  // Date buckets
  const dateBuckets = [
    { id: 'urgent', label: '### URGENT (closes ≤ 7 days)' },
    { id: 'near', label: '### THIS MONTH (8–30 days)' },
    { id: 'medium', label: '### NEXT MONTH (31–60 days)' },
    { id: 'far', label: '### FURTHER OUT (> 60 days)' },
  ];

  for (const { id, label } of dateBuckets) {
    if (!buckets[id].length) continue;
    lines.push(label);
    lines.push(TABLE_HEADER);
    for (const entry of buckets[id]) {
      lines.push(tableRow(entry));
    }
    lines.push('');
  }

  // Rolling bucket
  if (buckets.rolling.length) {
    lines.push('### ROLLING (no fixed deadline)');
    lines.push(TABLE_HEADER_ROLLING);
    for (const entry of buckets.rolling) {
      lines.push(tableRowRolling(entry));
    }
    lines.push('');
  }

  // Missed bucket
  if (buckets.missed.length) {
    lines.push('### MISSED (deadline passed)');
    lines.push(TABLE_HEADER);
    for (const entry of buckets.missed) {
      lines.push(tableRow(entry));
    }
    lines.push('');
  }

  // No-deadline count
  const ndTotal = (ndApps || 0) + (ndScouting || 0);
  if (ndTotal > 0) {
    const parts = [];
    if (ndScouting > 0) parts.push(`${ndScouting} T1/T2 scouting entr${ndScouting === 1 ? 'y' : 'ies'}`);
    if (ndApps > 0) parts.push(`${ndApps} active application${ndApps === 1 ? '' : 's'}`);
    lines.push('### NO DEADLINE DATA');
    lines.push(`${parts.join(' and ')} have Deadline = \`n/d\`.`);
    lines.push('Run `/career-ops scouting` or check the JD to fill in missing deadlines.');
    lines.push('');
  }

  return lines.join('\n');
}

/* ───── Convenience: end-to-end from raw file content ────────────────────────
 *
 * CLI wrapper calls this; tests can call the individual stages instead.
 */

/**
 * Build the deadlines output from raw markdown file contents.
 *
 * @param {string}  appsMd      content of data/applications.md
 * @param {string}  scoutingMd  content of data/scouting.md
 * @param {string}  todayIso    YYYY-MM-DD
 * @returns {string} markdown string ready to print
 */
export function buildDeadlinesMarkdown(appsMd, scoutingMd, todayIso) {
  const appEntries = parseApplicationsDeadlines(appsMd);
  const scoutEntries = parseScoutingDeadlines(scoutingMd);
  const allEntries = [...appEntries, ...scoutEntries];

  const classified = classifyDeadlines(allEntries, todayIso);
  const ndApps = countMissingApplicationsDeadlines(appsMd);
  const ndScouting = countMissingScoutingDeadlines(scoutingMd);

  return renderDeadlines(classified, ndApps, ndScouting);
}

/* ───── Internal helpers ─────────────────────────────────────────────────────*/

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const MONTH_SHORT = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function monthIndex(name) {
  const n = name.toLowerCase();
  let idx = MONTH_NAMES.indexOf(n);
  if (idx === -1) idx = MONTH_SHORT.indexOf(n.slice(0, 3));
  return idx; // 0-based
}

function endOfMonth(isoDate) {
  // isoDate: YYYY-MM-DD (first of month)
  const [y, m] = isoDate.split('-').map(Number);
  // Last day of month: go to first day of next month, subtract 1
  const last = new Date(Date.UTC(y, m, 0)); // Month is 1-based: m=1 gives day 0 of Feb = Jan 31
  return last.toISOString().slice(0, 10);
}

function monthNameToEndOfMonth(name, yearStr) {
  const idx = monthIndex(name);
  if (idx === -1) return null;
  const year = yearStr ? parseInt(yearStr, 10) : null;
  // If year not given, use current year (we'll compare ISO strings; caller handles past)
  const y = year || 2000; // placeholder; caller must know actual year
  const first = `${year || 2000}-${String(idx + 1).padStart(2, '0')}-01`;
  const eoM = endOfMonth(first);
  // We want to return the ISO date even if year is unknown: caller can verify
  return year ? eoM : null; // Without year, we can't safely resolve → unknown
}

const QUARTER_LAST_MONTH = [3, 6, 9, 12]; // Q1→Mar, Q2→Jun, Q3→Sep, Q4→Dec

function quarterEndDate(q, year) {
  if (!year) return null; // can't resolve without year
  const month = QUARTER_LAST_MONTH[q - 1];
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  return endOfMonth(first);
}
