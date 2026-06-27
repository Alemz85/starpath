# Mode: contacto — Outreach (referrals & the LinkedIn power move)

## Purpose

A warm referral or a message to the right person raises response rates far more
than another cold application. This mode does three things:

1. **Find** the right person to reach at a target company.
2. **Draft** a message genuinely worth reading — personalized, specific, grounded
   in *this* candidate's profile and *this* role.
3. **Track** what was sent and tell the user when a nudge is due, so good
   threads don't go cold from neglect.

It works for both an active application (you applied, now build a human bridge)
and speculative outreach (no posting yet, but you want in).

## Inputs (read at runtime — never hardcode candidate specifics)

- `user/cv.md` — proof points, current location, headline experience. **The
  message's "proof" sentence comes from here.** Read it every time; do not carry
  remembered numbers between runs.
- `user/profile.yml` — candidate name, target roles, availability, visa/location,
  preferred cities. Use the real name in signatures and the real location in any
  "currently in {city}" line.
- `user/_profile.md` — archetypes, narrative, positioning. Pull the *angle* (how
  this candidate frames themselves) from here, not from assumptions.
- `user/article-digest.md` — published work / portfolio proof points (optional).
- `data/applications.md`, `data/scouting.md` — to resolve `company + role` if the
  user names a company you've already evaluated (links outreach to the pipeline).
- `reports/tier-*/{Company} - {Role}.md` — if a report exists, mine its company
  context (the specific challenge / hook) instead of re-researching from scratch.
- `data/companies/{slug}.md` — **cached deep research, the primary hook source when
  fresh.** Don't read this path by hand or guess the slug — query it through
  `scripts/company-research.mjs` (Step 1a). When a fresh artifact exists, its
  **Talking Points** become the message hook and its **Team & Role Context** tells
  you which team/person to target and what problem they own. See `modes/deep.md`.
- `data/outreach.md` — the outreach log (created on first send). Drives cadence.

> **System-layer hygiene:** this file must stay generic. Every example below uses
> a placeholder ("your main production project", "your top-school MSc"). At
> runtime you substitute the candidate's *actual* specifics from the files above.
> Never write a real school, employer, metric, city, or company into this mode.

## Step 1 — Resolve the target company + role

If the user said `/career-ops contacto {company}`, that's the company. Check
`data/applications.md` / `data/scouting.md` for a matching `company + role`:
- **Match found** → use that role and, if a report exists, its company context.
- **No match** → ask the user for the role (or treat it as speculative outreach
  for one of their target roles from `user/profile.yml`).

## Step 1a — Cache check (reuse deep research before re-searching)

Before you spend WebSearch budget finding a person and a hook, check whether
`modes/deep.md` already cached the research for this company:

```bash
node scripts/company-research.mjs check "{Company}" --json
```

Read the `state` field (and exit code):

