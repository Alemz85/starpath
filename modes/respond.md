# Mode: respond — Recruiter / Screening Reply Drafting

> **Autonomous-mode contract.** When this mode is spawned non-interactively — `claude -p`, the starpath frontend's `shell:spawn`, a batch worker, or any context with no human in the loop — follow these rules. (For interactive `claude` runs from a terminal, ask normally.)
>
> - **Don't ask the user any questions.** Draft the full reply from whatever's in `user/*` + the story bank + the report; the user reviews after.
> - **Don't propose follow-up actions** at the end. Print the draft + a one-line completion summary and stop.
> - **Don't run side-checks** (update polls, "first message of session" hooks) — they prompt for a reply nobody can give.
> - If you genuinely cannot proceed — corrupted file, missing config — write the blocker to stderr and exit non-zero so the spawn surfaces as a failed task.

## When to use

A recruiter or hiring contact has **replied** — a screening email, a list of questions, an awkward ask (comp expectations, availability, "why us?"), a take-home assignment, a scheduling request, or a soft rejection. This mode drafts a strong, specific reply grounded in *this* candidate's files, and **always stops before send** for user review.

This is the post-application sibling of `contacto` (which starts cold outreach). `contacto` opens a thread; `respond` answers one the company opened.

## The hard rule (Ethical Use)

**NEVER send.** Draft the reply, show it, stop. The user copies/sends it themselves and makes the final call — exactly as with every other drafting surface in this system. Do not auto-write the application status either; suggest it and let the user (or the frontend status dropdown) apply it.

## Inputs (read at runtime — never hardcode candidate specifics)

- **The recruiter's message** (required) — pasted by the user, or a `--file`.
- **The company + role** — to resolve context. Match against `data/applications.md` / `data/scouting.md` by `company + role`.
- `user/cv.md` — proof points, headline experience. **Every quantified claim in the reply comes from here.** Read it every run; never carry remembered numbers between runs.
- `user/profile.yml` — candidate name (signature), **comp target + floor**, availability / notice period, visa/location, preferred cities, scheduling link if any. The comp and availability answers are framed from this file.
- `user/_profile.md` — archetypes, narrative, positioning, negotiation scripts. Pull the *angle* and any user-written comp/negotiation language from here.
- `interview-prep/story-bank.md` — STAR+R stories. A "why us / tell me about a time…" screening question is answered with a real story, not a generic value statement. The bank's format + selection logic live in `scripts/lib/story-bank.mjs` (the same module `interview-prep.md` and `apply.md` use).
- `user/article-digest.md` — published-work proof points (optional).
- `reports/tier-*/{Company} - {Role}.md` — if a report exists, mine its company context (the specific hook / challenge) so the "why this company" answer is specific.

> **System-layer hygiene:** this file stays generic. Every example below uses a placeholder ("your headline result", "your target comp", "your notice period"). At runtime, substitute the candidate's *actual* specifics from the files above. Never write a real number, school, employer, city, or company into this mode.

## Step 1 — Classify the asks (deterministic skeleton)

Run the classifier to get a stable plan of what the message is actually asking:

```bash
node scripts/respond-plan.mjs --message "<paste>"        # or --file path, or pipe via stdin
node scripts/respond-plan.mjs --message "<paste>" --json # machine-readable
```

It detects, in canonical order, any of: **comp · availability · scheduling · take-home · screening · logistics · rejection**, prints the handling strategy for each, and suggests a pipeline status. Logic is the pure, unit-tested module `scripts/respond-core.mjs`. A rejection short-circuits to a single graceful-decline step; a message with no recognized ask falls back to "answer it directly."

Two signals the classifier surfaces that change *how* you reply, not just *what* it's about:

- **Urgency.** If the message carries a reply deadline or time pressure (*"by Friday"*, *"ASAP"*, *"we're moving quickly"*, *"the role closes soon"*), the plan flags it (`urgency.urgent` / a `⏰ TIME-SENSITIVE` banner). Treat a flagged reply as the **highest-priority item in the pipeline** — draft it first and tell the user to send today. Speed is part of response rate.
- **Comp disclosure vs. comp question.** A comp ask has two opposite shapes (see § Comp below). The classifier distinguishes them: if the recruiter **stated a number**, the comp step is relabelled *"recruiter disclosed a number (evaluate, don't over-ask)"* and carries the parsed figures.

You still **read the full message yourself** — the classifier is a router that guarantees you don't miss the awkward asks, not a substitute for understanding the email.

## Step 2 — Answer each ask, grounded in the candidate's files

Address the asks **in the order the classifier returned** (comp first, then availability, etc.) so the reply is predictable. For each:

### Comp (the one candidates fumble) — two opposite shapes
Always pass the candidate's target + floor (read from `user/profile.yml`); the classifier routes to the right posture automatically:

```bash
node scripts/respond-plan.mjs --message "<paste>" --target <target> --floor <floor>
```

**(a) They ASKED ("what are your expectations?")** → you state the anchor range (`compRange`):
- **Always a range, never a single number** — a point answer caps you.
- Anchor the bottom **at or above the target**, not at the floor; state it as **total comp**; add one flexibility clause (*"for the right role, depending on the full package"*).
- **Never** state a number below the walk-away floor.
- **No target on file** → don't invent one. Defer politely and turn the question around: *"Happy to discuss — what range is budgeted for the role?"* (the classifier returns `comp.ok:false` in this case).
- If `user/_profile.md` has a user-written negotiation script, prefer its language.

