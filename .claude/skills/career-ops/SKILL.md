---
name: career-ops
description: AI job search command center -- evaluate offers, generate CVs, scan portals, track applications
user_invocable: true
args: mode
argument-hint: "[scan | deep | pdf | oferta | ofertas | scouting | positioning | apply | batch | tracker | pipeline | contacto | training | project | interview-prep | update]"
---

# career-ops -- Router

## Mode Routing

Determine the mode from `{{mode}}`:

| Input | Mode |
|-------|------|
| (empty / no args) | `discovery` -- Show command menu |
| JD text or URL (no sub-command) | **`auto-pipeline`** (routes by `current_mode` — see below) |
| `scouting` | `scouting` |
| `positioning` | `positioning` |
| `oferta` | `oferta` |
| `ofertas` | `ofertas` |
| `contacto` | `contacto` |
| `deep` | `deep` |
| `pdf` | `pdf` |
| `training` | `training` |
| `project` | `project` |
| `tracker` | `tracker` |
| `pipeline` | `pipeline` |
| `apply` | `apply` |
| `scan` | `scan` |
| `batch` | `batch` |
| `patterns` | `patterns` |
| `followup` | `followup` |

**Auto-pipeline detection:** If `{{mode}}` is not a known sub-command AND contains JD text (keywords: "responsibilities", "requirements", "qualifications", "about the role", "we're looking for", company name + role) or a URL to a JD, execute `auto-pipeline`.

**Mode-aware routing for auto-pipeline:** Before running `auto-pipeline`, read `user/profile.yml` → `current_mode`. If it is `scouting` (default for landscape mapping), route the JD through `modes/scouting.md` instead of `modes/oferta.md`. If `current_mode: applying`, route through the full `auto-pipeline` → `oferta` path as before. Explicit sub-commands (`/career-ops oferta`, `/career-ops scouting`) always override `current_mode`.

If `{{mode}}` is not a sub-command AND doesn't look like a JD, show discovery.

---

## Discovery Mode (no arguments)

Show this menu (tell the user which mode is active — read `user/profile.yml` → `current_mode` and note "Active mode: scouting" or "Active mode: applying" at the top):

```
career-ops -- Command Center

Active mode: {scouting | applying}   (set in user/profile.yml → current_mode)

Landscape mapping:
  /career-ops scouting     → Lightweight eval: Current Fit + Aspirational Fit, no per-listing PDF
  /career-ops positioning  → Holistic Career Positioning Report across ALL accumulated data

Active application:
  /career-ops {JD}      → AUTO-PIPELINE: routes by current_mode (scouting or oferta)
  /career-ops oferta    → Full A-H evaluation (A-F + G legitimacy + H dimensional) + tailored PDF
  /career-ops ofertas   → Compare and rank multiple offers
  /career-ops contacto  → LinkedIn power move: find contacts + draft message
  /career-ops apply     → Live application assistant (reads form + generates answers)
  /career-ops pdf       → PDF only, ATS-optimized CV

Research and triage:
  /career-ops deep      → Deep research prompt about company
  /career-ops training  → Evaluate course/cert against North Star
  /career-ops project   → Evaluate portfolio project idea

Pipeline and data:
  /career-ops pipeline  → Process pending URLs from inbox (data/pipeline.md)
  /career-ops tracker   → Application status overview
  /career-ops scan      → Scan portals and discover new offers
  /career-ops batch     → Batch processing with parallel workers
  /career-ops patterns  → Analyze rejection patterns and improve targeting
  /career-ops followup  → Follow-up cadence tracker: flag overdue, generate drafts

Inbox: add URLs to data/pipeline.md → /career-ops pipeline
Or paste a JD directly to run auto-pipeline (routes by current_mode).
```

---

## Context Loading by Mode

After determining the mode, load the necessary files before executing:

### Modes that require `_shared.md` + their mode file:
Read `modes/_shared.md` + `modes/{mode}.md`

Applies to: `auto-pipeline`, `oferta`, `ofertas`, `scouting`, `pdf`, `contacto`, `apply`, `pipeline`, `scan`, `batch`

### Standalone modes (only their mode file):
Read `modes/{mode}.md`

Applies to: `tracker`, `deep`, `training`, `project`, `patterns`, `followup`, `positioning`

### Modes delegated to subagent:
For `scan`, `apply` (with Playwright), and `pipeline` (3+ URLs): launch as Agent with the content of `_shared.md` + `modes/{mode}.md` injected into the subagent prompt.

```
Agent(
  subagent_type="general-purpose",
  prompt="[content of modes/_shared.md]\n\n[content of modes/{mode}.md]\n\n[invocation-specific data]",
  description="career-ops {mode}"
)
```

Execute the instructions from the loaded mode file.
