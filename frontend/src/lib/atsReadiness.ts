// atsReadiness.ts — derive a CV's ATS-tailoring readiness in the renderer.
//
// The backend `apply-kit` mode already knows whether a tailored CV is *actually*
// ATS-checked or just "a PDF that exists": pdf mode persists the measured keyword
// coverage to a sidecar (`output/cv-…-{date}.ats.json`) next to the CV, and
// `scripts/lib/apply-kit-core.mjs` reads it to downgrade an un-tailored CV to
// "stale → re-tailor". The cockpit previously showed CV presence as a single
// binary icon, so a freshly-tailored 82%-coverage CV looked identical to a stale
// PDF nobody re-ran against this JD. This module is the renderer-side mirror of
// that readiness logic so the "is this ready to send?" surface reflects tailoring
// *quality*, not just file existence.
//
// It is intentionally a re-implementation, not an import: the apply-kit core is a
// `.mjs` Node module under `scripts/` that the bundled renderer can't reach. The
// thresholds and field tolerances here are kept in lockstep with
// `scripts/lib/apply-kit-core.mjs` (parseAtsSidecar / cvCheck) and the verdict
// bands with `scripts/ats-coverage.mjs` — change them together. Pure functions on
// strings/objects only, so they're unit-tested with zero deps.

// ─── Thresholds (mirror the backend — keep in lockstep) ───────────────────────

// cvCheck in apply-kit-core treats coverage < 0.60 as "stale" (low) and an
// un-checked CV (no parsable sidecar) as "stale" too. ats-coverage.mjs labels
// ≥ 0.75 "strong" and ≥ 0.55 "acceptable" in its CLI verdict. We fold those into
// three live bands for the badge: strong ≥ 0.75, ok ≥ 0.60 (the readiness floor),
// low < 0.60.
export const ATS_STRONG = 0.75
export const ATS_OK = 0.6

export type AtsVerdict = 'strong' | 'ok' | 'low' | 'unchecked' | 'absent'

export interface AtsFacts {
  // Whether a tailored CV file was found for this listing at all.
  exists: boolean
  // Whether a parsable coverage sidecar accompanied it.
  atsChecked: boolean
  // Coverage as a 0..1 fraction, present only when atsChecked.
  atsCoverage?: number
}

export interface AtsReadiness {
  verdict: AtsVerdict
  // 0..100 integer for display, or null when unknown (no CV / no sidecar).
  coveragePct: number | null
  // Short human label for tooltips / chips.
  label: string
  // Maps to a design tone token the UI picks a color from. 'success' = strong,
  // 'accent' = ok (ready floor), 'warning' = low/unchecked, 'muted' = absent.
  tone: 'success' | 'accent' | 'warning' | 'muted'
  // True when the CV exists but is stale (un-checked or below the ready floor),
  // i.e. a re-tailor would improve it. Mirrors apply-kit's "stale" state.
  needsRetailor: boolean
}

// Coerce a coverage value that may arrive as a 0..1 fraction (0.82) or a 0..100
// percentage (82) into a 0..1 fraction. Anything > 1 is treated as a percent.
// Returns null for non-finite / out-of-range input. (Mirror of
// normalizeCoverageFraction in apply-kit-core.)
export function normalizeCoverageFraction(v: unknown): number | null {
  let n = v
  if (typeof n === 'string' && n.trim() !== '') n = Number(n)
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  const frac = n > 1 ? n / 100 : n
  if (frac < 0 || frac > 1) return null
  return frac
}

// Parse the JSON text of an ATS sidecar into { atsChecked, atsCoverage }.
// Accepts the keys ats-coverage.mjs / pdf mode write: `coveragePct` (0..100),
// `coverage` (0..1 or 0..100), or `coveragePercent`. Tolerant by construction —
// a missing or malformed sidecar yields { atsChecked: false } (CV present but
// unverified), never throws. (Mirror of parseAtsSidecar in apply-kit-core.)
export function parseAtsSidecar(jsonText: string | null | undefined): {
  atsChecked: boolean
  atsCoverage?: number
} {
  if (jsonText == null || String(jsonText).trim() === '') return { atsChecked: false }
  let obj: unknown
  try {
    obj = JSON.parse(String(jsonText))
  } catch {
    return { atsChecked: false }
  }
  if (!obj || typeof obj !== 'object') return { atsChecked: false }
  const o = obj as Record<string, unknown>
  const raw =
    o.coveragePct != null ? o.coveragePct
    : o.coverage != null ? o.coverage
    : o.coveragePercent != null ? o.coveragePercent
    : null
  const frac = normalizeCoverageFraction(raw)
  if (frac == null) return { atsChecked: false }
  return { atsChecked: true, atsCoverage: Math.round(frac * 100) / 100 }
}

