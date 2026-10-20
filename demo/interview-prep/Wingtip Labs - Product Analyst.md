# Interview Intel: Wingtip Labs — Product Analyst

**Report:** [13](reports/tier-2/Wingtip Labs - Product Analyst.md)
**Researched:** 2026-10-08
**Deep research:** none — researched fresh
**Sources:** the posting, a conversation with Tomas Kral, the recruiter’s email

## Process Overview
- **Rounds:** 4 rounds, about four weeks end to end
- **Format:** recruiter screen → take-home funnel analysis (about 3 hours) → product case with a product manager and the analytics lead → team conversation
- **Difficulty:** unknown — not enough data
- **Positive experience rate:** unknown — not enough data
- **Known quirks:** the take-home comes with a real, anonymised event table; they care more about the questions you ask of it than the charts [source: Tomas Kral]
- **Sources:** the posting; Tomas Kral (product analytics lead, next to the hiring team)

### Round 1: Recruiter screen (scheduling)
- **Duration:** 30 min
- **What they evaluate:** motivation, remote set-up, salary expectations
- **How to prepare:** have the €31K figure and your Prague or remote preference ready.

### Round 2: Take-home funnel analysis
- **Duration:** about 3 hours
- **What they evaluate:** SQL on event data, a clear story, sensible next experiments
- **How to prepare:** do one practice funnel on a public product dataset first; it doubles as the example your report suggested.

## Likely Questions

### Technical
- "How would you size the effect of an onboarding change on week-one retention?" [inferred from JD]
- "What would make you distrust an A/B test result?" [inferred from JD] — sample-ratio mismatch, novelty effects, peeking.

### Behavioral
- "Tell me about an analysis that changed a decision." [inferred from JD] — The markdown ladder that cleared the season.
- "Describe learning a new domain quickly." [inferred from JD] — The forecast that beat the spreadsheet.

### Background Red Flags
- "Your experience is commercial, not product. Why product analytics?" — The questions are the same (what changed, for whom, and why); the data is events instead of tills. Show the practice funnel.

## Story Bank Mapping

| # | Likely question/topic | Competency | Best story from story-bank.md | Fit | Gap? |
|---|----------------------|-----------|-------------------------------|-----|------|
| 1 | An analysis that changed a decision | impact | The markdown ladder that cleared the season | strong | |
| 2 | Learning a new domain quickly | learning | The forecast that beat the spreadsheet | strong | |
| 3 | A product idea you pushed for | innovation | Six hours back every week | partial | |

## Technical Prep Checklist
- [ ] One practice funnel and retention analysis on public event data — why: "the take-home is a funnel analysis" [source: Tomas Kral]
- [ ] Revise A/B test pitfalls — why: "experiment design is in the posting’s first bullet"
- [ ] Write window-function SQL for sessionisation — why: "event data needs it" [inferred from JD]
