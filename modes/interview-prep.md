# Mode: interview-prep — Company-Specific Interview Intelligence

> **Autonomous-mode contract.** When this mode is spawned non-interactively — `claude -p`, the starpath frontend's `shell:spawn` (e.g., the Database popover's "Prep Interview" button), a batch worker, or any context where no human is in the loop to reply — follow these rules. (For interactive `claude` runs from a terminal, ask normally.)
>
> - **Don't ask the user any questions.** Not "want me to continue?", not "should I also do X?", not "want me to run the update next?". Generate the prep doc in full using whatever's in the report + story bank + CV; the user reviews after.
> - **Don't propose follow-up actions** at the end. Print a one-line completion summary (rows added, files written, exit code) and stop.
> - **Don't run side-checks** like update polls, "first message of session" hooks, or unrelated diagnostics — they prompt for a reply nobody can give.
> - If you genuinely cannot proceed without input — corrupted file, missing config, ambiguous instruction — write the blocker to stderr and exit non-zero so the spawn surfaces as a failed task. Don't loiter waiting.

When the user asks to prep for an interview at a specific company+role, or when an evaluation scores 4.0+ and the user updates status to `Interview`, run this mode.

## Inputs

1. **Company name** and **role title** (required)
2. **Company research artifact** at `data/companies/{slug}.md` (if fresh) — the deep-research cache written by `modes/deep.md`. Mine **Interview Style** (process scaffold), **Recent Signals** (freshest hooks for "questions to ask them"), and **Team & Role Context** (who you'd report to, what the team owns) before spending WebSearch budget. Access it via `scripts/company-research.mjs` — never re-derive the slug/path/freshness in prose.
3. **Evaluation report** in `reports/` (if exists) — read for archetype, gaps, matched proof points
4. **Story bank** at `interview-prep/story-bank.md` — read for existing prepared stories
5. **CV** at `user/cv.md` + `user/article-digest.md` — read for proof points
6. **Profile** at `user/profile.yml` + `user/_profile.md` — read for candidate context

## Step 0 — Cache check (before any WebSearch)

`modes/deep.md` may have already done the heavy company research and cached it at
`data/companies/{slug}.md`. Check for a fresh artifact **before** burning WebSearch
budget — don't re-derive what's already on disk.

```bash
node scripts/company-research.mjs check "{Company}" --json
```

Read the `state` field (and the process exit code):

| Verdict (exit code) | Action |
|---------------------|--------|
| `fresh` + valid (0) | **Consume it.** Read `data/companies/{slug}.md` and pull three sections forward: **Interview Style** seeds Steps 2–3 (process shape, round formats, difficulty, known quirks — you still go deeper on *specific questions* in Step 4, which deep mode deliberately doesn't fabricate); **Recent Signals** feeds Step 7's "questions to ask them"; **Team & Role Context** sharpens Step 4's role-specific questions and the reporting-line framing. Then run a **targeted, gap-filling** Step 1 only — skip queries the artifact already answered. |
| `stale` (2) | The artifact exists but is ≥ 30 days old. Use it as a **starting scaffold** (org shape rarely changes monthly) but treat **Recent Signals** as suspect — re-verify any signal you lean on, and run the full Step 1. Suggest the user re-run `deep` mode to refresh the cache. |
| missing file (1) | No cached research. Run the full Step 1 below from scratch. Optionally tell the user that running `deep` mode first would build a reusable artifact (so the next prep + any outreach share one research pass). |
| invalid schema (3) | The file is malformed — ignore it and run the full Step 1. |

The CLI does the slug → path → freshness math (30-day window) so this mode stays
in sync with `deep` and `contacto`. Do **not** eyeball dates or hand-roll the path.
**Candidate specifics still come from `user/*` at runtime** — the artifact's
*Candidate Angle* section is a convenience, but re-read `user/cv.md` for the actual
proof points you map in Steps 4–5; never trust a remembered metric.

## Step 1 — Research

**If Step 0 found a fresh artifact, run only the queries it didn't already cover**
(deep mode gives you the process scaffold and signals; you still need candidate-level
question detail). Extract structured data, not summaries. Cite sources for every claim.

| Query | What to extract |
|-------|-----------------|
| `"{company} {role} interview questions site:glassdoor.com"` | Actual questions asked, difficulty rating, experience rating, process timeline, number of rounds, offer/reject ratio |
| `"{company} interview process site:teamblind.com"` | Candid process descriptions, recent data points, comp negotiation details, hiring bar |
| `"{company} {role} interview site:leetcode.com/discuss"` | Specific coding/technical problems, system design topics, round structure |
| `"{company} engineering blog"` | Tech stack, values, what they publish about, technical priorities |
| `"{company} interview process {role}"` (general) | Fills gaps from above — blog posts, YouTube, prep guides, candidate write-ups |

If the company is small or obscure and yields few results, broaden: search for the role archetype at similar-stage companies, and note that intel is sparse.

**Do NOT fabricate questions.** If a source says "they asked about distributed systems," report that. Do not invent a specific distributed systems question. When generating likely questions from JD analysis, label them clearly as `[inferred from JD]` not sourced from candidates.

## Step 2 — Process Overview

If Step 0 surfaced a fresh artifact, **start from its *Interview Style* section** —
it already captures process shape (rounds, end-to-end days), formats (take-home /
live coding / case / panel), the difficulty signal, and known quirks. Fill the
fields below from that scaffold, then use Step 1's targeted queries only to confirm
and add candidate-level detail. Cite the artifact as `[deep: data/companies/{slug}.md]`
so the provenance is clear.

```markdown
## Process Overview
- **Rounds:** {N} rounds, ~{X} days end-to-end
- **Format:** {e.g., recruiter screen → technical phone → take-home → onsite (4 rounds) → hiring manager}
- **Difficulty:** {X}/5 (Glassdoor avg, N reviews)
- **Positive experience rate:** {X}%
- **Known quirks:** {e.g., "pair programming instead of whiteboard", "no LeetCode, all practical", "take-home is 4 hours"}
- **Sources:** {links}
```

If data is insufficient for any field, write "unknown — not enough data" rather than guessing.

## Step 3 — Round-by-Round Breakdown

For each round discovered in research:

```markdown
### Round {N}: {Type}
- **Duration:** {X} min
- **Conducted by:** {peer / manager / skip-level / recruiter — if known}
- **What they evaluate:** {specific skills or traits}
- **Reported questions:**
  - {question} — [source: Glassdoor 2026-Q1]
  - {question} — [source: Blind]
- **How to prepare:** {1-2 concrete actions}
```

If round structure is unknown, state that and provide the best available intel on what types of rounds to expect based on company size, stage, and role level.

## Step 4 — Likely Questions

Categorize all discovered and inferred questions:

### Technical
Questions about system design, coding, architecture, domain knowledge.
For each: the question, source, and what a strong answer looks like for this candidate specifically (reference CV proof points).

### Behavioral
Questions about leadership, conflict, collaboration, failure.
For each: the question, source, and which story from `story-bank.md` maps best.

### Role-Specific
Questions tied to the specific job description (archetype-aware).
For each: the question, why they're likely asking it (what JD requirement it maps to), and the candidate's best angle.
If the artifact's **Team & Role Context** section is available, use it to sharpen these: it tells you what the hiring team owns, where the role sits in the org, who it likely reports to, and the problem the req exists to solve. Questions framed against the *actual* team's mandate ("how would you approach {the problem this team owns}") land harder than generic JD-derived ones — and knowing the reporting line lets you anticipate manager-level vs peer-level questioning.

### Background Red Flags
Questions the interviewer will probably ask about gaps, transitions, or unusual elements in the candidate's background. Read `_profile.md` and `user/cv.md` to identify what might raise questions.
For each: the likely question, why it comes up, and a recommended framing (honest, specific, forward-looking — never defensive).

## Step 5 — Story Bank Mapping

**Read `interview-prep/story-bank.md` first.** Surface existing stories before generating anything new. The bank's on-disk format is the contract in `templates/story-bank.template.md` — each story is a `### {Title}` heading with `**Situation/Task/Action/Result/Reflection:**` beats and a `**Themes:**` tag line.

**Run the health check before mapping:** `node scripts/check-story-bank.mjs` (add `--json` for machine output, `--strict` to fail on warnings). It validates every story's STAR+R completeness, flags duplicate titles, resolves the free-text `**Themes:**` tags to the canonical competency taxonomy, and prints a competency-coverage map — i.e. exactly which behavioral competencies have no story yet. Use that coverage map to drive the mapping below. The shared logic lives in `scripts/lib/story-bank.mjs` (the same module `apply.md` and `cv-sync-check.mjs` consume — one source of truth).

### Canonical competency taxonomy

The universal behavioral-interview competencies large employers screen for (the exact set in `scripts/lib/story-bank.mjs`). A story's free-text `**Themes:**` tags resolve to these ids, so classify each likely question against the same vocabulary and the mapping becomes deterministic, not freeform:

`ownership` · `leadership` · `collaboration` · `conflict` · `failure` · `ambiguity` · `analytical` · `impact` · `communication` · `customer` · `learning` · `innovation`

(Natural-language themes normalize automatically — e.g. `delivery-under-pressure` → `ownership`, `led a team` → `leadership`, `data-driven` → `analytical`. You don't have to use the canonical word in the `**Themes:**` line, just tag honestly.)

### The mapping

For **each** likely behavioral/role question from Step 4: classify it to one or more competencies, then look up which bank stories cover that competency (the `check-story-bank.mjs` coverage map / index gives you this directly) and pick the best fit.

| # | Likely question/topic | Competency | Best story from story-bank.md | Fit | Gap? |
|---|----------------------|-----------|-------------------------------|-----|------|
| 1 | ... | conflict | [Story Title] | strong/partial/none | |

- **strong**: a story covers the question's competency directly — note the 1-line opener that frames it to *this* question.
- **partial**: story is adjacent (overlapping theme/body but not the exact competency); suggest a 1-sentence reframe opener that bends it toward the question.
- **none**: no story covers that competency — flag it as a gap.

For each gap, suggest: "You need a story about {competency/topic}. Consider: {specific experience from `user/cv.md` that could become a STAR+R story}." The coverage map's gap list is your checklist — every competency a likely question tests but no story covers is a gap to surface.

**Drafting new stories — follow the template contract.** When the user asks to draft a missing story, build it in the exact `templates/story-bank.template.md` shape:
- All five beats present (Situation, Task, Action, Result, Reflection). The Reflection ("+R") is what most banks skip — don't.
- The **Result leads with a number** sourced from `user/cv.md` / `user/article-digest.md`. Never fabricate a metric.
- Add a `**Themes:**` line with honest tags drawn from (or normalizing to) the taxonomy above — these drive all future matching in this mode and in `apply.md`, and they're what the coverage map keys off.

**Dedup rule:** Check the bank for a story with the same title (normalized: case/punctuation/emphasis-insensitive) before appending. If one exists, update it in place — never create a duplicate title. `check-story-bank.mjs` flags duplicate titles, incomplete stories (missing beats), and unquantified Results, so a sloppy append surfaces in the health check; re-run it after editing the bank to confirm it's clean.

## Step 6 — Technical Prep Checklist

Based on what the company actually tests, not generic advice:

```markdown
- [ ] {topic} — why: "{evidence from research}"
- [ ] {topic} — why: "{their blog/product suggests this matters}"
- [ ] {topic} — why: "{asked in N/M recent Glassdoor reviews}"
```

Prioritize by frequency and relevance to the role. Max 10 items.

## Step 7 — Company Signals

Things to say, do, and avoid based on research:

- **Values they screen for:** name them, cite source (careers page, blog, Glassdoor reviews)
- **Vocabulary to use:** terms the company uses internally — shows homework (e.g., Stripe says "increase the GDP of the internet", Anthropic says "safety" not "alignment")
- **Things to avoid:** specific anti-patterns flagged in interview reviews
- **Questions to ask them:** 2-3 sharp questions that demonstrate you've researched the company, tied to recent news or blog posts. **If the artifact has a *Recent Signals* section, mine it first** — each dated signal (a funding round, launch, leadership change, partnership) is a ready-made hook ("I saw {signal} last {month} — how is that reshaping what {this team} prioritizes?"). For a *stale* artifact, re-verify the signal is still current before building a question on it.

## Output

Save the full report to `interview-prep/{Company} - {Role}.md` (mirrors the `reports/tier-N/{Company} - {Role}.md` naming convention so the frontend slide-over and FilesStrip can pair the two files) with this header:

```markdown
# Interview Intel: {Company} — {Role}

**Report:** {link to evaluation report if exists, or "N/A"}
**Researched:** {YYYY-MM-DD}
**Deep research:** {`data/companies/{slug}.md` (cached {age}d ago) | "none — researched fresh"}
**Sources:** {N} Glassdoor reviews, {N} Blind posts, {N} other
```

The **Deep research** line records whether Step 0 found a fresh artifact and reused
it (so a reader knows the process scaffold came from cache) or whether this prep
researched from scratch.

## Post-Research

After delivering the report:

1. Ask the user if they want to draft stories for any gaps found in Step 5
2. If they have a scheduled interview date, note it: "Your interview is in {X} days. Want me to set a reminder to review this prep?"
3. **If Step 0 found no fresh artifact** (missing or stale), suggest running `deep` mode — it builds the reusable `data/companies/{slug}.md` artifact, so the next prep *and* any `contacto` outreach for this company share one research pass instead of re-searching. If a fresh artifact *was* consumed, say so instead ("(Interview-Style scaffold reused from {age}d-old deep research.)").

## Rules

- **NEVER invent interview questions and attribute them to sources.** Inferred questions must be labeled `[inferred from JD]`.
- **NEVER fabricate Glassdoor ratings or statistics.** If the data isn't there, say so.
- **Cite everything.** Every question, every stat, every claim gets a source or an `[inferred]` tag.
- Generate in the language of the JD (EN default).
- Be direct. This is a working prep document, not a pep talk.
