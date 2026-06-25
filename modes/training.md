# Mode: training — Course / Certification ROI

## Purpose

Decide whether a course or certification is **worth it for your actual targeting** — not in the abstract. The honest question is never "is this a good course?" but "does this close a gap that's dragging *my* evaluations down, for roles *I'm* actually targeting, at a cost proportionate to the payoff?"

This mode answers that by grounding the verdict in `data/score-history.tsv` — the accumulated fingerprint of every scouting evaluation. A cert that lifts a dimension already scoring well is a vanity purchase; one that attacks the dimension most often holding Overall down (the systemic **dimension drag**) has real leverage.

**When to use:** the user pastes or describes a course / cert / bootcamp / degree module and asks "should I do this?", "is X worth it?", "will this help me get hired?".

**This mode is analytical, not generative.** It does not enroll, buy, or schedule anything. It produces a verdict the user acts on.

## Inputs (read at evaluation time — never hardcode)

| Source | Why |
|--------|-----|
| `data/score-history.tsv` | **Primary.** The systemic dimension drag + archetype landscape the verdict is measured against. |
| `user/cv.md` | Current skill baseline — what the training would actually add vs. duplicate. |
| `user/_profile.md` | The user's archetypes + North Star — to map the training to roles they target. |
| `user/profile.yml` | Dream companies, target roles, comp targets — for the "does this open the doors I want" read. |
| `user/article-digest.md` (if present) | Existing proof points — a training that produces an artifact the user already has is redundant. |

**RULE (system-layer hygiene):** This mode has NO hardcoded priority list of "good" trainings. What counts as high-ROI is whatever closes *this* user's measured drag for *their* archetypes. Read it from the data; don't assume the user is targeting any particular field, stack, or seniority.

## Process

### Step 0 — Corpus check

If `data/score-history.tsv` is missing or has fewer than ~6 evaluations, say so plainly:

> "I can give you a generic read, but the ROI verdict is much stronger once you've run a handful of scouting evaluations — that's the corpus I measure the gap against. Right now I have {N}. Want a provisional take, or scan a few roles first?"

With a thin corpus, still run the dimensional reasoning below qualitatively, but flag the verdict as provisional.

### Step 1 — See what dimension a training *should* close

Before reasoning about the specific course, look at where the user's systemic drag actually is:

```
node scripts/training-roi.mjs --drag --summary
```

This prints the 6 scoring dimensions weakest-first. The top of that list is the gap with the most cross-archetype leverage — the thing a training is *worth* closing. Hold it in mind: if the course the user is asking about doesn't touch the top drag(s), that's the first thing to surface.

### Step 2 — Translate the course into a structured offer

Read the course description (and WebFetch/WebSearch its syllabus if a URL is given) and derive — **using your judgment, grounded in `user/cv.md` and `_profile.md`** — these fields:

- **`targetDimensions`** — which of the 6 scored dimensions the training would actually lift, in canonical terms. Map honestly:
  - A hands-on course that teaches a tool/stack the user lacks → `skills_match`.
  - A recognized credential or a structured program that clears an experience/credential gate → `ease_of_entry`.
  - Training that deepens analytical/strategic capability for the day-to-day work → `strategic_fit`.
  - A prestigious brand-name credential (top university cert, marquee program) → `brand_value`.
  - (Aliases like "ease of entry", "skills", "brand", "analytical" are accepted by the script.)
  - Be skeptical: most courses claim to lift everything. Name the **1–2** dimensions it genuinely moves for *this* user given what's already on their CV. A course teaching a tool the CV already lists lifts nothing.
