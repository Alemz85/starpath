---
name: career-ops
description: AI job search command center -- evaluate offers, generate CVs, scan portals, track applications
user_invocable: true
args: mode
argument-hint: "[scouting | positioning | ofertas | contacto | respond | interview-prep | apply | apply-kit | pdf | deep | training | project | mock-interview | network | tracker | pipeline | scan | batch | db | deadlines | patterns | followup | calibrate | comp-bench | cv-gap]"
---

# career-ops -- Router

## Mode Routing

Determine the mode from `{{mode}}`:

| Input | Mode |
|-------|------|
| (empty / no args) | `discovery` -- Show command menu |
| JD text or URL (no sub-command) | `scouting` (the one evaluation mode -- see below) |
| `scouting` | `scouting` |
| `positioning` | `positioning` |
| `ofertas` | `ofertas` |
| `contacto` | `contacto` |
| `respond` | `respond` |
| `interview-prep` | `interview-prep` |
| `apply` | `apply` |
| `apply-kit` | `apply-kit` |
| `pdf` | `pdf` |
| `deep` | `deep` |
| `training` | `training` |
| `project` | `project` |
| `mock-interview` | `mock-interview` |
| `network` | `network` |
| `tracker` | `tracker` |
| `pipeline` | `pipeline` |
| `scan` | `scan` |
| `batch` | `batch` |
| `db` | `db` |
| `deadlines` | `deadlines` |
| `patterns` | `patterns` |
| `followup` | `followup` |
| `calibrate` | `calibrate` |
| `comp-bench` | `comp-bench` |
| `cv-gap` | `cv-gap` |

Every route above is `modes/{mode}.md`. `modes/_shared.md` is the shared rubric loaded alongside some of them, and `modes/chat.md` is the starpath app's chat prompt (appended by the app, never a command).

**JD detection:** If `{{mode}}` is not a known sub-command AND contains JD text (keywords: "responsibilities", "requirements", "qualifications", "about the role", "we're looking for", company name + role) or a URL to a JD, run `scouting` on it. Scouting is the only evaluation mode; tailoring a CV, preparing or drafting an application are separate commands the user triggers per listing (`pdf`, `interview-prep`, `apply`).

If `{{mode}}` is not a sub-command AND doesn't look like a JD, show discovery.

---

## Discovery Mode (no arguments)

Show this menu (tell the user which mode is active — read `user/profile.yml` → `current_mode` and note "Active mode: scouting" or "Active mode: applying" at the top):

```
career-ops -- Command Center

Active mode: {scouting | applying}   (set in user/profile.yml -> current_mode)

Landscape mapping:
  /career-ops scouting      -> Evaluate a listing: Want x Ease, eligibility, verdict, tiered report
  /career-ops positioning   -> Holistic Career Positioning Report across ALL accumulated data
  /career-ops db            -> Browse and filter every evaluated offer

Active application:
  /career-ops {JD}          -> Evaluate it (scouting)
  /career-ops apply         -> Live application assistant (reads form + generates answers)
  /career-ops apply-kit     -> Is this application ready to send? Exact next action
  /career-ops pdf           -> ATS-optimized CV PDF
  /career-ops interview-prep -> Company-specific interview intelligence + STAR mapping
  /career-ops mock-interview -> Rehearse likely interview questions
  /career-ops respond       -> Draft a reply to a recruiter (stops before send)
  /career-ops ofertas       -> Compare and rank multiple offers
  /career-ops comp-bench    -> Benchmark compensation against the landscape

Network and outreach:
  /career-ops contacto      -> LinkedIn power move: find contacts + draft message
  /career-ops network       -> Referral and warm-intro paths
  /career-ops followup      -> Follow-up cadence tracker: flag overdue, generate drafts

Research and triage:
  /career-ops deep          -> Deep research prompt about a company
  /career-ops training      -> Evaluate course/cert against the North Star
  /career-ops project       -> Evaluate a portfolio project idea

Pipeline and data:
  /career-ops pipeline      -> Process pending URLs from the inbox (data/pipeline.md)
  /career-ops tracker       -> Application status overview
  /career-ops scan          -> Scan portals and discover new offers
  /career-ops batch         -> Batch processing with parallel workers
  /career-ops deadlines     -> Closing-date urgency
  /career-ops patterns      -> Analyze rejection patterns and improve targeting
  /career-ops calibrate     -> Scoring-calibration feedback (read-only)
  /career-ops cv-gap        -> What the CV is missing vs evaluated roles

Inbox: add URLs to data/pipeline.md → /career-ops pipeline
Or paste a JD directly to evaluate it.
```

---

## Context Loading by Mode

After determining the mode, load the necessary files before executing.

**Private overrides (always check first).** The user's own versions of system files live in `private/overrides/` with the same path. For every `modes/X.md` you are about to read (including `_shared.md`):
1. If `private/overrides/modes/X.md` exists, read it **instead of** `modes/X.md`.
2. If `private/overrides/modes/X.append.md` exists, read it **after** the file from step 1; its rules win where they conflict.

The same applies to `batch/batch-prompt.md` and `templates/*`. `npm run overrides` lists what is active. Subagent prompts below get the resolved text, not the repo default.

### Modes that require `_shared.md` + their mode file:
Read `modes/_shared.md` + `modes/{mode}.md`

Applies to: `scouting`, `ofertas`, `pdf`, `contacto`, `apply`, `pipeline`, `scan`, `batch`

### Standalone modes (only their mode file):
Read `modes/{mode}.md`

Applies to: `tracker`, `deep`, `training`, `project`, `patterns`, `followup`, `positioning`, `respond`, `interview-prep`, `apply-kit`, `mock-interview`, `network`, `db`, `deadlines`, `calibrate`, `comp-bench`, `cv-gap` (the ones that need `_shared.md` say so in their own file)

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