// Slugify a string the way the rest of the renderer does (entityId.slug), so the
// company token embedded in a CV filename matches the listing's company. Inlined
// here to keep this module free of cross-lib coupling for the test harness.
function slugify(s: string): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Given a company name and a flat listing of filenames in output/, pick the
// newest ATS sidecar for that company. pdf mode writes
// `cv-{candidate}-{company}-{date}.ats.json`; the company token is embedded, and
// the trailing date makes filenames sort chronologically. We match on the company
// slug being a substring of the slugified filename (same rule apply-kit's CLI uses
// to resolve the CV), and return the last (newest) match. Returns null when none.
export function findCvSidecar(company: string, files: string[]): string | null {
  return pickNewestByCompany(company, files, /^cv-.*\.ats\.json$/i)
}

// Given a company name and a flat listing of output/ filenames, pick the newest
// tailored-CV file (`cv-{candidate}-{company}-{date}.{pdf,html}`) for that
// company — the exact resolution apply-kit's CLI uses. This is the *real* CV
// presence test: the cockpit historically looked for `output/{Company} -
// {Role}.pdf`, which pdf mode never writes (it writes the `cv-…` form), so the
// CV icon read as "absent" for genuinely tailored CVs. Prefer the PDF over the
// HTML twin when both exist for the same date. Returns null when none.
export function findCvFile(company: string, files: string[]): string | null {
  return pickNewestByCompany(company, files, /^cv-.*\.(pdf|html)$/i)
}

// Shared resolver: filter output/ filenames by a pattern + company token, then
// return the lexicographically-last (= newest by the trailing date suffix). When
// a PDF and its HTML twin share the same date, the .pdf sorts after .html, so the
// PDF wins — which is what we want to hand to the system viewer.
function pickNewestByCompany(company: string, files: string[], pattern: RegExp): string | null {
  const coSlug = slugify(company)
  if (!coSlug) return null
  const matches = (Array.isArray(files) ? files : [])
    .filter((f) => pattern.test(f))
    .filter((f) => slugify(f).includes(coSlug))
    .sort()
  return matches.length ? matches[matches.length - 1] : null
}

// Fold the resolved facts into a single verdict + display payload. This is the
// renderer mirror of cvCheck's CV branch in apply-kit-core:
//   no CV               → 'absent'  (nothing tailored yet)
//   CV, no sidecar      → 'unchecked' (present but ATS-unverified → re-tailor)
//   CV, coverage < 0.60 → 'low'     (tailored but weak → re-tailor)
//   CV, 0.60..<0.75     → 'ok'      (clears the readiness floor)
//   CV, coverage ≥ 0.75 → 'strong'  (well-tailored)
export function atsReadiness(facts: AtsFacts): AtsReadiness {
  if (!facts.exists) {
    return {
      verdict: 'absent',
      coveragePct: null,
      label: 'No tailored CV yet',
      tone: 'muted',
      needsRetailor: false,
    }
  }
  if (!facts.atsChecked || facts.atsCoverage == null) {
    return {
      verdict: 'unchecked',
      coveragePct: null,
      label: 'CV present — not ATS-checked',
      tone: 'warning',
      needsRetailor: true,
    }
  }
  const pct = Math.round(facts.atsCoverage * 100)
  if (facts.atsCoverage >= ATS_STRONG) {
    return {
      verdict: 'strong',
      coveragePct: pct,
      label: `ATS coverage ${pct}% — strong`,
      tone: 'success',
      needsRetailor: false,
    }
  }
  if (facts.atsCoverage >= ATS_OK) {
    return {
      verdict: 'ok',
      coveragePct: pct,
      label: `ATS coverage ${pct}% — ready`,
      tone: 'accent',
      needsRetailor: false,
    }
  }
  return {
    verdict: 'low',
    coveragePct: pct,
    label: `ATS coverage ${pct}% — low, re-tailor`,
    tone: 'warning',
    needsRetailor: true,
  }
}

// Convenience: resolve readiness straight from raw inputs (CV existence + the
// sidecar's JSON text). Keeps the React side a one-liner and the whole chain
// unit-tested. `sidecarText === null` means "no sidecar on disk".
export function readinessFromInputs(
  cvExists: boolean,
  sidecarText: string | null,
): AtsReadiness {
  if (!cvExists) return atsReadiness({ exists: false, atsChecked: false })
  const parsed = parseAtsSidecar(sidecarText)
  return atsReadiness({
    exists: true,
    atsChecked: parsed.atsChecked,
    atsCoverage: parsed.atsCoverage,
  })
}
