# Mode: mock-interview — Likely-Question Prediction + Practice Loop

When the user asks to *practice* an interview, run a mock interview, rehearse answers, or "quiz me" for a specific company+role, run this mode.

It is the **rehearsal** companion to `interview-prep` (`modes/interview-prep.md`):

| Mode | Produces | When |
|------|----------|------|
| `interview-prep` | a written intel doc (process, round-by-round, question→story mapping table) saved to `interview-prep/{Company} - {Role}.md` | research a specific interview before you've practiced |
| `mock-interview` (this) | a live, interactive practice loop — predict likely questions, ask **one at a time**, critique each answer against STAR+R | rehearse out loud once you know roughly what's coming |

They share the same assets so there's no second source of truth: the canonical **STAR+R story bank** (`interview-prep/story-bank.md` via `scripts/lib/story-bank.mjs`), the canonical **competency taxonomy** (the 12 competencies in that same module), and the cached **deep-research artifact** (`data/companies/{slug}.md` via `scripts/company-research.mjs`). Prediction + matching + the practice-loop bookkeeping are pure and unit-tested in `scripts/lib/mock-interview-core.mjs`; the `scripts/mock-interview.mjs` CLI is the read-only entry point.

> **Autonomous-mode contract.** When this mode is spawned non-interactively — `claude -p`, the starpath frontend's `shell:spawn`, a batch worker, or any context with no human in the loop — the *practice loop is interactive by nature and cannot run*. In that case: generate the **prediction brief only** (Steps 0–4: predicted questions + story matches + gap list), print a one-line completion summary, and stop. Do **not** start asking questions nobody can answer, do not propose follow-ups, do not run side-checks. If you genuinely cannot proceed (corrupted bank, missing config), write the blocker to stderr and exit non-zero. For interactive `claude` runs from a terminal, run the full loop.

## Inputs

1. **Company name** and **role title** (required). If the user only names a company, ask which role (interactive) or infer it from the most recent `reports/**/{Company} - *.md` (autonomous).
2. **Story bank** at `interview-prep/story-bank.md` — the candidate's prepared STAR+R stories. The source of every "best story" match.
3. **Profile** at `user/profile.yml` + `user/_profile.md` — read the candidate's **archetypes** (the `target_roles.archetypes[].name` list) and narrative. The archetypes + the role title drive which competencies the prediction emphasises. **Read these at runtime — never assume an archetype.**
4. **Deep-research artifact** at `data/companies/{slug}.md` (if fresh) — its `## Interview Style` section sharpens the interview *shape* (case / take-home / coding / panel) so the predicted mix matches reality. Optional; the loop runs fine without it.
5. **Evaluation report** in `reports/**/{Company} - {Role}.md` (if it exists) — read for the archetype this role was scored against and the matched/missing proof points, to flavour role-specific questions.
6. **Existing prep doc** at `interview-prep/{Company} - {Role}.md` (if `interview-prep` already ran) — reuse its sourced questions instead of re-searching; feed them in as the "real, sourced" questions (see Step 3).

## Step 0 — Predict the question set (always first)

Run the predictor. It reads the story bank + the fresh deep-research artifact (if any) off disk, predicts the likely questions for this role, matches each to the candidate's best-fit story, and lists the competencies tested but uncovered:

```bash
node scripts/mock-interview.mjs predict "{Company}" "{Role}" \
  --archetype "{archetype 1}" --archetype "{archetype 2}" --json
```

Pass **every** primary/secondary archetype from `user/profile.yml` as a repeated `--archetype` flag — they (plus the role title) decide the competency emphasis. Read the JSON:

- `questions[]` — each `{ text, competency, category, source, bestFit, gap, matches[] }`. `bestFit ∈ strong|partial|none`; `gap === true` means no bank story covers that competency.
- `gaps[]` — `{ id, label, questions[] }`: the competencies a likely question tests but **no story** covers. These are the candidate's blind spots.
- `interviewShape[]` — detected from the artifact's Interview Style (e.g. `["case","behavioral","panel"]`), or `[]` if no fresh artifact.
- `emphasis[]` — the ordered competencies driving behavioral selection.

The CLI is a **floor, not a ceiling**: it returns generic, competency-tagged behavioral prompts so a practice loop always exists even with zero research. You then *enrich* the set (Step 1–3) with company-specific and JD-specific questions before practicing.

## Step 1 — Enrich with sourced questions (interactive: optional; reuse first)

Before searching, **reuse what's already on disk:**
- If `interview-prep/{Company} - {Role}.md` exists, mine its "Likely Questions" + round-by-round sections for **real, sourced** questions (Glassdoor/Blind/JD). These beat generic prompts.
- If the deep-research artifact is fresh, its Interview Style already told you the shape.

Only if both are thin and the user wants depth, run a **targeted** Glassdoor/Blind search for `"{company} {role} interview questions"` (same query discipline as `interview-prep` Step 1). **Do NOT fabricate questions or attribute invented ones to sources.** Tag anything you infer from the JD as `[inferred from JD]`.

## Step 2 — Map the role to competencies (already done; sanity-check it)

The predictor already emphasised competencies from the archetypes + role title. Sanity-check against the `## Interview Style` shape:

