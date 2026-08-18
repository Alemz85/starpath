// session-handoff-core.mjs — pure logic for the session handoff log
// (data/session-handoff.md).
//
// Every durable fact already has a home: a scoring correction goes to
// user/_profile.md, a tooling defect to agent-log.mjs, an application status
// change to applications.md. This is the one surface for the thing none of
// those hold — what was being worked through, what was left hanging, what
// the user asked to return to. A session that leaves something unresolved
// writes a handoff; the next session reads it when the conversation reaches
// backwards. Ported from Alke's chatctx/session.py (Supabase-backed there;
// an append-only markdown log here — no DB in this repo).
//
// SCOPE — conversational thread, not domain facts. A domain fact copied in
// here becomes a duplicate that drifts from the table a later session trusts.
//
// All functions here are pure — no filesystem, no `Date.now()`, no globals.
// The CLI wrapper (scripts/session-handoff.mjs) owns reading/writing
// data/session-handoff.md and supplies `id` / `timestamp`.

// Read-depth default when the CLI doesn't pass --limit. One handoff is the
// common case; a handful is enough to see a thread survive a few sessions
// without flooding context.
export const DEFAULT_READ_LIMIT = 5;

// Entry heading: "## <id> · <ISO 8601 timestamp> · <kebab-slug>". The
// timestamp must look like our own `new Date().toISOString()` output (always
// ends in Z) — this is deliberately strict so a body line that merely starts
// with "## " (a sub-heading the user wrote, a fake/pasted example) can never
// be mistaken for a real entry delimiter.
const HEADING_RE = /^## (\d+) · (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) · ([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/;

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Validate a --slug value: non-empty, lowercase kebab-case. */
export function validateSlug(slug) {
  if (typeof slug !== 'string' || slug.length === 0) {
    return { valid: false, reason: '--slug is required' };
  }
  if (!SLUG_RE.test(slug)) {
    return {
      valid: false,
      reason: `--slug must be kebab-case (lowercase letters, digits, hyphens): "${slug}"`,
    };
  }
  return { valid: true };
}

/**
 * Parse data/session-handoff.md content into entries, in file order (which,
 * for an append-only log, is chronological — oldest first). A missing/empty
 * file parses to []. Content before the first heading (there shouldn't be
 * any) is discarded.
 */
export function parseEntries(content) {
  const lines = String(content ?? '').split('\n');
  const entries = [];
  let current = null;

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      if (current) entries.push(finalizeEntry(current));
      current = { id: Number.parseInt(m[1], 10), timestamp: m[2], slug: m[3], bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  if (current) entries.push(finalizeEntry(current));
  return entries;
}

function finalizeEntry(current) {
  const body = current.bodyLines.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return { id: current.id, timestamp: current.timestamp, slug: current.slug, body };
}

export function nextId(entries) {
  return entries.reduce((max, e) => Math.max(max, e.id), 0) + 1;
}

/** Render one entry as its heading + body block (no trailing blank line). */
export function renderEntry({ id, timestamp, slug, body }) {
  return `## ${id} · ${timestamp} · ${slug}\n\n${String(body ?? '').trim()}`;
}

/**
 * Append a new entry to existing file content, returning the new full
 * content. Pure: normalizes trailing whitespace on the existing content and
 * separates entries with exactly one blank line.
 */
export function appendEntry(content, entry) {
  const existing = String(content ?? '').replace(/\s+$/, '');
  const rendered = renderEntry(entry);
  if (existing === '') return rendered + '\n';
  return `${existing}\n\n${rendered}\n`;
}

/** First non-blank line of a body, trimmed — used by the compact read view. */
export function firstBodyLine(body) {
  const line = String(body ?? '').split('\n').find((l) => l.trim().length > 0);
  return line ? line.trim() : '';
}

/* ───── Rendering (for non-JSON CLI output) ────────────────────────────────*/

export function renderCompactList(entries) {
  if (entries.length === 0) return '_no session handoffs recorded yet_';
  return entries
    .map((e) => `${e.id} · ${e.timestamp} · ${e.slug} — ${firstBodyLine(e.body) || '(empty)'}`)
    .join('\n');
}
