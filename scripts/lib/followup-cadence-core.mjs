// followup-cadence-core.mjs — pure follow-up-cadence logic for the followup mode
// (`/career-ops followup` → scripts/followup-cadence.mjs).
//
// Answers ONE question per active application: "is a follow-up due, and when is
// the next one?" It walks applications.md + follow-ups.md and, for every
// actionable row (Applied / Responded / Interview), computes:
//
//   • how long the application has been silent,
//   • how many follow-ups were already sent,
//   • an urgency band (urgent / overdue / waiting / cold),
//   • the next-follow-up date implied by the cadence policy.
//
// All functions are pure (no filesystem, no `Date.now()`, no globals). The CLI
// wrapper (scripts/followup-cadence.mjs) supplies the file contents and today's
// date, so this file is exhaustively unit-testable in isolation — and the date
// can be overridden for backdated/deterministic runs, the way deadlines-core
// already threads `todayIso`.
//
// Row parsing reuses parseAppRow from tracker-core so the column-detection logic
// (the 9-vs-10-col deadline gap) is NOT duplicated here. Status normalization is
// intentionally domain-specific (a lowercase canonical state for the cadence
// state machine) and lives here, not in tracker-core, because tracker-core's
// normalizeStatus returns a different object contract.

import { parseAppRow } from './tracker-core.mjs';

/* ───── Cadence policy ───────────────────────────────────────────────────────
 *
 * How long to wait before each nudge, by status. `applied_first` is overridable
 * from the CLI (`--applied-days N`) — some users run a tighter or looser first
 * touch — everything else is a sensible fixed default.
 */
export const DEFAULT_CADENCE = {
  applied_first: 7,        // first nudge N days after applying
  applied_subsequent: 7,   // each later nudge N days after the previous one
  applied_max_followups: 2, // after this many, the thread is "cold" — stop
  responded_initial: 1,    // a same-day-ish reply window once they respond
  responded_subsequent: 3, // re-nudge cadence while in a live thread
  interview_thankyou: 1,   // send the thank-you within a day of interviewing
};

/**
 * Build a cadence config, overriding only `applied_first` when a caller passes a
 * positive integer (the CLI's `--applied-days`). Invalid/missing → default 7.
 */
export function buildCadence(appliedFirst) {
  const n = Number.parseInt(appliedFirst, 10);
  return {
    ...DEFAULT_CADENCE,
    applied_first: Number.isFinite(n) && n > 0 ? n : DEFAULT_CADENCE.applied_first,
  };
}

/* ───── Status normalization (cadence state machine) ─────────────────────────
 *
 * Maps a raw status cell (possibly Spanish, bolded, or trailing a date) onto a
 * lowercase canonical state. Only `applied` / `responded` / `interview` are
 * actionable for cadence; everything else is terminal or pre-application noise.
 */
const ALIASES = {
  'evaluada': 'evaluated', 'condicional': 'evaluated', 'hold': 'evaluated',
  'evaluar': 'evaluated', 'verificar': 'evaluated',
  'aplicado': 'applied', 'enviada': 'applied', 'aplicada': 'applied',
  'applied': 'applied', 'sent': 'applied',
  'respondido': 'responded',
  'entrevista': 'interview',
  'oferta': 'offer',
  'rechazado': 'rejected', 'rechazada': 'rejected',
  'descartado': 'discarded', 'descartada': 'discarded',
  'cerrada': 'discarded', 'cancelada': 'discarded',
  'no aplicar': 'skip', 'no_aplicar': 'skip', 'monitor': 'skip', 'geo blocker': 'skip',
};

export const ACTIONABLE_STATUSES = ['applied', 'responded', 'interview'];

export function normalizeStatus(raw) {
  const clean = String(raw || '').replace(/\*\*/g, '').trim().toLowerCase()
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  return ALIASES[clean] || clean;
}

/* ───── Date helpers (string YYYY-MM-DD, no Date.now()) ──────────────────────*/

export function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
}

/**
 * Whole calendar days from `fromIso` to `toIso` (negative = `toIso` is earlier).
 * Returns null if either side is not a valid ISO date.
 */
