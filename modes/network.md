# Mode: network — Referral / networking tracker (who you know → your way in)

## Purpose

A warm referral is the highest-ROI move in a job search — it lifts response
rates far above a cold application. The `contacto` mode finds a person and drafts
a message for *one* company on demand; this mode is the layer underneath it: a
durable **map of the candidate's network against their pipeline**, so that for
any application the system can answer instantly:

1. **Who do I already know (or am one intro from) at this company?**
2. **Which of my pipeline targets has nobody inside** (a coverage gap worth
   closing with `contacto`)?
3. **Who do I know at companies I haven't targeted yet** (latent leads)?

It does three things:

1. **Populate** a roster of the candidate's connections (`data/network.md`).
2. **Match** that roster against the pipeline (`data/applications.md` +
   `data/scouting.md`) and rank the best referral path per company.
3. **Hand off** to `contacto` to actually reach the chosen person — and to
   `outreach`/the cadence layer once a message is sent.

## How this differs from `contacto` / outreach (no overlap)

| Layer | Artifact | Question it answers |
|-------|----------|---------------------|
| **network** (this) | `data/network.md` | Static: *who do I know, and how warm/close are they?* The asset that exists before any message. |
| **contacto** | drafts a message | *For this one company, who do I reach and what do I say?* |
| **outreach cadence** | `data/outreach.md` | *Which sent messages need a nudge, and when?* |

The chain is: **network (pick the warmest path) → contacto (draft the reach) →
outreach (log the touch + cadence).** This mode never drafts or sends — it maps
and recommends. It never mutates `outreach.md` or application statuses.

> **System-layer hygiene:** this file stays generic. It ships zero real names,
> companies, schools, or scores. Every example below is illustrative
> (Acme / "a former manager"); at runtime the candidate's actual connections
> live only in `data/network.md`, which is user-layer and never auto-updated.

## The artifact: `data/network.md`

A single markdown table. One row per person. Create it on first use if missing:

```markdown
# Network

| # | Name | Company | Title | Relationship | Degree | Via | Last Contact | Notes |
|---|------|---------|-------|--------------|--------|-----|--------------|-------|
```

Column contract (parsed by `scripts/lib/network-core.mjs`):

| Column | Meaning |
|--------|---------|
| `#` | Sequential row id |
| `Name` | The person's name |
| `Company` | Where they currently work — **matched against the pipeline by the same normalized key the dedup index uses** (lowercase, strip punctuation), so "Go-Cardless Ltd." matches a "GoCardless" pipeline row |
| `Title` | Their role (free text; gauges referral leverage — a hiring manager on the target team beats someone in an unrelated org) |
| `Relationship` | How well the candidate knows them: `strong` · `medium` · `weak` (synonyms like "close", "acquaintance" are normalized) |
| `Degree` | `1` = the candidate knows them directly · `2` = a mutual could introduce them |
| `Via` | For a 2nd-degree contact, the 1st-degree person who bridges (blank for 1st-degree) |
| `Last Contact` | `YYYY-MM-DD` they last spoke (optional — informs whether the tie is still warm); blank / `n/d` if unknown |
| `Notes` | How they know each other, what the person owns, what to ask, etc. |

## Step 1 — Populate (interview the candidate, don't invent)

If `data/network.md` is missing or thin, help the candidate build it. **Never
fabricate contacts** — every row is a real person the candidate names. Good
prompts to elicit the roster:

- Former managers, teammates, and reports (the strongest, most referable ties).
- University / program alumni now in industry (often a warm 2nd-degree path).
- People met at conferences, meetups, or online communities.
- Anyone the candidate already knows at a company in their pipeline.

For each person, capture at least Name + Company; fill Relationship and Degree
from how the candidate describes the tie (default `medium` / `1st` if unsure).
Append rows by writing the table directly — this is a user-layer file, so it's
fine to edit it here (unlike `applications.md`, which goes through the merge
script). Keep `#` sequential.

> If the candidate pastes a LinkedIn connections export or a list, parse it into
> rows. Don't guess relationship strength you weren't told — leave it `medium`.

## Step 2 — Match against the pipeline

Run the matcher (pure logic in `scripts/lib/network-core.mjs`):

```bash
node scripts/network.mjs --summary      # human-readable dashboard
node scripts/network.mjs                # JSON for programmatic use
```

