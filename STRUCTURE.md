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
├── modes/                        # Mode prompts loaded by the career-ops skill
│   ├── _shared.md                # Shared scoring / archetype scaffolding
│   ├── auto-pipeline.md          # Routes pasted JDs to scouting or oferta
│   ├── scouting.md               # Lightweight landscape eval (Current+Aspirational Fit)
│   ├── oferta.md / ofertas.md    # Full A–H eval (single / compare)
│   ├── apply.md / pdf.md         # Live application + ATS PDF generation
│   ├── pipeline.md / batch.md    # URL inbox + parallel batch workers
│   ├── scan.md                   # Zero-token portal scanner driver
│   ├── deep.md / contacto.md     # Company research + LinkedIn outreach
│   ├── interview-prep.md         # Per-company STAR+R prep
│   ├── tracker.md / db.md / deadlines.md / patterns.md / followup.md
│   ├── positioning.md            # Holistic career positioning report
│   ├── project.md / training.md  # Portfolio project + course/cert evaluation
│   └── (modes/de, /fr, /ja exist as language variants — collapsed)
│
├── *.mjs (root scripts)          # CLI entrypoints invoked by modes
│   ├── scan.mjs                  # Greenhouse/Ashby/Lever portal scanner (zero-LLM)
│   ├── check-liveness.mjs / liveness-core.mjs
│   ├── generate-pdf.mjs          # Playwright HTML→PDF
│   ├── merge-tracker.mjs / merge-scouting.mjs
│   ├── promote-to-applications.mjs
│   ├── dedup-tracker.mjs / rebuild-dedup-index.mjs
│   ├── normalize-statuses.mjs / verify-pipeline.mjs / doctor.mjs
│   ├── analyze-patterns.mjs / followup-cadence.mjs
│   ├── cv-sync-check.mjs
│   ├── update-system.mjs         # Self-updater (check/apply/dismiss/rollback)
│   └── test-all.mjs              # 63+ CI checks
│
├── user/                         # User-layer (NEVER auto-overwritten)
│   ├── cv.md                     # Canonical CV (markdown)
│   ├── profile.yml               # Identity, comp targets, current_mode, archetypes
│   ├── _profile.md               # Free-form personalization (narrative, deal-breakers)
│   └── portals.yml               # Job portals + keyword filters
│
├── data/                         # Generated state (user-owned)
│   ├── applications.md           # Active tracker (oferta mode)
│   ├── scouting.md               # Scouting tracker (scouting mode)
│   ├── pipeline.md               # Pending URL inbox
│   ├── scan-history.tsv / score-history.tsv / report-summaries.tsv
│   ├── comp-cache.tsv / dedup-index.tsv / filter-audit-state.json
│   └── companies/
│
├── reports/                      # Per-evaluation A–H reports (user-owned)
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
└── frontend/                     # Next.js 14 (App Router) + Electron desktop shell
    ├── package.json / tsconfig*.json / next.config.mjs / tailwind.config.ts
    ├── postcss.config.mjs / build-icon.mjs / README.md
    ├── electron/                 # main.ts + preload.ts (IPC bridge)
    ├── dist-electron/            # Compiled main/preload
    ├── assets/                   # Icons, dmg background
    └── src/
        ├── app/                  # Next.js routes: page.tsx (command center) +
        │                         # database/, pipeline/, reports/, scan/,
        │                         # settings/, trends/  (each = page.tsx)
        ├── components/           # command-center, database, layout, onboarding,
        │                         # pipeline, profile, reports, scan, settings,
        │                         # shared, trends, ui
        ├── lib/                  # ipc.ts, utils.ts, parsers/{markdown,tsv,yaml}.ts
        ├── store/                # Zustand: app.ts, data.ts, nav.ts
        └── types/index.ts
```

## Claude Code architecture surface

- **Skills** (`.claude/skills/*/SKILL.md`) — frontmatter-triggered capabilities. Career-ops is one; impeccable/frontend-design/electron-pro/web-design-guidelines/webapp-testing are general-purpose.
- **Modes** (`modes/*.md`) — invoked by the career-ops skill via the OpenCode/Claude Code `/career-ops <mode>` slash commands; each mode is a self-contained prompt.
- **Settings** (`.claude/settings.local.json`) — local permissions/hooks/env per project.
- **Mode languages** — `modes/de/`, `modes/fr/`, `modes/ja/` mirror the English modes for DACH/Francophone/Japan markets.
- **Update channel** — `update-system.mjs` pulls system-layer updates without touching `user/`, `data/`, `reports/`, `output/`, `interview-prep/`.