export function daysBetween(fromIso, toIso) {
  if (!isIsoDate(fromIso) || !isIsoDate(toIso)) return null;
  const [fy, fm, fd] = fromIso.trim().split('-').map(Number);
  const [ty, tm, td] = toIso.trim().split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/**
 * Add `days` calendar days to an ISO date, returning a new ISO date. Returns
 * null when the input is not a valid ISO date.
 */
export function addDays(iso, days) {
  if (!isIsoDate(iso)) return null;
  const [y, m, d] = iso.trim().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/* ───── Parsers ──────────────────────────────────────────────────────────────*/

/**
 * Parse applications.md content into raw application rows, reusing the shared
 * column-aware parseAppRow so deadline-column drift can't desync this parser.
 */
export function parseApplications(content) {
  const entries = [];
  for (const line of String(content || '').split('\n')) {
    const row = parseAppRow(line);
    if (!row) continue;
    entries.push({
      num: row.num,
      date: row.date,
      company: row.company,
      role: row.role,
      score: row.score,
      status: row.status,
      pdf: row.pdf,
      report: row.report,
      notes: row.notes || '',
    });
  }
  return entries;
}

/**
 * Parse follow-ups.md content. Shape per row:
 *   | # | appNum | date | company | role | channel | contact | notes |
 * Rows without a numeric leading # are ignored (header/separator/comment).
 */
export function parseFollowups(content) {
  const entries = [];
  for (const line of String(content || '').split('\n')) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length < 8) continue;
    const num = Number.parseInt(parts[1], 10);
    if (Number.isNaN(num)) continue;
    entries.push({
      num,
      appNum: Number.parseInt(parts[2], 10),
      date: parts[3],
      company: parts[4],
      role: parts[5],
      channel: parts[6],
      contact: parts[7],
      notes: parts[8] || '',
    });
  }
  return entries;
}

/**
 * Pull contact emails (+ a best-effort name) out of a free-text notes cell.
 */
export function extractContacts(notes) {
  if (!notes) return [];
  const contacts = [];
  const emailRegex = /[\w.-]+@[\w.-]+\.\w+/g;
  const emails = String(notes).match(emailRegex) || [];
  for (const email of emails) {
    let name = null;
    const beforeEmail = notes.substring(0, notes.indexOf(email));
    const nameMatch = beforeEmail.match(/(?:Emailed|emailed|contact[:\s]+|to\s+)([A-Z][a-z]+ ?[A-Z]?[a-z]*)\s*(?:at|@|$)/i);
    if (nameMatch) name = nameMatch[1].trim();
    contacts.push({ email, name });
  }
  return contacts;
}

/**
 * Resolve a report link cell ("[#3](reports/tier-2/Foo.md)") to its relative
 * path, but only if the predicate `exists(relPath)` returns true. The CLI passes
 * an fs-backed predicate; tests pass a stub. Pure given the predicate.
 */
export function resolveReportPath(reportField, exists) {
  const match = String(reportField || '').match(/\]\(([^)]+)\)/);
  if (!match) return null;
  const rel = match[1];
  return exists(rel) ? rel : null;
}

/* ───── Cadence math ─────────────────────────────────────────────────────────*/

/**
 * Urgency band for one application.
 *
 *   applied:
 *     followupCount ≥ max          → 'cold'   (stop nudging)
 *     0 sent  & ≥ appliedFirst days → 'overdue'
 *     ≥1 sent & ≥ subsequent since last → 'overdue'
 *     else                          → 'waiting'
 *   responded:
 *     < responded_initial days      → 'urgent' (reply window is open NOW)
 *     ≥ responded_subsequent days   → 'overdue'
 *     else                          → 'waiting'
 *   interview:
 *     ≥ interview_thankyou days     → 'overdue' (thank-you is late)
 *     else                          → 'waiting'
 */
