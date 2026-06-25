<!-- ============================================================
     STORY BANK — STAR+R format contract
     Lives on disk at: interview-prep/story-bank.md  (USER LAYER — yours, never auto-overwritten)

     This file in templates/ is the SYSTEM-LAYER spec. It defines the ONE
     canonical shape that every story must take so that three consumers agree:
       - modes/interview-prep.md  (maps behavioral questions → stories)
       - modes/apply.md           (turns stories → form answers + cover letters)
       - scripts/lib/story-bank.mjs + cv-sync-check.mjs  (parse + health-check)

     When the user has no story bank yet, copy this skeleton (header + the two
     sample stories below) to interview-prep/story-bank.md and replace the
     samples with the user's real stories sourced from user/cv.md +
     user/article-digest.md. NEVER hardcode the user's actual projects into
     THIS template file — the samples here are fictional and illustrative only.
     ============================================================ -->

# Story Bank

Accumulated STAR+R stories, reused across interview prep and application drafting.
Each story is one `### {Title}` heading. The parser keys stories by title (so a
re-run updates a story instead of duplicating it) and by `**Themes:**` tags (so a
question/JD requirement can be matched to the right story).

## Format contract (per story)

```
### {Short, memorable title — the "handle" you reach for}
**Themes:** {comma-separated tags, e.g. leadership, conflict, ambiguity, data-driven}
**Situation:** {1-2 sentences. The context — when, where, what was at stake.}
**Task:** {1 sentence. Your specific responsibility / the goal you owned.}
**Action:** {2-4 sentences. What YOU did. First person, specific, verbs not adjectives.}
**Result:** {1-2 sentences. LEAD WITH THE NUMBER. Quantified outcome + business impact.}
**Reflection:** {1 sentence. The "+R" — what you learned / would do differently / how it changed you.}
```

**Rules the system enforces:**
- The five beats are required. A story missing any beat (most often `Reflection`)
  is flagged incomplete by `cv-sync-check.mjs`.
- `Result` should contain a number — a %, a count, a multiple, a currency figure,
  a time saved. A result with no digit is flagged as "unquantified".
- `Themes` drive matching. Tag generously but truthfully — these are the words a
  question/JD requirement is matched against (leadership, conflict, failure,
  ambiguity, ownership, influence-without-authority, data-driven-decision,
  stakeholder-management, delivery-under-pressure, learning-new-domain, etc.).
- Titles are unique. Same title twice = the parser treats them as one and the
  later one wins; to revise a story, edit it in place.
- Label aliases tolerated by the parser (use whichever you like, but prefer the
  canonical ones above): Context→Situation, Challenge/Goal→Task,
  Approach→Action, Outcome/Impact→Result, Learning/Takeaway→Reflection.

---

<!-- The two stories below are FICTIONAL illustrations of the format.
     Replace them with the user's real, CV-grounded stories. -->

### Rescued the migration deadline
**Themes:** ownership, delivery-under-pressure, conflict
**Situation:** A data migration for a regulated launch was two weeks behind with a hard external deadline, and two teams disagreed on the cutover plan.
**Task:** I owned getting the pipeline green and aligning both teams on a single cutover sequence.
**Action:** I re-sequenced the ETL jobs to parallelize the slow steps, paired with the two engineers nightly to clear the backlog, and ran a daily 10-minute sync to keep both teams on the same plan instead of arguing async.
**Result:** Shipped 3 days ahead of the deadline with zero data-loss incidents at cutover, and the daily-sync format was adopted by the wider team afterwards.
**Reflection:** I learned to surface schedule risk loudly and early rather than quietly absorbing it — the deadline was rescuable precisely because we named it a crisis a week out.

### Rebuilt the dashboard nobody trusted
**Themes:** ambiguity, data-driven, stakeholder-management, influence-without-authority
**Situation:** A core analytics dashboard had 20% adoption because the metric definitions were inconsistent and people didn't trust the numbers.
**Task:** Without owning the data team, I set out to rebuild the metric layer so the dashboard could be trusted again.
**Action:** I interviewed 8 stakeholders to map how each one actually defined the key metrics, reconciled the contradictions into a single documented semantic layer, and shipped it behind a clear changelog so people could see exactly what changed and why.
**Result:** Adoption climbed from 20% to 75% within one quarter, and the metric doc became the reference the team cited in planning.
**Reflection:** I learned that a trust problem is usually a definitions problem — the fix was clarity and documentation, not a fancier chart.
