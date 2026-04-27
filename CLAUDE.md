# Career-Ops -- AI Job Search Pipeline

AI-powered job search automation built on Claude Code: pipeline tracking, offer evaluation, CV generation, portal scanning, batch processing.

The system was built and used by [santifer](https://santifer.io) and is **designed to be made yours**. You (AI Agent) can edit the user's files. When the user asks to change archetypes, scoring, negotiation scripts, etc., do it directly. That's the whole point.

## Data Contract (CRITICAL)

Two layers. Read `DATA_CONTRACT.md` for the full list.

**User Layer (NEVER auto-updated, personalization goes HERE):**
- `user/cv.md`, `user/profile.yml`, `user/_profile.md`, `user/article-digest.md`, `user/portals.yml`
- `data/*`, `reports/*`, `output/*`, `interview-prep/*`

**System Layer (auto-updatable, DON'T put user data here):**
- `modes/*`, `CLAUDE.md`, `*.mjs` scripts, `templates/*`, `batch/*`, `frontend/*`

**THE RULE:** When the user asks to customize anything (archetypes, narrative, negotiation scripts, proof points, location policy, comp targets), ALWAYS write to `user/_profile.md` or `user/profile.yml`. NEVER edit `modes/_shared.md` for user-specific content. This ensures system updates don't overwrite their customizations.

## Update Check

On the first message of each session, run silently:

```bash
node scripts/update-system.mjs check
```

Parse the JSON output:
- `{"status": "update-available", "local": ..., "remote": ..., "changelog": ...}` → tell the user: *"career-ops update available (v{local} → v{remote}). Your data (CV, profile, tracker, reports) will NOT be touched. Want me to update?"* If yes → `node scripts/update-system.mjs apply`. If no → `node scripts/update-system.mjs dismiss`.
- `{"status": "up-to-date" | "dismissed" | "offline"}` → say nothing.

The user can also say "check for updates" at any time. Rollback: `node scripts/update-system.mjs rollback`.

## Main Files

| File | Function |
|------|----------|
| `data/applications.md` | Active application tracker (`oferta` mode) |
| `data/scouting.md` | Scouting landscape tracker (`scouting` mode) |
| `data/pipeline.md` | Inbox of pending URLs |
| `data/scan-history.tsv` | Scanner dedup history |
| `data/score-history.tsv` | Per-archetype score log written by every evaluation (feeds `positioning`) |
| `user/portals.yml` | Query and company config for `scan` |
| `user/article-digest.md` | Compact proof points from portfolio (optional) |
| `interview-prep/story-bank.md` | Accumulated STAR+R stories across evaluations |
| `templates/cv-template.html` | HTML template for CVs |
| `reports/tier-{1..4}/{Company} - {Role}.md` | Evaluation reports (Blocks A-F + G legitimacy + H dimensional) |

Key scripts (all under `scripts/`): `scan.mjs` (zero-token portal scanner — Greenhouse/Ashby/Lever APIs), `generate-pdf.mjs` (Playwright HTML→PDF), `merge-tracker.mjs` / `merge-scouting.mjs` (TSV → markdown merge), `promote-to-applications.mjs` (T1 scouting → applications), `verify-pipeline.mjs` / `dedup-tracker.mjs` / `normalize-statuses.mjs` (health), `check-liveness.mjs` (posting liveness), `analyze-patterns.mjs` / `followup-cadence.mjs` (analysis).

## First Run — Onboarding

**Before doing ANYTHING else, check that all of these exist:**
1. `user/cv.md`
2. `user/profile.yml`
3. `user/_profile.md`
4. `user/portals.yml`

**If ANY is missing, enter onboarding mode.** Do NOT proceed with evaluations, scans, or any other mode until the basics are in place.

- **CV missing** → ask for paste / LinkedIn URL / verbal description; create clean markdown with Summary, Experience, Projects, Education, Skills.
- **profile.yml missing** → copy `config/profile.example.yml` → `user/profile.yml`; ask for name, email, location, target roles, salary range.
- **_profile.md missing** → create from scratch from the user's profile and goals. This is the user's customization file (archetypes, narrative, negotiation scripts), never overwritten by updates.
- **portals.yml missing** → create with target-role keywords; the scanner uses this for Greenhouse/Ashby/Lever queries.
- **applications.md missing** → create with header `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |`.

**After basics are set, proactively get to know the user** — superpower / what excites or drains them / deal-breakers / best achievement / published work. Store insights in `user/profile.yml`, `user/_profile.md`, or `user/article-digest.md`. The system gets smarter with every interaction.

**After every evaluation, learn.** If the user corrects a score or notes missing context, update `user/_profile.md` / `user/profile.yml` / `user/article-digest.md`. Never put personalization into system-layer files.

**Once set up,** offer automation: use `/loop` or `/schedule` (if available) for recurring `/career-ops scan`; otherwise suggest cron or periodic manual runs.

## Personalization

This system is designed to be customized by you (AI Agent). Common requests:

- *"Change the archetypes to [X] roles"* → edit `user/_profile.md` or `user/profile.yml`
- *"Add these companies to my portals"* → edit `user/portals.yml`
- *"Update my profile"* → edit `user/profile.yml`
- *"Change the CV template design"* → edit `templates/cv-template.html`
- *"Adjust the scoring weights"* → edit `user/_profile.md` for user-specific weighting; only edit `modes/_shared.md` and `batch/batch-prompt.md` when changing system defaults for everyone.

## Skill Modes

| If the user... | Mode |
|----------------|------|
| Pastes JD or URL | auto-pipeline — routes to `scouting` or `oferta` based on `user/profile.yml → current_mode` |
| Is mapping the market (default today) | `scouting` — lightweight Current Fit + Aspirational Fit eval, no per-listing PDF |
| Wants a holistic career review across all data | `positioning` |
| Asks to evaluate offer for active application | `oferta` |
| Asks to compare offers | `ofertas` |
| Wants LinkedIn outreach | `contacto` |
| Asks for company research | `deep` |
| Preps for interview at specific company | `interview-prep` |
| Wants to generate CV/PDF | `pdf` |
| Evaluates a course/cert | `training` |
| Evaluates portfolio project | `project` |
| Asks about application status | `tracker` |
| Fills out application form | `apply` |
| Searches for new offers | `scan` |
| Processes pending URLs | `pipeline` |
| Batch processes offers | `batch` |
| Asks about rejection patterns or wants to improve targeting | `patterns` |
| Asks about follow-ups or application cadence | `followup` |
| Asks about deadlines, closing dates, what's urgent | `deadlines` |
| Wants to browse/filter all evaluated offers as a table | `db` |

**Mode switching:** `user/profile.yml → current_mode` is `scouting` (default for landscape mapping) or `job-seeking` (full oferta + tailored PDF). Explicit sub-commands (`/career-ops oferta`, `/career-ops scouting`) always override `current_mode`. When the user says "I'm actively applying now" or "I'm done exploring", flip the field.

## CV Source of Truth

- `user/cv.md` is canonical
- `user/article-digest.md` has detailed proof points (optional)
- **NEVER hardcode metrics** — read them from these files at evaluation time

---

## Ethical Use -- CRITICAL

**This system is designed for quality, not quantity.** Help the user find roles where there is a genuine match — not spam companies with mass applications.

- **NEVER submit an application without the user reviewing it first.** Fill forms, draft answers, generate PDFs — but always STOP before clicking Submit/Send/Apply. The user makes the final call.
- **Strongly discourage low-fit applications.** If the global Score is below 7.0/10, explicitly recommend against applying (see `modes/_shared.md` § Score interpretation). Only proceed if the user has a specific reason to override.
- **Quality over speed.** A well-targeted application to 5 companies beats a generic blast to 50.
- **Respect recruiters' time.** Every application a human reads costs someone's attention. Only send what's worth reading.

---

## Offer Verification -- MANDATORY

**NEVER trust WebSearch/WebFetch to verify if an offer is still active.** ALWAYS use Playwright:
1. `browser_navigate` to the URL
2. `browser_snapshot` to read content
3. Only footer/navbar without JD = closed. Title + description + Apply = active.

**Exception for batch workers (`claude -p`):** Playwright is not available in headless pipe mode. Use WebFetch as fallback and mark the report header with `**Verification:** unconfirmed (batch mode)`. The user can verify manually later.

---

## Stack and Conventions

- Node.js (`.mjs` modules), Playwright (PDF + scraping), YAML (config), HTML/CSS (template), Markdown (data), Canva MCP (optional visual CV)
- Output in `output/` (gitignored), Reports in `reports/`
- JDs in `jds/` (referenced as `local:jds/{file}` in pipeline.md)
- Batch in `batch/` (gitignored except scripts and prompt)
- Report naming: `{Company} - {Role}.md` (human-readable, no sequential numbering in filenames)
- **Frontend cache:** the Electron app mirrors `data/*` and `reports/**` into a SQLite cache at `{userData}/cache.db` for fast queries. It is fully derived from the Markdown/TSV files and rebuilds on launch via mtime comparison + a chokidar watcher. Markdown/TSV remain canonical; modes never read or write the cache. See `frontend/ARCHITECTURE.md`.
- **RULE: After each batch of evaluations, run `node scripts/merge-tracker.mjs`** to merge tracker additions and avoid duplications.
- **RULE: NEVER create new entries in applications.md if company+role already exists.** Update the existing entry.

### TSV Format for Tracker Additions

Write one TSV file per evaluation to `batch/tracker-additions/{num}-{company-slug}.tsv`. Single line, 10 tab-separated columns:

```
{num}\t{date}\t{company}\t{role}\t{status}\t{score}/10\t{pdf_emoji}\t{deadline}\t[{num}](reports/tier-{N}/{num}-{slug}-{date}.md)\t{note}
```

**Column order (status BEFORE score in TSV):** `num`, `date`, `company`, `role`, `status` (canonical, e.g. `Evaluated`), `score` (`X.X/10`), `pdf` (`✅`/`❌`), `deadline` (`2026-06-30` | `Rolling` | `n/d`), `report` (markdown link to `reports/tier-{N}/...` where `N` derives from score: `≥9.0→1`, `7.0-8.9→2`, `<7.0→3`, `SKIP→4`), `notes`.

In `applications.md`, score comes BEFORE status — `scripts/merge-tracker.mjs` swaps columns automatically and rewrites flat `reports/...md` paths into the correct tier subfolder if the writer leaves the tier off. The canonical TSV form is the tiered path.

For scouting (separate flow), see `modes/scouting.md` § "Tracker Entry" — scouting writes 11-column TSVs to `batch/scouting-additions/`.

### Pipeline Integrity

1. **NEVER edit applications.md to ADD new entries** — write TSV in `batch/tracker-additions/` and `scripts/merge-tracker.mjs` handles the merge.
2. **YES you can edit applications.md to UPDATE status/notes of existing entries.**
3. All reports MUST include `**URL:**` in the header (between Score and PDF) and `**Legitimacy:** {tier}` (Block G in `modes/oferta.md`).
4. All statuses MUST be canonical (see `templates/states.yml`).
5. Health check: `node scripts/verify-pipeline.mjs` · normalize: `node scripts/normalize-statuses.mjs` · dedup: `node scripts/dedup-tracker.mjs`

### Canonical States (applications.md)

**Source of truth:** `templates/states.yml`

| State | When to use |
|-------|-------------|
| `Evaluated` | Full A-H report completed, pending decision |
| `Applied` | Application sent |
| `Responded` | Company responded |
| `Interview` | In interview process |
| `Offer` | Offer received |
| `Rejected` | Rejected by company |
| `Discarded` | Discarded by candidate or offer closed |
| `SKIP` | Doesn't fit, don't apply |

**RULES:** No markdown bold (`**`) in status field. No dates in status field (use the date column). No extra text (use the notes column).

**Scouting observations** are NOT in this table — they live in `data/scouting.md` with a **Tier** column (`T1`-`T4`) instead of a status. Write scouting TSVs to `batch/scouting-additions/` and run `node scripts/merge-scouting.mjs`. Promote Tier 1 hits to active applications via `node scripts/promote-to-applications.mjs <num>`.