- shape includes `case` → make sure `analytical` + `ambiguity` + `communication` lead (a case tests structured problem-solving under time pressure).
- shape includes `take-home` / `presentation` → add a role-specific "walk me through your approach to {the take-home's likely topic}" question.
- shape includes `coding` / `system-design` → the behavioral floor still applies, but flag that technical rounds need separate prep (this mode rehearses *spoken* answers, not live coding).
- shape includes `panel` / `onsite` → expect the full behavioral spread; don't over-narrow.

## Step 3 — Assemble the final question list

Combine, in this order (the CLI's `predictQuestions` already does this when you feed it sourced questions — prefer doing it in one call):

```bash
# Re-run with the sourced questions you gathered, so the bank floor + real
# questions are merged + de-duplicated + competency-tagged in one pass.
# (Pass sourced questions via the agent layer — see scripts/lib/mock-interview-core.mjs
#  predictQuestions({ extraQuestions }) — or simply interleave them yourself.)
```

1. **Sourced / real questions** (from the prep doc or your targeted search) — most valuable, practice these first.
2. **Bank behavioral prompts** for the emphasised competencies — the floor.
3. **One motivation question** ("why this company / why this role") — always asked.
4. **Role-specific questions** tied to the JD / the team's mandate (from the report or artifact's Team & Role Context, if present).

De-dup by normalized text (the core does this). Keep it to a practiceable size — ~6–10 questions, not 30.

## Step 4 — Show the prediction brief

Before practicing, show the candidate what's coming so they can pick where to start:

```markdown
## Mock interview: {Company} — {Role}

**Interview shape:** {case / behavioral / panel / … or "general — no cached research"}
**Story bank:** {N} stories · **competency emphasis:** {top 3–4}
**Deep research:** {data/companies/{slug}.md (cached {age}d) | none — researched fresh | none}

| # | Likely question | Competency | Best story | Fit |
|---|-----------------|-----------|-----------|-----|
| 1 | … | analytical | {story title} | strong |
| 2 | … | ambiguity | — | **gap** |

**Coverage gaps — no story for these competencies yet:** {list, or "none — every tested competency is covered"}
```

For each **gap**, name the competency and suggest a concrete experience from `user/cv.md` that could become a STAR+R story — then point the user at `interview-prep` mode (Step 5) or offer to draft the story into `interview-prep/story-bank.md` following the `templates/story-bank.template.md` contract (all five beats, Result leads with a real number from `user/cv.md`, a `**Themes:**` line). **Never fabricate a metric.**

**Autonomous mode stops here** — print a one-line summary (`predicted N questions, M gaps`) and exit.

## Step 5 — Practice loop (interactive only)

Now run the rehearsal **one question at a time**. This is the point of the mode — do not dump all questions and all model answers at once.

For each question, in order:

1. **Ask just that one question.** Verbatim. Then stop and wait for the candidate's answer. Nothing else — no hints, no model answer yet.
2. When they answer, **critique it against STAR+R** (the same five beats the story bank enforces — so practice feedback and the bank use one yardstick). Judge each dimension honestly:
   - **Situation** — set concisely (not a rambling preamble)?
   - **Task** — were the stakes / their specific responsibility clear?
   - **Action** — specific actions in the first person ("I", not a vague "we")?
   - **Result** — **quantified** (a number, %, delta)? This is the most-skipped beat.
   - **Reflection** — closed with a learning / what they'd do differently?
   Give a 0–5 score (one point per beat), name what was strong, and name the **one or two** highest-leverage fixes. Be direct; this is rehearsal, not a pep talk.
3. **Tie it back to the bank.** If a strong bank story covers this question's competency, say which one and how to open with it. If this question is a **gap**, say so plainly: "you have no prepared story for {competency} — here's the experience from your CV that should become one."
4. **Advance** to the next question only when the candidate signals they're ready (e.g. "next", "again", or a fresh answer to re-grade). Let them retry a question — re-grade the new answer.

Track progress as you go ("Question 3 of 8 · you're averaging 3.6/5 · weakest beat so far: quantified Result"). The scoring bands: **5 = strong, 3–4 = solid, 1.5–2.5 = developing, <1.5 = weak.**

## Step 6 — Wrap-up (interactive only)

When the candidate finishes (or says stop), summarise:

- **Average score** + the weakest STAR+R beat across answers (the pattern to drill — usually "quantify the Result").
- **Best answers** — which 2–3 landed, so they lean on those.
- **Open gaps** — competencies still without a story; offer to draft them into the bank now.
- One concrete next action: re-run a specific weak question, draft a gap story, or run `interview-prep` for deeper round-by-round intel. (No fabricated multi-week plans — just the next useful step.)

Do **not** auto-write anything to disk during practice. If the candidate asks to save a newly-drafted story, append it to `interview-prep/story-bank.md` per the template contract and re-run `node scripts/check-story-bank.mjs` to confirm the bank stays clean.

## Rules

- **NEVER invent interview questions and attribute them to sources.** Generic bank prompts are clearly generic; inferred ones are tagged `[inferred from JD]`; only real candidate reports get a source.
- **NEVER fabricate a metric** in a critique or a drafted story — pull numbers from `user/cv.md` / `user/article-digest.md`.
- **Ask one question at a time in the loop.** Dumping all questions + model answers defeats the rehearsal.
- **Candidate specifics come from `user/*` at runtime** — archetypes, stories, proof points. Nothing about the candidate is baked into the mode or the scripts.
- Generate in the language of the JD (EN default).
- Be direct and concrete. Honest scores beat flattering ones.