- **`mappedArchetypes`** — the archetype(s) from `_profile.md` this training serves. Use the exact archetype strings the user is evaluated under in `score-history.tsv` so the script can match them.
- **`weeks`, `hoursPerWeek`, `costEur`** — the real time + money commitment (from the syllabus or the user's estimate).
- **`producesArtifact`** — `true` if it yields a demonstrable portfolio piece (a deployed project, a published analysis, a capstone) that lands on the CV, not just a completion badge.
- **`brandStrength`** — 1–10, how recruiter-recognized the credential's *issuer* is (a marquee university / company program scores high; an unknown course platform scores low). Omit if genuinely neutral.

### Step 3 — Run the ROI verdict

```
node scripts/training-roi.mjs --summary --offer '<json>'
```

Example offer JSON (illustrative — substitute the user's real values, do not copy these):

```json
{
  "name": "<course name>",
  "targetDimensions": ["skills_match", "ease_of_entry"],
  "mappedArchetypes": ["<archetype from _profile.md>"],
  "weeks": 6,
  "hoursPerWeek": 8,
  "costEur": 0,
  "producesArtifact": true,
  "brandStrength": 8
}
```

The script returns a deterministic verdict (`WORTH_IT` / `TIMEBOX` / `SKIP`), a one-line headline, and an ordered reasoning **trace**. The trace is computed from the same drag/archetype math as `positioning` and `patterns`, so it can't contradict them. **Render the trace lines verbatim** — they're the audit trail, exactly like the scouting `## Why this score` block.

### Step 4 — Write the verdict to the user

Lead with the verdict and headline, then the trace, then a short honest close. Address the user in **second person** (per `modes/_shared.md` § Report Voice).

## Verdict semantics

| Verdict | Meaning | What to tell the user |
|---------|---------|-----------------------|
| **WORTH IT** | Closes a real systemic drag, on archetypes the user targets, at proportionate effort, with a reusable artifact or recognized credential. | Do it. Name the dimension it lifts and the archetype it serves. Suggest sequencing the artifact so it lands on the CV / article-digest. |
| **WORTH IT — but TIMEBOX** | Right gap + right archetypes, but the offer is over-scoped *or* the credential signal is thin. | Do a condensed version. Cap the hours; take only the modules that close the named gap; skip the parts that pad the runtime. If the value is purely the artifact, build the artifact directly without the full course. |
| **SKIP** | The targeted dimension isn't dragging the user's evals, OR the archetypes don't appear in the corpus, OR the effort dwarfs the payoff. | Say why plainly. Then redirect: the script surfaces the user's actual top drag — point them at training (or a cheaper alternative) that closes *that* instead. |

## Always offer the cheaper alternative

For any verdict that isn't a clean WORTH IT, name the cheaper path to the same gap before the user spends time or money:

- **Skills gap** → a focused build (one real project shipping the missing skill) usually beats a multi-week course and produces a stronger artifact. Tie it to `modes/project.md`.
- **Experience/credential gate** → a targeted internship, a freelance engagement, or reframing existing CV proof points (per `positioning`) often clears the gate faster than a credential.
- **Brand gap** → a marquee-brand internship or a published piece carries more recruiter signal than a paid certificate.
- **The course is mostly a syllabus you can self-teach** → name the free/low-cost equivalent and say so.

The goal is the user's outcome, not course completion. A SKIP that redirects to a one-week project closing the real drag is a better answer than a grudging WORTH IT.

## Learning loop

If the user pushes back ("this cert is actually huge in my field", "I already have that skill", "the artifact doesn't transfer"), they're correcting your dimension/archetype mapping. Update `user/_profile.md` (e.g. an archetype-specific note on which credentials carry weight) or `user/article-digest.md` (existing proof points), never a system-layer file. The next verdict gets sharper.

## Rules

- **Ground every claim in the corpus.** The drag numbers and archetype matches come from `score-history.tsv` via the script — don't assert a gap the data doesn't show.
- **No hardcoded "good training" list.** High-ROI is user-specific and read from the data. (This is a system-layer file; see `CLAUDE.md` § System Layer Hygiene.)
- **Second person, candidate-facing voice** (`modes/_shared.md` § Report Voice).
- **This mode writes nothing to disk by default** — it reads and advises. Only update `user/*` when the user corrects the mapping (learning loop above).
- **Be honest about thin corpora.** Flag provisional verdicts rather than overclaiming.
