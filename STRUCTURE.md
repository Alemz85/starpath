# Repository Structure

Career-Ops — AI job search pipeline (Node.js scripts + Next.js/Electron frontend + Claude Code skills + markdown data layer).

Excludes `.git/`, `node_modules/`, `frontend/.next/` and `frontend/out/` build artifacts.

```
.
├── CLAUDE.md                     # Project instructions for Claude (modes, data contract, rules)
├── DATA_CONTRACT.md              # User-layer vs system-layer file split (CRITICAL)
├── README.md / LICENSE / TODO.md / CONTEXT.md
├── package.json / package-lock.json
│
├── .claude/                      # Claude Code config + locally installed skills
│   ├── settings.local.json
│   └── skills/                   # Each skill = directory with SKILL.md (frontmatter triggers)
│       ├── career-ops/SKILL.md            # Main job-search skill (modes router)
│       ├── career-ops-setup/SKILL.md      # Workspace tuning / onboarding
│       ├── electron-pro/SKILL.md          # Electron desktop-app expertise
│       ├── frontend-design/SKILL.md       # Distinctive frontend generation
│       ├── impeccable/                    # Frontend audit/polish/animate library
│       │   ├── SKILL.md
│       │   ├── agents/openai.yaml
│       │   ├── reference/  (35 .md guides: audit, polish, layout, motion, color, …)
│       │   └── scripts/    (15 .mjs/.js: live preview, screenshots, design parser)
│       ├── web-design-guidelines/SKILL.md
│       └── webapp-testing/                # Playwright local-app testing
│           ├── SKILL.md / LICENSE.txt
│           ├── examples/ (3 py)
│           └── scripts/with_server.py
│
├── modes/                        # Mode prompts loaded by the career-ops skill (flat, no subdirs)
│   ├── _shared.md                # Shared scoring framework + archetype scaffolding
│   ├── scouting.md               # The single evaluation mode — header + dim table + role summary + gaps + comp + recommendation + career path
│   ├── ofertas.md                # Compare multiple offers (different from `scouting` — read-only analysis across N existing evals)
│   ├── apply.md / pdf.md         # Live application form helper + ATS PDF generation
│   ├── pipeline.md / batch.md    # URL inbox + parallel batch workers
│   ├── scan.md                   # Zero-token portal scanner driver
│   ├── deep.md / contacto.md     # Company research + LinkedIn outreach
│   ├── interview-prep.md         # Per-listing application prep (interview intel + STAR mapping)
│   ├── tracker.md / db.md / deadlines.md / patterns.md / followup.md
│   ├── positioning.md            # Holistic career positioning report
│   └── project.md / training.md  # Portfolio project + course/cert evaluation
│
├── scripts/                      # CLI entrypoints invoked by modes via `node scripts/<name>.mjs`
│   ├── scan.mjs                  # Greenhouse/Ashby/Lever portal scanner (zero-LLM)
│   ├── check-liveness.mjs / liveness-core.mjs
│   ├── generate-pdf.mjs          # Playwright HTML→PDF
│   ├── merge-tracker.mjs / merge-scouting.mjs
│   ├── promote-to-applications.mjs
│   ├── dedup-tracker.mjs / rebuild-dedup-index.mjs
│   ├── normalize-statuses.mjs / verify-pipeline.mjs / doctor.mjs
│   ├── analyze-patterns.mjs / followup-cadence.mjs
│   ├── cv-sync-check.mjs
│   └── test-all.mjs              # 60+ CI checks
│
├── user/                         # User-layer (NEVER auto-overwritten)
│   ├── cv.md                     # Canonical CV (markdown)
│   ├── profile.yml               # Identity, comp targets, phase (scoring weights), archetypes
│   ├── _profile.md               # Free-form personalization (narrative, deal-breakers)
│   └── portals.yml               # Job portals + keyword filters
│
├── data/                         # Generated state (user-owned)
│   ├── applications.md           # Active applications tracker (entries the user has decided to apply to)
│   ├── scouting.md               # Landscape inventory tracker (every evaluation lands here by default)
│   ├── pipeline.md               # Pending URL inbox
│   ├── scan-history.tsv / score-history.tsv / report-summaries.tsv
│   ├── comp-cache.tsv / dedup-index.tsv / filter-audit-state.json
│   └── companies/
│
├── reports/                      # Per-evaluation reports (user-owned)
│   ├── tier-1/  tier-2/  tier-3/  tier-4/   # Sorted by score
│   └── positioning/                          # Career positioning reports
│
├── batch/                        # Parallel-worker batch infrastructure
│   ├── batch-prompt.md / batch-runner.sh / README.md
│   ├── tracker-additions/        # TSV staging → merge-tracker.mjs
│   ├── scouting-additions/       # TSV staging → merge-scouting.mjs
│   └── logs/
│
├── templates/                    # System defaults (copied into user/ at setup)
│   ├── cv-template.html          # ATS HTML template (→ generate-pdf.mjs)
│   ├── states.yml                # Canonical application states
│   └── README.md
│
├── config/profile.example.yml    # Example to seed user/profile.yml
├── docs/                         # ARCHITECTURE / CUSTOMIZATION / SCRIPTS / SETUP / design
├── interview-prep/               # Per-company prep + story-bank.md
├── jds/                          # Saved JD text files (referenced by pipeline)
├── output/                       # Generated PDFs (gitignored)
├── fonts/                        # DM Sans / Space Grotesk woff2 (CV typography)
│
└── frontend/                     # Next.js 14 (App Router) + Electron desktop shell — branded "starpath"
    ├── ARCHITECTURE.md           # Cache + IPC deep-dive (read alongside CONTEXT.md)
    ├── package.json / tsconfig*.json / next.config.mjs / tailwind.config.ts
    ├── postcss.config.mjs / build-icon.mjs / README.md
    ├── electron/
    │   ├── main.ts               # IPC handlers, window, CSP, spawn, logo cache
    │   ├── preload.ts            # contextBridge surface (typed via ElectronAPI)
    │   └── db/                   # SQLite cache: schema.ts, sync.ts, index.ts
    ├── dist-electron/            # Compiled output: electron/* + src/lib/parsers/*
    ├── assets/                   # Icons, dmg background
    └── src/
        ├── app/                  # Next.js App Router. layout.tsx mounts AppShell;
        │                         # page.tsx + applying/, database/, reports/, scan/,
        │                         # company/, settings/, trends/ each have a thin
        │                         # page.tsx for static-export deep links
        ├── components/           # applying, command-center, company, configuration,
        │                         # database, layout, onboarding, profile, reports,
        │                         # scan, settings, shared, trends, ui
        ├── lib/                  # ipc.ts, utils.ts, parsers/{markdown,tsv,yaml}.ts
        ├── store/                # Zustand: app, data, nav, spawns, configDirty,
        │                         # databaseFilters, scanFilter
        └── types/index.ts        # All shared types + TIER_COLORS / STATUS_COLORS / TIER_LABELS
```