export function computeUrgency(status, daysSinceApp, daysSinceLastFollowup, followupCount, cadence = DEFAULT_CADENCE) {
  if (status === 'applied') {
    if (followupCount >= cadence.applied_max_followups) return 'cold';
    if (followupCount === 0 && daysSinceApp >= cadence.applied_first) return 'overdue';
    if (followupCount > 0 && daysSinceLastFollowup !== null && daysSinceLastFollowup >= cadence.applied_subsequent) return 'overdue';
    return 'waiting';
  }
  if (status === 'responded') {
    if (daysSinceApp < cadence.responded_initial) return 'urgent';
    if (daysSinceApp >= cadence.responded_subsequent) return 'overdue';
    return 'waiting';
  }
  if (status === 'interview') {
    if (daysSinceApp >= cadence.interview_thankyou) return 'overdue';
    return 'waiting';
  }
  return 'waiting';
}

/**
 * The ISO date the next follow-up is due (or null when none is — cold thread or
 * non-actionable). Pure: derived purely from the supplied dates + cadence.
 */
export function computeNextFollowupDate(status, appDateIso, lastFollowupDateIso, followupCount, cadence = DEFAULT_CADENCE) {
  if (status === 'applied') {
    if (followupCount >= cadence.applied_max_followups) return null;
    if (followupCount === 0) return addDays(appDateIso, cadence.applied_first);
    if (lastFollowupDateIso) return addDays(lastFollowupDateIso, cadence.applied_subsequent);
    return addDays(appDateIso, cadence.applied_first);
  }
  if (status === 'responded') {
    if (lastFollowupDateIso) return addDays(lastFollowupDateIso, cadence.responded_subsequent);
    return addDays(appDateIso, cadence.responded_subsequent);
  }
  if (status === 'interview') {
    return addDays(appDateIso, cadence.interview_thankyou);
  }
  return null;
}

const URGENCY_ORDER = { urgent: 0, overdue: 1, waiting: 2, cold: 3 };

/* ───── Analysis ─────────────────────────────────────────────────────────────
 *
 * Pure end-to-end: raw file contents + today + options → the structured result
 * the CLI prints and daily-brief consumes. The output shape is preserved exactly
 * from the original script (entries[].{num,date,company,role,status,score,notes,
 * reportPath,contacts,daysSinceApplication,daysSinceLastFollowup,followupCount,
 * urgency,nextFollowupDate,daysUntilNext} + metadata + cadenceConfig), so the
 * daily-brief consumer needs no change.
 *
 * @param {object} opts
 *   - appsContent       data/applications.md content (required)
 *   - followupsContent  data/follow-ups.md content (optional)
 *   - todayIso          YYYY-MM-DD (required for deterministic output)
 *   - cadence           cadence config (defaults to DEFAULT_CADENCE)
 *   - overdueOnly       filter entries to overdue+urgent only
 *   - reportExists      (relPath) => boolean — gate for report-path resolution
 */