| Verdict (exit code) | Action |
|---------------------|--------|
| `fresh` + valid (0) | **Consume it.** Read `data/companies/{slug}.md`. Two sections drive this mode: **Talking Points** (3–6 concrete, defensible hooks — the raw material for the message's opening line and any "ask them" question) and **Team & Role Context** (who owns the req, who it reports to, adjacent teams — this tells Step 2 *who* to target and Step 4 *what problem* to reference). Treat any named person as a lead to verify (Step 2), not a confirmed contact. |
| `stale` (2) | Use **Team & Role Context** as a scaffold (org shape is slow-moving) but treat **Talking Points** tied to *Recent Signals* as possibly outdated — re-verify before leaning on a "recent" hook, since a stale signal in a cold message reads worse than a generic one. Suggest the user re-run `deep` mode. |
| missing file (1) | No cached research — gather the hook in Step 2 from the report / JD / a fresh search. Worth telling the user that running `deep` first builds a reusable artifact shared with `interview-prep`. |
| invalid schema (3) | Malformed file — ignore it; research the hook fresh. |

The CLI owns the slug → path → freshness math (30-day window) so contacto, `deep`,
and `interview-prep` agree on what "fresh" means. **Candidate specifics — the proof
sentence, the name, the location — still come from `user/*` at runtime** (Step 4);
the artifact supplies the *company-side* hook and targeting, never the candidate's
numbers.

## Step 2 — Find the right person (WebSearch / LinkedIn)

Identify candidates for outreach, in rough priority order:

1. **Hiring Manager** — leads the team that's hiring. Highest leverage: they own
   the req and feel the pain the role is meant to solve.
2. **Peer** — someone already doing a similar role on the team. Best *referral*
   path; a peer who likes you can drop your name internally.
3. **Recruiter / Talent** — owns the funnel; good for logistics and a fast read
   on fit, weaker as a referral.
4. **Interviewer** — only if the candidate already has an interview scheduled.

**If Step 1a found a fresh artifact, start from its *Team & Role Context*.** It
names the team that owns the req, who the role likely reports to, and adjacent
teams — which is exactly the targeting input this step needs. The hiring manager
it points to (or the team it names) becomes your primary search target; verify the
person below rather than re-deriving the org from scratch.

Search patterns (adapt to the company): `site:linkedin.com/in "{company}"
"{team or function}"`, the company's team/about page, engineering or product blog
authorship, conference talk speaker lists, GitHub org members.

Pick **one primary target** — the person who would most benefit from this
candidate being on their team — and note **2–3 alternates** with a one-line reason
each (so the user has a fallback without re-running).

> **Verification:** before asserting a specific person works there *now*, sanity-
> check the profile is current (recent activity, title still matches). If you
> can't confirm, say so and offer the role/team as the target instead of a name.

## Step 3 — Classify the contact type

The contact type changes the **emphasis**, not the structure. Infer it from who
you found, or ask if ambiguous: **Hiring Manager · Peer · Recruiter · Interviewer.**

## Step 4 — Draft the message

Pull the **proof** from `user/cv.md` and the **angle** from `user/_profile.md`.
Pull the **hook** from the role/company. **When Step 1a found a fresh artifact, its
*Talking Points* are the first place to look for that hook** — each one is already
"concrete enough to drop into a message or an 'ask them' question" (that's the
section's contract in `modes/deep.md`). Pick the talking point most relevant to the
contact type and the role, and phrase it in your own words — don't paste it
verbatim. Fall back to the report's company context, the JD, a blog post, or recent
news when there's no fresh artifact (or to add a sharper, more current hook on top).
For a *stale* artifact, prefer a durable talking point (a public value, a product
detail) over one pinned to a possibly-outdated recent signal. Frameworks below — 3
sentences each, substitute real specifics at runtime:

### Hiring Manager
- **Hook** — a specific challenge their team faces (from the JD / company blog /
  news). Show you understand *their* problem, not that you want *a* job.
- **Proof** — the candidate's most relevant quantified result that shows they've
  solved something similar (read the exact metric from `user/cv.md`).
- **CTA** — *"Would love to hear how your team is approaching {specific challenge}."*

### Peer (the referral path)
- **Interest** — a genuine reference to their work: a blog post, talk, OSS project,
  or publication. Real, specific, recent.
- **Connection** — something the candidate is doing in the same space (from
  `user/cv.md` / `user/article-digest.md`). **Not** a job pitch.
- **CTA** — *"I've been working on similar problems — would love your take on {topic}."*
- **Rule:** do NOT ask for a job. The referral happens naturally if the
  conversation flows. A peer who enjoys talking to you refers you on their own.

### Recruiter
- **Fit** — direct match criteria: role, relevant experience, availability/location
  (read availability + location from `user/profile.yml`).
- **Proof** — answer a screening question before they ask it (e.g. years in the
  relevant stack, current city, notice period — all from the candidate's files).
- **CTA** — *"Happy to share my CV if this lines up with what you're looking for."*

### Interviewer (pre-interview)
- **Research** — reference something specific from their work or background.
- **Context** — a light connection to the candidate's experience on that topic.
- **CTA** — *"Looking forward to our conversation on {date}."*
- **Rule:** light tone, not eager. The goal is to signal you prepared.

### Versions
- **EN** by default.
- **ES** if the company is Spanish-speaking, or whichever language the candidate's
  `profile.yml` / the posting indicates.

### Message rules (hard constraints)
- **≤ 300 characters** for a LinkedIn *connection request* (the platform limit). A
  direct message / InMail / email can be longer but stay tight (≤ 5 sentences).
- NO corporate-speak. NO *"I'm passionate about…"*. NO *"just reaching out"*,
  *"touching base"*, *"picking your brain"*.
- Lead with *them* or with value, never with the ask.
- **Never** share a phone number in a first message.
- Specific enough that they *want* to reply. If you can't name something concrete
  about them or their team, find it before sending.

## Step 5 — Present the draft(s)

For the primary target, show:

```
## Outreach: {Company} — {Role}

**Target:** {Name} · {Title}  ({contact type})
**Channel:** Connection request · Message · InMail · Email
**Why them:** {one line}

{message text}

**Alternates:** {Name} ({reason}) · {Name} ({reason})
```

If a connection request and a follow-up message are both warranted (connect now,
message after they accept), draft both and label which is which.

## Step 6 — Log the touch (persistence)

**Only after the user confirms they actually sent it** — never log a draft as sent.

1. If `data/outreach.md` doesn't exist, create it:
   ```markdown
   # Outreach Log

   | # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
   |---|------|---------|------|---------|-------|---------|-------|---------|-------|
   ```
2. Append one row:
   - `#` — next sequential id
   - `Date` — today (`YYYY-MM-DD`)
   - `Company` / `Role` — the resolved target (Role may be blank for speculative)
   - `Contact` — the person's name
   - `Title` — Hiring Manager / Peer / Recruiter / Interviewer
   - `Channel` — `Connection` (request) · `Message` · `InMail` · `Email`
   - `Touch` — `1` for the first touch; `2`, `3`… for subsequent nudges to the
     **same person** (the cadence script folds these together)
   - `Outcome` — `Pending` initially. Update later to `Accepted`, `Replied`,
     `Declined`, or e.g. `No response after 10d`.
   - `Notes` — the angle used / what to say next
3. If this outreach maps to an entry in `data/applications.md`, you may note it in
   that entry's Notes (e.g. "Reached out to {Name} on {date}") — but **do not**
   change the application's canonical `Status` here. Proactive outreach is tracked
   in this log, not by mutating the pipeline status.

## Step 7 — Cadence check (who needs a nudge?)

When the user asks "who should I follow up with?" or after logging touches, run:

```bash
node scripts/outreach-cadence.mjs --summary
```

It reads `data/outreach.md`, folds touches per contact, and classifies each as:

| Action | Meaning |
|--------|---------|
| **NUDGE** | A follow-up is due now — draft one (Step 8) |
| **waiting** | On track; `Next nudge` date shown |
| **COLD** | Hit the touch ceiling or declined — stop; suggest a different contact |
| **replied** | They answered — hand off; the user takes the conversation from here |

JSON for programmatic use: `node scripts/outreach-cadence.mjs` (or `--due` for
just the nudges). The cadence windows live in `scripts/outreach-core.mjs`
(`CADENCE`): a LinkedIn connection request gets a longer leash (it's silent until
accepted); a sent message/InMail/email gets a tighter, value-add nudge.

**Leverage shapes the cadence — who you're chasing, and how hard.** The `Title`
column you log (Step 3: Hiring Manager · Peer · Recruiter · Interviewer) sets a
referral-leverage tier, mirroring Step 2's priority order (Hiring Manager > Peer
> Recruiter). Two things follow from it, so the cadence agrees with how
`network` ranks who's worth pursuing:
- **The hiring manager earns one extra patient touch** before the thread goes
  COLD — the person who owns the req can actually move you forward, so they're
  worth a little more persistence than a recruiter who owns only logistics
  (everyone else keeps the channel's base ceiling).
- **The dashboard ranks due nudges by leverage**, not just by how overdue they
  are, and names the single **most valuable nudge** at the top — so when several
  are due you draft the hiring-manager one first. The `Lever` column shows each
  contact's tier (`hiring-mgr` / `peer/ref` / `recruiter`); a neutral/unreadable
  title leaves it blank.

To get the lift, **log the contact type accurately in the `Title` column** — a
clear "Hiring Manager" reads as the highest tier; a bare job title still
classifies (a leadership title → manager, an IC role word → peer, a talent/HR
title → recruiter), but the explicit label is the most reliable signal.

## Step 8 — Draft a nudge (for NUDGE-state contacts)

Take a **new angle** — never resend the first message:
- **Connection still pending** → a short note that adds value (share a relevant
  insight or a quick observation about their work), or suggest the user withdraw
  and try an alternate from Step 2.
- **Accepted but silent** → a tight value-add message (a useful link, a sharp
  question about their problem space) — not "did you see my request?".
- Keep it shorter than the first touch. Reference the role/company specifically.

Then loop back to Step 6 to log the nudge as `Touch = N+1`.

## Quick reference

| Situation | Do |
|-----------|----|
| `/career-ops contacto {company}` | Steps 1–6 for that company (Step 1a checks for cached deep research first) |
| Cached research exists | `node scripts/company-research.mjs check "{Company}"` → if fresh, mine **Talking Points** + **Team & Role Context** before searching |
| "who should I follow up with?" | `node scripts/outreach-cadence.mjs --summary` → Step 8 for NUDGE rows |
| Contact replied | Mark `Outcome` → `Replied`; stop the cadence; move to a real conversation |
| 2 touches, no reply | It goes COLD — switch to an alternate contact, don't pester |
