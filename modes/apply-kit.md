# Mode: apply-kit -- Application-Kit Readiness Orchestrator

## Purpose

Applying *well* to one listing is not a single act — it needs several artifacts to
exist for that `company + role`, and each is produced by a different mode:

- a **scouting report** (the fit decision) — `scouting`
- a **tailored, ATS-checked CV** — `pdf`
- **drafted application answers** / cover-letter content — `apply`
- **cached company research** — `deep`
- an **outreach / referral plan** — `contacto`

Nothing gives a single *"is this application ready to send, and what's missing?"*
view. This mode is that orchestrator. For one listing it inspects what is already
on disk, produces a **readiness checklist**, and for every gap names the **exact
next action** — delegating to the right existing mode. It is the application-stage
counterpart to `brief` (which orchestrates across the whole pipeline): `brief`
answers *"what should I do today across everything?"*, `apply-kit` answers *"what's
left before THIS application is ready?"*.

**It generates nothing and submits nothing.** It only reports readiness and points
at the modes that close each gap. The user runs those modes, reviews the output,
and submits themselves — the Ethical-Use rule in `CLAUDE.md` (never auto-submit)
holds by construction.

Use `apply-kit` when the user asks things like: "is my Acme application ready to
send?", "what's left before I apply to {company}?", "which of my applications are
fully prepped?", "what am I missing for this role?".

## What it checks

| Artifact | Looks for | Status when present | Gap → mode |
|----------|-----------|---------------------|------------|
| **Scouting report** | `reports/tier-{1..4}/{Company} - {Role}.md` | `ready` (with tier) | `scouting` |
| **Tailored CV** | `output/cv-…{company}…-{date}.{pdf,html}` (newest wins) | `ready`; `stale` if ATS coverage is known-low | `pdf` |
| **Drafted answers** | `interview-prep/{Company} - {Role}.md` | `ready` | `apply` |
| **Company research** | `data/companies/{slug}.md` + freshness | `ready` if fresh+valid; `stale` if old/invalid | `deep` |
| **Outreach plan** | rows in `data/outreach.md` matching the company | `ready` (contacts + touches) | `contacto` |

The **story bank** (`interview-prep/story-bank.md`) is a *cross-listing* asset, so
it is not a per-listing gate — it surfaces as a supporting note (story count +
health + competency-gap count) because drafting strong answers leans on it.

**Blocking vs. optional.** The scouting report and the tailored CV are *blocking*:
if either is missing, the kit is **BLOCKED** (not ready to send). Drafted answers
and research are non-blocking but expected. Outreach is *optional* — a referral
lifts response rates, but its absence never blocks a send. The verdict and the
single highest-leverage next action fall out of that weighting.

## Inputs

All read-only. Nothing here is required to exist — a missing artifact is simply a
gap the checklist reports.

- `reports/tier-{1..4}/` — scouting reports (decision artifact)
- `output/` — tailored CVs (gitignored)
- `interview-prep/{Company} - {Role}.md` — drafted answers / prep
- `data/companies/{slug}.md` — cached deep research (freshness via `company-research-core`)
- `data/outreach.md` — the outreach log
- `interview-prep/story-bank.md` — supporting signal
- `data/applications.md` — only for `--all` (to enumerate tracked listings)

## Step 1 — Run the checker

```bash
node scripts/apply-kit.mjs "{Company}" "{Role}"      # readiness for one listing
node scripts/apply-kit.mjs "{Company}" "{Role}" --json   # structured JSON
node scripts/apply-kit.mjs --all                     # roster of every tracked listing
node scripts/apply-kit.mjs --all --json              # the roster as JSON
node scripts/apply-kit.mjs "{Company}" "{Role}" --write  # also write reports/kits/{slug}-{role}.md
```

The role is optional — with a company alone it matches the first report/prep file
for that company. Company and role are matched tolerantly (case / punctuation /
spacing), so the exact filename casing isn't required.

The single-listing JSON shape:

| Key | Contents |
|-----|----------|
| `company`, `role`, `slug` | the resolved listing |
| `checks` | `[{ id, label, mode, status, blocking, optional, weight, detail, next, meta }]` in fixed order |
| `summary` | `{ ready, stale, missing }` counts |
| `verdict` | `ready` \| `sendable-with-gaps` \| `blocked` |
| `readyToSend` | `true` only if no *blocking* artifact is missing |
| `completeness` | weighted 0..1 (stale artifacts earn half credit) |
| `topAction` | `{ id, label, mode, status, hint }` — the one gap to close next, or `null` |
| `note` | story-bank supporting note `{ level, text }` |

Exit code (single listing): `0` if ready-to-send, `1` if blocked. `--all` is
always `0`.

## Step 2 — Present the readiness, then route the next action

Relay the checklist, leading with the **verdict** and the **one thing to do next**
(`topAction`). For each gap, state which artifact is missing/stale and **which
mode produces it**.

Then offer to *run that mode* — this is the orchestration payoff. If the user
agrees, hand off to the named mode (`scouting` / `pdf` / `apply` / `deep` /
`contacto`) for that listing. After it produces its artifact, re-run `apply-kit`
to confirm the gap closed and surface the next one. Work the checklist top-down:
blocking gaps first (report, then CV), then answers and research, then outreach.

For a portfolio view ("which applications are prepped?"), use `--all`: it prints a
roster sorted least-ready-first so the user sees where to spend effort.

## Guardrails

- **Read-only + never submit.** This mode and `scripts/apply-kit.mjs` only inspect
  files and report. They never generate an artifact, never write to a user data
  file (except the opt-in `--write`, which emits a readiness *report* to
  `reports/kits/`), and never submit an application. Closing a gap is always done
  by the delegated mode, with the user reviewing before any send.
- **Don't fabricate readiness.** If an artifact isn't on disk, it's a gap — don't
  claim it exists. The checker reports exactly what it found.
- **Blocking is about essentials, not perfection.** A `sendable-with-gaps` verdict
  means the core artifacts (report + CV) are present and the application *can* go
  out; remaining gaps (answers/research/outreach) are quality multipliers, not
  blockers. Be honest about that distinction rather than gating on 100%.
- **Respect the score bar.** Readiness is orthogonal to fit. If the scouting
  report's Score is below the apply bar (see `modes/_shared.md`), a "ready" kit
  still shouldn't be sent — surface the score caveat alongside readiness.
- **All logic stays pure + tested.** Status/verdict/ranking live in
  `scripts/lib/apply-kit-core.mjs` (unit-tested); the CLI is only I/O. Keep it
  that way — don't push readiness rules into the CLI or the prose.