export function analyze({
  appsContent = '',
  followupsContent = '',
  todayIso,
  cadence = DEFAULT_CADENCE,
  overdueOnly = false,
  reportExists = () => false,
} = {}) {
  const apps = parseApplications(appsContent);
  if (apps.length === 0) {
    return { error: 'No applications found in tracker.' };
  }

  const followups = parseFollowups(followupsContent);

  // Group follow-ups by the application number they belong to.
  const followupsByApp = new Map();
  for (const fu of followups) {
    if (!followupsByApp.has(fu.appNum)) followupsByApp.set(fu.appNum, []);
    followupsByApp.get(fu.appNum).push(fu);
  }

  const entries = [];

  for (const app of apps) {
    const status = normalizeStatus(app.status);
    if (!ACTIONABLE_STATUSES.includes(status)) continue;
    if (!isIsoDate(app.date)) continue;

    const daysSinceApp = daysBetween(app.date, todayIso);
    const appFollowups = followupsByApp.get(app.num) || [];
    const followupCount = appFollowups.length;

    // Most-recent follow-up (sort descending by date string — ISO sorts right).
    let lastFollowupDate = null;
    let daysSinceLastFollowup = null;
    if (appFollowups.length > 0) {
      const sorted = [...appFollowups].sort((a, b) => (a.date > b.date ? -1 : 1));
      lastFollowupDate = sorted[0].date;
      if (isIsoDate(lastFollowupDate)) {
        daysSinceLastFollowup = daysBetween(lastFollowupDate, todayIso);
      }
    }

    const urgency = computeUrgency(status, daysSinceApp, daysSinceLastFollowup, followupCount, cadence);
    const nextFollowupDate = computeNextFollowupDate(status, app.date, lastFollowupDate, followupCount, cadence);
    const daysUntilNext = nextFollowupDate ? daysBetween(todayIso, nextFollowupDate) : null;

    entries.push({
      num: app.num,
      date: app.date,
      company: app.company,
      role: app.role,
      status,
      score: app.score,
      notes: app.notes,
      reportPath: resolveReportPath(app.report, reportExists),
      contacts: extractContacts(app.notes),
      daysSinceApplication: daysSinceApp,
      daysSinceLastFollowup,
      followupCount,
      urgency,
      nextFollowupDate,
      daysUntilNext,
    });
  }

  // Sort by urgency priority: urgent > overdue > waiting > cold. Within a band,
  // surface the more-overdue thread first (more days waiting on the next nudge).
  entries.sort((a, b) => {
    const u = (URGENCY_ORDER[a.urgency] ?? 9) - (URGENCY_ORDER[b.urgency] ?? 9);
    if (u !== 0) return u;
    const ad = a.daysUntilNext ?? 0;
    const bd = b.daysUntilNext ?? 0;
    return ad - bd; // more negative (more overdue) first
  });

  const filtered = overdueOnly
    ? entries.filter((e) => e.urgency === 'overdue' || e.urgency === 'urgent')
    : entries;

  return {
    metadata: {
      analysisDate: todayIso,
      totalTracked: apps.length,
      actionable: entries.length,
      overdue: entries.filter((e) => e.urgency === 'overdue').length,
      urgent: entries.filter((e) => e.urgency === 'urgent').length,
      cold: entries.filter((e) => e.urgency === 'cold').length,
      waiting: entries.filter((e) => e.urgency === 'waiting').length,
    },
    entries: filtered,
    cadenceConfig: cadence,
  };
}

/* ───── Summary renderer ─────────────────────────────────────────────────────
 *
 * Pure: analysis result → the human-readable dashboard string the CLI prints
 * under `--summary`. (The CLI still owns whether to print JSON or this.)
 */
export function renderSummary(result) {
  if (result.error) {
    return `\n${result.error}\n`;
  }

  const { metadata, entries } = result;
  const L = [];

  L.push('');
  L.push('='.repeat(70));
  L.push(`  Follow-up Cadence Dashboard — ${metadata.analysisDate}`);
  L.push(`  ${metadata.totalTracked} total applications, ${metadata.actionable} actionable`);
  L.push('='.repeat(70));
  L.push('');

  if (entries.length === 0) {
    L.push('  No active applications to track. Apply to some roles first.');
    L.push('');
    return L.join('\n');
  }

  L.push(`  ${metadata.urgent} urgent | ${metadata.overdue} overdue | ${metadata.waiting} waiting | ${metadata.cold} cold`);
  L.push('');

  const urgencyLabel = { urgent: 'URGENT', overdue: 'OVERDUE', waiting: 'waiting', cold: 'COLD' };
  L.push('  ' + '#'.padEnd(5) + 'Company'.padEnd(16) + 'Status'.padEnd(12) + 'Days'.padEnd(6) + 'F/U'.padEnd(5) + 'Next'.padEnd(13) + 'Urgency'.padEnd(10) + 'Contact');
  L.push('  ' + '-'.repeat(80));

  for (const e of entries) {
    const urgLabel = urgencyLabel[e.urgency] || e.urgency;
    const nextStr = e.nextFollowupDate || '-';
    const contactStr = e.contacts.length > 0 ? e.contacts[0].email : '-';
    L.push(
      '  ' +
      String(e.num).padEnd(5) +
      String(e.company).substring(0, 15).padEnd(16) +
      e.status.padEnd(12) +
      String(e.daysSinceApplication).padEnd(6) +
      String(e.followupCount).padEnd(5) +
      nextStr.padEnd(13) +
      urgLabel.padEnd(10) +
      contactStr
    );
  }

  L.push('');
  return L.join('\n');
}
