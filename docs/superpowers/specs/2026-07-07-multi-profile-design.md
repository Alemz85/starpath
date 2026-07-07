# Multi-Profile Job Search — Design (approved 2026-07-07)

One installation, several *search profiles*. A profile = one job search: its
preferences, scan keywords, scoring calibration, and its own database. Example:
`career` (the current search) vs `cph-student` (any student job in Copenhagen,
part-time, DKK band, role-agnostic archetypes). Exactly one profile is active
at a time, globally.

**Architecture: symlink swap.** Real files live under `profiles/<slug>/…`; the
canonical paths every script, mode prompt, and the frontend already use become
symlinks into the active profile. Switching re-points the symlinks. This keeps
all ~25 scripts, `CLAUDE.md`, `modes/*`, and `batch/batch-prompt.md` working
verbatim — workers always see "the" database, which is the active profile's.
All affected files are gitignored personal data, so git never sees the links.

## 1. What forks, what stays shared

**Per-profile (the 18 canonical paths that become symlinks):**

| # | Canonical path | Kind |
|---|----------------|------|
| 1 | `user/profile.yml` | file |
| 2 | `user/portals.yml` | file |
| 3 | `user/_profile.md` | file |
| 4 | `data/scouting.md` | file |
| 5 | `data/applications.md` | file |
| 6 | `data/pipeline.md` | file |
| 7 | `data/scan-history.tsv` | file |
| 8 | `data/score-history.tsv` | file |
| 9 | `data/dedup-index.tsv` | file |
| 10 | `data/discarded.tsv` | file |
| 11 | `data/report-summaries.tsv` | file |
| 12 | `data/filter-audit-state.json` | file |
| 13–18 | `reports/tier-1` … `reports/tier-4`, `reports/positioning`, `reports/briefs` | directories |

`reports/` itself stays a **real directory** — `reports/.gitkeep` is git-tracked
and must keep existing at its canonical path. Only its six content
subdirectories are symlinked. Consequences:

- Untrack `reports/tier-{1..4}/.gitkeep` (`git rm --cached`) and simplify the
  `.gitignore` reports rules to `reports/*` + `!reports/.gitkeep`, so the
  symlinked subdirs (and any report file) are ignored. Report writers already
  create parent dirs on demand, and every profile scaffolds all six subdirs,
  so nothing depends on the tracked tier `.gitkeep`s.
- Doctor flags unexpected *real* children of `reports/` (anything besides
  `.gitkeep` and the six symlinks) so future additions get classified
  deliberately.

**Shared (stay real files, single copy):** `user/cv.md`, `user/article-digest.md`,
`data/network.md`, `data/outreach.md`, `data/companies/`, `data/comp-cache.tsv`,
`data/tax-cache.tsv`, `data/col-cache.tsv`, `interview-prep/` (incl. story
bank), `jds/`, `output/`, `batch/`.

Dedup is deliberately per-profile: the same listing may be evaluated in both
searches with different, honest scores — they answer different questions.

## 2. On-disk layout

```
profiles/
  active                 # one line: the active slug, e.g. "career\n"
  career/
    meta.yml             # label: "Career search"  \n  created: 2026-07-07
    user/                # profile.yml, portals.yml, _profile.md
    data/                # the 9 data files above
    reports/             # tier-1..4/, briefs/
  cph-student/           # same structure
```

- Slug rules: `^[a-z0-9][a-z0-9-]{0,31}$`; `active` is reserved.
- `profiles/` is fully gitignored (add to `.gitignore`).
- Missing-file tolerance: a profile dir must contain `user/` + `data/` +
  `reports/` + `meta.yml`; individual tracker files are scaffolded with
  correct headers at create time.

## 3. CLI — `scripts/profile.mjs` (npm alias `npm run profile`)

Pure logic in `scripts/lib/profile-core.mjs` (path plans, guard evaluation,
slug validation, meta parse/serialize) with unit tests; `profile.mjs` is thin
I/O, per repo convention.

Commands (all accept `--json` for machine consumption):

- `list` — every profile + active flag + per-tracker row counts
  (scouting/applications/pipeline rows, report file count).
- `switch <slug> [--force]` — run guards; atomically re-point the 18 symlinks
  (create temp link, `fs.renameSync` over the old — atomic on POSIX); write
  `profiles/active` **last**.
- `create <slug> [--from <otherSlug>] [--label "…"] [--switch]` — scaffold
  empty trackers with the exact canonical headers; `--from` copies the three
  config files (`profile.yml`, `portals.yml`, `_profile.md`) from an existing
  profile as the starting point. Does not switch unless `--switch`.
- `init [<slug>] [--label "…"]` — one-time migration (default slug `career`):
  move the current live files into `profiles/<slug>/` (pure `rename`, same
  filesystem), create the symlinks, write `profiles/active`. Idempotent:
  refuses if `profiles/active` already exists. Runs the same guards as switch.
- `eject [--force]` — full rollback: replace each symlink with the real file
  from the active profile (move back), delete `profiles/active`. Other profile
  dirs are left untouched on disk.

**Switch/init guards** (each refusal has a one-line reason; `--force` overrides):