## Claude Code architecture surface

- **Skills** (`.claude/skills/*/SKILL.md`) — frontmatter-triggered capabilities. Career-ops is one; impeccable/frontend-design/electron-pro/web-design-guidelines/webapp-testing are general-purpose.
- **Modes** (`modes/*.md`) — invoked by the career-ops skill via the OpenCode/Claude Code `/career-ops <mode>` slash commands; each mode is a self-contained prompt.
- **Settings** (`.claude/settings.local.json`) — local permissions/hooks/env per project.
- **Mode languages** — there are **no language-variant directories on disk today**. `modes/` is flat (English-authored prompts only). Multi-language output is handled inside the modes themselves — `modes/_shared.md` instructs Claude to "Generate content in the language of the JD (EN default)", so a German JD produces a German report from the same English prompt. `DATA_CONTRACT.md` reserves `modes/de/*` as a system-layer slot for future per-market translations, but no routing logic exists in either backend modes or the frontend that would pick a variant directory; if you add `modes/de/` etc., you'll also need to introduce that routing layer (likely in the career-ops skill front-matter or a new mode loader) — confirm the approach with the user before creating parallel files.
- **Update channel** — none. starpath was originally forked from `santifer/career-ops` and tracked upstream early on; the project has since diverged enough that it's no longer a downstream fork. System-layer files are maintained by hand.
