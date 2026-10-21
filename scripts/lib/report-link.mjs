// report-link.mjs — read the `[n](reports/…md)` links in the trackers.
//
// A tracker Report cell holds a markdown link whose target may be written
// three ways: plain (`reports/tier-1/Foo - Bar.md`), percent-encoded
// (`reports/tier-1/Foo%20-%20Bar%20%28Lyon%29.md`) or with literal
// parentheses (`reports/tier-1/Foo - Bar (Lyon).md`). A `[^)]+` regex stops at
// the first literal `)`, so every reader goes through here instead. The rules
// mirror frontend/src/lib/reportMatch.ts (`reportLinkTarget`,
// `normalizeReportPath`): balanced parentheses, optional `<…>` wrapper,
// percent-decoding, forward slashes, no leading `./`.
//
// Pure, no I/O.

/** A link target in the one form paths are compared in. */
export function normalizeReportPath(p) {
  let out = String(p ?? '').trim();
  try { out = decodeURIComponent(out); } catch {
    try { out = decodeURI(out); } catch { /* keep as written */ }
  }
  return out.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Every `[label](target)` in `text`, in order, as `{ label, target }` with the
 * target undecoded, `<…>` stripped and parentheses balanced. A link whose
 * parentheses never balance is skipped.
 */
export function markdownLinks(text) {
  const s = String(text ?? '');
  const out = [];
  let from = 0;
  for (;;) {
    const mid = s.indexOf('](', from);
    if (mid < 0) break;
    const open = s.lastIndexOf('[', mid);
    let depth = 1;
    let i = mid + 2;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) { from = mid + 2; continue; }
    let target = s.slice(mid + 2, i).trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
    out.push({ label: open >= 0 ? s.slice(open + 1, mid) : '', target });
    from = i + 1;
  }
  return out;
}

/**
 * The target of a tracker Report cell, decoded, or null when the cell holds no
 * `.md` link (`—`, empty).
 */
export function reportLinkTarget(cell) {
  for (const { target } of markdownLinks(cell)) {
    if (/\.md$/i.test(target)) return normalizeReportPath(target);
  }
  return null;
}