**(b) They DISCLOSED a number ("the band is X–Y", "we're budgeting Z")** → do **not** blurt your own range over a number already on the table. The classifier evaluates the disclosed figure against the candidate's floor/target (`evaluateCompOffer`) and returns a posture verdict; follow it:
- **`at_or_above_target`** → respond warmly, confirm strong fit; keep a light note that the final figure depends on full scope/level (preserves room without haggling over an already-good offer).
- **`below_target`** (clears the floor, under target) → stay engaged; anchor up toward target on the basis of scope/fit; note that **total comp**, not just base, is what matters. Don't accept the figure as final.
- **`spans_floor`** (band straddles the floor) → interested, but anchor explicitly to the **upper end** and frame the floor as the realistic starting point.
- **`below_floor`** (top of band under the floor) → don't reject outright; warmly note it's below what they can consider, state the floor as total comp, ask if there's flexibility. If none, it's a graceful decline.
- **No target/floor on file** → just acknowledge the number and tell the user to set their band so the next disclosure can be judged (the classifier returns `offer.ok:false`).

### Availability / notice period / start date
State the real notice period / earliest start from `user/profile.yml`. If a known constraint exists (a program start window, an exchange/relocation period), name it plainly as a **fixed date**, framed as a plan — not an apology.

### Scheduling
Say yes warmly, then propose **2–3 concrete windows** (or the candidate's scheduling link if `profile.yml` has one). Confirm the timezone. **Do not commit to an exact slot the user hasn't approved** — offer options.

### Take-home / assessment
Accept positively; confirm **scope + deadline + expected effort** in writing; ask the one clarifying question that de-risks the work. If the effort looks disproportionate (unpaid multi-day), **flag it to the user** in your summary so they decide whether to push back — don't silently agree.

### Screening question ("why us", "tell me about a time…", "years in X")
Answer with **one specific, quantified proof point** from the story bank / `user/cv.md` — never a generic "I'm passionate about…". For a behavioral prompt, select the best-fit story (`scripts/lib/story-bank.mjs` ranks by competency). Tie it to *this* company using the report's hook if a report exists. Lead with the number.

### Logistics (CV, references, links, work authorization, location)
Answer factually from `user/profile.yml` + `user/cv.md`. Offer the latest CV. Keep it to the fact asked — don't volunteer more than the recruiter needs.

### Rejection
Thank them genuinely, **keep the door open** for future roles, ask for one piece of feedback if appropriate, stay warm. Never argue the decision. This contact often surfaces a better-fit role later — protect the relationship.

## Step 3 — Assemble the reply

One clean message (email or LinkedIn DM — match the channel the recruiter used):

- **Open** with a warm, specific one-liner (reference the role/company, not "thanks for reaching out").
- **Body**: answer each ask in order, tightly. One short paragraph or a clean bullet per ask.
- **Close** with a forward-looking line and the candidate's real name (from `profile.yml`).
- **Tone**: confident, specific, human. No corporate-speak, no *"I'm passionate about"*, no *"just touching base"*, no hedging on comp.
- **Language**: match the recruiter's language (EN default; ES / other if the message or `profile.yml` indicates).

## Step 4 — Present the draft + stop

Show the draft in a copy-pasteable block, then a short rationale:

```
## Reply: {Company} — {Role}

**Channel:** Email · LinkedIn
**Asks handled:** {comp, availability, scheduling, …}
{if urgency flagged} **⏰ Time-sensitive:** they signalled "{cue}" — send today.

{the drafted reply, ready to copy}

---
**Why this framing:**
- Comp (asked): anchored at {range} (your target {X}, floor {Y}) — stated as a range, not a point.
  — OR — Comp (disclosed): their {number} is {verdict} → {posture, e.g. "below floor — surfaced the floor, asked for flex"}.
- Availability: {the real date/notice}.
- {any flag, e.g. "the take-home is ~6h unpaid — push back?"}

**Suggested status:** {Responded | Interview | Rejected} — apply it via the status dropdown if you agree.
```

Then **STOP.** Do not send. Do not write the status.

## Step 5 — After the user confirms they sent it (logging)

Only **after** the user says they actually sent the reply:

1. **Pipeline status** — update the matching `data/applications.md` row's `Status` to the suggested canonical value (`Responded`; `Interview` once a screen/take-home is scheduled; `Rejected` for a rejection). Canonical states only (`templates/states.yml`): no `**bold**`, no dates, no extra text in the status cell. **Update the existing row in place — never add a new entry** (per CLAUDE.md). The frontend status dropdown does the same writeback.
2. **Outreach log (optional, read the convention from `modes/contacto.md` — do not duplicate its logic here).** If the candidate keeps a `data/outreach.md` log and this reply maps to a tracked contact, you *may* append a touch row (`Channel = Email`/`Message`, `Touch = N+1`, `Outcome = Replied`/`Pending`) using that file's existing schema. The outreach log is the relationship record; the application `Status` is the pipeline record — keep them distinct. If no log exists, don't create one just for a recruiter reply; the application status is enough.

## Rules

- **NEVER send.** Always stop at Step 4 for review.
- **NEVER fabricate a metric, a date, or a comp number.** Read them from `user/*` at runtime.
- **NEVER state a comp number below the floor**, and never answer comp with a single point.
- **NEVER add a new `applications.md` row** — update the existing one in place.
- Match the recruiter's channel and language. Be specific, warm, and brief.
