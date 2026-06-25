# starpath TODO

---

## ⭐ Directive for the next freestyle rounds (set 2026-06-25)

**Build features now, not more plumbing.** The hardening phase is done: the
frontend went 0 → 243 unit tests, the backend scripts 0 → 150, CI is green, and
the riskiest pure logic (the `applications.md` pipeline, Database filtering, the
liveness classifier, scoring) is now extracted into tested `lib/` modules. The
foundation exists — another round of behavior-preserving "extract + unit-test"
refactors has sharply diminishing returns and just adds maintenance weight.

**So for an open-ended `/freestyle` run, default to user-facing features that
move the tool's actual goal forward: helping the user land a better job, faster.**
Optimize the funnel toward *outcomes*, not internal tidiness. Pick the highest-
leverage thrust below (or a better one you find), and ground it in a real
deep-dive of the current code/data — one big thing or several.

Candidate thrusts, roughly highest-leverage first:
1. **Sourcing quality** — the funnel starts at `scan`. Better discovery, dedup,
   freshness signals, more/better-filtered sources → everything downstream
   improves. (`scripts/scan.mjs`, `scripts/jobspy/`, `user/portals.yml`.)
2. **Match/scoring intelligence** — the scouting evaluation is the core decision
   engine. Make scores more trustworthy and *explainable* (why this role scored
   high/low; fewer false positives), and surface that in the cockpit.
3. **Application conversion** — turn a good match into a strong, tailored
   application: smarter CV tailoring, cover-letter / application-answer drafting,
   reusing the STAR story bank. This is where match → outcome actually happens.
   (`modes/pdf.md`, `modes/apply.md`, `modes/interview-prep.md`.)
4. **Outreach** — referrals dramatically raise response rates; `contacto` is
   thin. Help find the right person + draft outreach worth reading.
5. **"What should I do today?"** — a single highest-value-next-action surface
   across the whole pipeline (deadlines, followup cadence, stale apps, rejection
   patterns), instead of the user having to scan tabs.

**Guardrails (keep, don't regress):**
- Write a test or two for any new pure logic — don't erode the green baseline.
- Respect the Data Contract + system-layer hygiene in `CLAUDE.md` (no user data
  hardcoded into `modes/*`/`scripts/*`/`frontend/*`).
- New UI follows `DESIGN-meta.md`; no new design tokens without updating it.
- Don't build something that "feels random" — tie it to the funnel/goal above.

---

## Other open work

(Nothing tracked here right now — add new items above this line as they come up.)

---

## Done

- **Restore the Company detail view** (2026-06-25). `CompanyView` is now reachable
  in-app: `nav.ts` gained a `company` view + `companySlug` + `companyReturnView`;
  `AppShell` renders it; `CompanyLink` and CmdK drive it via `navigate('company',
  '', slug)` instead of a full-reload `<Link>`/`router.push`; the Database table's
  company logo opens the dossier; the back button returns to the origin view. The
  broken in-app-`<Link>` pattern is fully gone — no `next/link` or `useRouter`
  remain in the renderer. View labels are single-sourced in `VIEW_LABELS`
  (`store/nav.ts`). Covered by `store/nav.test.ts`.