It reads `data/network.md` + `data/applications.md` + `data/scouting.md` and
returns three buckets:

| Bucket | Meaning | What to do |
|--------|---------|-----------|
| **matches** | Pipeline companies where the candidate has ≥1 contact, with the referral paths ranked warmest-first | Pick the top path → Step 3 |
| **gaps** | Pipeline targets (ranked by role score) with **nobody inside** | The highest-value ones are where a `contacto` search pays off most |
| **orphanContacts** | People the candidate knows at companies **not** in the pipeline | Latent leads — worth a look if any maps to a role they'd want |

**Warmth ranking** (why a path sits where it does): `warmth = strength ×
degree × recency × leverage`. A strong, direct, recently-touched tie tops the
list; a weak 2nd-degree dormant one sits at the bottom but still beats a cold
application. The **leverage** factor reads the contact's `Title` against the
role(s) that company is hiring for and lifts the people who can actually help —
the **likely hiring manager** (owns the req), then a **peer** on the target team
(the best referral path), while a **recruiter** is nudged down (owns the funnel,
weaker as a referral) and an unrelated-function tie stays neutral. This mirrors
the priority order in `contacto.md` § Step 2, so the script no longer disagrees
with the mode: at equal relationship strength, the hiring manager now outranks a
random same-warmth tie. A *strong* direct tie still beats a *medium*-tie manager
— you can't be referred by someone who barely knows you. The constants live in
`network-core.mjs` (`STRENGTH_WEIGHT`, `DEGREE_FACTOR`, `LEVERAGE_FACTOR`) and are
unit-tested — adjust them there if the candidate wants different weighting, not
inline. The `pathLabel` for a matched contact now spells out the leverage read
(e.g. *"…, likely hiring manager"*), and a per-company summary line is tagged
`[hiring-manager path]` / `[peer referral path]` when the warmest contact is one.

## Step 3 — Recommend the warmest path for a given application

When the candidate asks "who do I know at {company}?" or is about to apply:

```bash
node scripts/network.mjs --company "{Company}"
```

- **Path found** → present the top contact with its warmth and the plain-words
  `pathLabel` (e.g. *"a former manager — strong tie, 1st-degree (direct)"*), plus
  1–2 alternates. For a **2nd-degree** path, name the bridge from `Via` and frame
  the ask as an intro request to the 1st-degree person, not a cold reach to the
  target. Then offer to hand off to `contacto` to draft the actual message.
- **No contact, but in pipeline** → it's a coverage gap. Suggest running
  `/career-ops contacto {company}` to find someone, and offer to add them to
  `network.md` once identified.

## Step 4 — Surface coverage gaps proactively

```bash
node scripts/network.mjs --gaps
```

Lists pipeline companies with no contact, highest role-score first — the targets
where building a referral path has the most upside. This pairs naturally with
`contacto`: pick the top gap, find a person, draft a reach, then record them in
`network.md` so the gap closes.

## Step 5 — Keep the roster current

The roster is only as good as it's current. When the candidate:

- **Identifies a new contact** (via `contacto` or otherwise) → append a row.
- **Has a meaningful exchange** → update `Last Contact` (keeps warmth honest) and
  `Notes`.
- **Learns a tie went cold or the person changed jobs** → update `Company` /
  `Relationship` so matches stay accurate.

This file is never auto-updated by system releases (it's user-layer, see
`DATA_CONTRACT.md`), so edits here are safe and persistent.

## Quick reference

| Situation | Do |
|-----------|----|
| "Who do I know at {company}?" | `node scripts/network.mjs --company "{company}"` → present warmest path → offer `contacto` handoff |
| "Where are my referral gaps?" | `node scripts/network.mjs --gaps` → top gaps → `contacto` to fill |
| "Map my network to my pipeline" | `node scripts/network.mjs --summary` → matches + gaps + latent leads |
| New contact found | Append a row to `data/network.md` (Name + Company minimum) |
| Just spoke to a contact | Update their `Last Contact` + `Notes` |
| Picked a path, want to reach out | Hand off to `contacto` (draft) → it logs the touch in `outreach.md` (cadence) |
| About to reach out at one company | `node scripts/outreach-plan.mjs "{company}" --summary` — the contacto pre-flight that merges this roster with the outreach log + research and recommends the play |