1. Unmerged eval output: any `*.tsv` directly in `batch/tracker-additions/` or
   `batch/scouting-additions/` (their `merged/` subdirs don't count).
2. In-flight batch workers per `batch/batch-state.tsv` (parse the actual
   format used by `batch/batch-runner.sh`).
3. Unmerged aggregator staging: `data/scan-history.jobspy.tsv` or
   `data/pipeline.jobspy.md` present.

**JSON shapes (contract for the frontend):**

```jsonc
// switch / init / eject / create
{ "ok": true, "active": "cph-student", "previous": "career" }
{ "ok": false, "error": "guards", "guardFailures": ["unmerged TSVs in batch/scouting-additions (3 files)"] }
{ "ok": false, "error": "unknown-profile", "message": "no profile 'x'" }
// list
{ "active": "career", "profiles": [ { "slug": "career", "label": "Career search",
  "created": "2026-07-07", "active": true,
  "counts": { "scouting": 210, "applications": 34, "pipeline": 12, "reports": 118 } } ] }
```

Exit code 0 on ok, 1 on refusal/error (JSON still printed with `--json`).

## 4. Correctness details (must-handle)

- **Atomic-write shadowing:** any script that writes one of the per-profile paths via
  write-temp-then-rename would replace the symlink with a real file. Audit all
  writers of the per-profile paths; where the rename pattern is used, resolve
  `fs.realpathSync(target)` first (write through to the profile file). Plain
  `writeFileSync` already follows symlinks and is fine.
- **`batch/cv-summary.md` staleness across switches:** the summary derives
  from `user/cv.md` + `user/profile.yml` and is mtime-gated (`--if-stale`).
  After a switch, the new profile.yml's target mtime may be *older* than a
  summary generated under the other profile → silently reused wrong summary.
  Fix: stamp the active slug into the generated file (HTML comment,
  `<!-- profile: career -->`); `--if-stale` regenerates when stamp ≠ current
  active slug (treat missing stamp or missing `profiles/` as always-matching
  for pre-migration compat).
- **Pre-migration compat:** every touched script/check must behave identically
  when `profiles/` doesn't exist (fresh clones, other users). Doctor reports
  "single-profile layout" as OK, cv-summary skips the slug check, frontend
  shows no switcher (or a passive "default" state) when `profile:list` says
  no profiles.
- **`doctor.mjs` new checks (in `scripts/lib/doctor-checks.mjs`):** valid
  `profiles/active` pointing at an existing profile dir; each of the 18
  canonical paths is a symlink resolving into `profiles/<active>/`; no
  real-file shadows; profile dirs structurally complete. All skipped (with an
  informative OK line) when `profiles/` is absent.

## 5. Frontend (Electron)

- **IPC (main):** `profile:list`, `profile:active`, `profile:switch(slug)`,
  `profile:create({slug, from, label})` — implemented by shelling out to
  `node scripts/profile.mjs … --json` with `cwd: repoPath` (single
  implementation of guards/switch logic). Expose via preload.
- **Per-profile SQLite cache:** cache file becomes `cache-<slug>.db` in
  userData (slug `default` when `profiles/` absent). On switch: close db,
  open target profile's cache, run the existing mtime resync, **restart the
  chokidar watcher** (symlink targets changed), then notify the renderer to
  refetch (existing data-store load path).
- **Sidebar switcher** (top of sidebar, directly under the wordmark row —
  workspace-switcher pattern, not a badge): expanded shows `● <label> ▾` as a
  full-width row; collapsed shows the profile initial in a small circle.
  Click → popover listing profiles (label + row counts) + "New profile…".
  Guard refusals from switch surface verbatim in the popover. Hidden entirely
  when the repo has no `profiles/` (pre-migration).
- **CmdK:** "Switch to profile: <label>" commands.
- **Settings → Profiles section:** list with counts, create form (slug, label,
  copy-config-from picker), switch buttons. Eject stays CLI-only.
- Styling: existing tokens/patterns only, per `DESIGN-meta.md`. No per-profile
  color coding in v1 (would need a DESIGN-meta update).

## 6. Docs

- `CLAUDE.md`: short **Profiles** section — layout, "canonical paths are
  symlinks managed by `scripts/profile.mjs`; never write into an inactive
  profile directly; never replace a canonical symlink with a real file".
- `DATA_CONTRACT.md`: add `profiles/*` to the user layer.
- `.gitignore`: add `profiles/`.

## 7. Testing

- `profile-core.test.mjs` — plans, guards, slug validation, meta round-trip.
- CLI integration test (node:test, real fs in a temp dir): init → create
  --from → switch → guard refusal → eject; verifies symlink targets and file
  contents survive the round-trip.
- cv-summary slug-staleness unit test; doctor-check tests (both layouts).
- Frontend: pure-logic tests in the existing node:test harness; typecheck +
  build must pass.
- On the real repo after merge: `npm run doctor`, `npm run brief`, and a
  scan under the migrated layout.

## 8. Rollout

1. Land the feature (this branch).
2. `npm run profile -- init career` on the live repo (guards must pass).
3. `npm run profile -- create cph-student --from career --label "Copenhagen student"`.
4. Tune `cph-student`'s config through the normal career-ops personalization
   flow (role-agnostic archetypes, DKK part-time comp band, Copenhagen-only
   location, student-job portal keywords) — content, not code; separate step.
