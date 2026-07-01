# starpath TODO

---

## 🔒 To do later: scrub PII from git history

Repo was made **private** (2026-06-25) after a leak — the user's **phone number**
+ **school/grad-date** were committed into (then-public) history. The working tree
is already clean; what remains is **rewriting history to purge the PII from old
commits, then force-pushing**. Deliberately deferred: `git filter-repo` rewrites
every ref and would corrupt live agent worktrees, so it must run only when the
tree is back to a single clean `main` with **no agent worktrees**.

When ready: `git filter-repo --replace-text <file>` redacting the strings
`555 123 4567` and `[redacted degree/date]` (NOT the bare word "Esade" — that's
legit reference data in the school-region table), then `git push --force`.
Caveat: existing forks/clones keep the old data; GitHub may cache old commit SHAs
briefly (GH Support can purge).

---

## 💰 Token-cost reduction (deep project — set 2026-06-25)

Running the app burns a Claude Pro session fast (a scan+eval ~= a whole session).
**Key insight:** the scan + 4-pass filter + relevance ranking are **zero-token**
(plain Node/Python hitting APIs). The real cost is the **per-listing Claude
evaluation** (`scouting` mode): volume × context-loaded-per-eval × output length.
Levers, by impact:
1. ✅ **Pre-filter before Claude** (biggest, ~5–10×) — shipped 2026-07-01:
   `scripts/triage-pipeline.mjs` (`npm run triage`) ranks the Pending inbox
   deterministically (scan relevance + freshness + dream/affinity + title level
   + dedup hits) and `--emit-batch` feeds the top slice into `batch-input.tsv`.
   Wired into `modes/pipeline.md` Step 1 as the pre-eval gate.
2. **Two-tier models:** Haiku triages "worth a deep eval?"; reserve Opus/Sonnet
   for survivors. (The deterministic triage above may be enough — measure first.)
3. ✅ **Slim per-eval context** — shipped 2026-07-01, completed same day:
   `batch/batch-prompt.md` rewritten as the compact self-contained eval bundle
   (judgment anchors + score-listing.mjs delegation, no CLAUDE.md/modes
   loading), parity-pinned by `scripts/batch-prompt-parity.test.mjs`. The two
   remaining pieces landed too: (a) the frontend's per-listing eval spawns
   (Filter to Database, inbox Evaluate, Add Listing, Generate top 5 reports)
   now ride the same bundle via `--append-system-prompt-file` instead of
   `/career-ops` slash commands — `frontend/src/lib/evalSpawn.ts` owns
   `claudeEvalArgs` + the shared task prompts; (b) workers read a compact CV
   *summary* (`batch/cv-summary.md`, gitignored derived data) generated
   deterministically by `scripts/cv-summary.mjs` (`npm run cv-summary`,
   mtime-gated `--if-stale`), refreshed by the batch runner + frontend eval
   buttons before spawning, with a documented fallback to full `user/cv.md`.
4. **Prompt caching:** cache the rubric+CV prefix across a batch.
5. **Compress output:** TSV row + 1-line rationale for triage/low-scorers; full
   report only for high-scorers worth applying to.
✅ **FIRST STEP: measure — shipped 2026-07-01:** batch workers run with
`--output-format json`; the runner logs per-spawn tokens/cost/turns to
`batch/logs/usage.tsv` (`scripts/lib/batch-usage.mjs`), and the frontend
activity panel shows each spawn's duration + token stats on the result
capstone. Optimize from this data, not guesses.

## ✅ Done (2026-06-27): Pipeline view wired into nav

`frontend/src/components/pipeline/PipelineView.tsx` is now reachable — `pipeline`
ViewId + VIEW_LABELS in `store/nav.ts`, render branch in `AppShell.tsx`, Sidebar
item + CmdK command (mirrors the `scoretrend` wiring). Shipped in the 15-agent
freestyle session (FE round 1).

_(The six interrupted freestyle lanes parked here on 2026-06-25 were all
recovered + merged in the earlier 2-run encore — Pipeline, Reports-rendering,
Database, Scoring-depth, JobSpy, Scan-merge-dedup.)_

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
