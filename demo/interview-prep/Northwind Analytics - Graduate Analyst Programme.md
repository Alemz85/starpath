# Interview Intel: Northwind Analytics — Graduate Analyst Programme

**Report:** [8](reports/tier-1/Northwind Analytics - Graduate Analyst Programme.md)
**Researched:** 2026-10-10
**Deep research:** none — researched fresh
**Sources:** the posting, notes from Inès Moreau on last year’s process, the recruiter’s invitation emails

## Process Overview
- **Rounds:** 4 rounds, about five weeks end to end
- **Format:** recruiter screen → online numerical test → case interview with two analysts → final round (case presentation to a partner, then a values conversation)
- **Difficulty:** unknown — not enough data
- **Positive experience rate:** unknown — not enough data
- **Known quirks:** the final-round case arrives 48 hours ahead; after you present, they change one assumption and ask you to rework the answer on the spot [source: Inès Moreau, last year’s cohort]
- **Sources:** the posting; Inès Moreau (your referrer); invitation emails from Paul Girard, graduate recruiter

### Round 1: Recruiter screen (done)
- **Duration:** 30 min
- **Conducted by:** recruiter
- **What they evaluate:** motivation, programme fit, start date
- **Reported questions:**
  - "Why Northwind rather than a consultancy?" — [source: your screen notes]
- **How to prepare:** done; keep the answer for the partner, who will ask it again in other words.

### Round 2: Online numerical test (done)
- **Duration:** 40 min
- **What they evaluate:** speed and accuracy with tables and percentages

### Round 3: Case interview (passed)
- **Duration:** 60 min
- **Conducted by:** two analysts from the pricing and client-analytics teams
- **What they evaluate:** structuring, quantitative reasoning, a clear recommendation
- **Reported questions:**
  - "A grocery client cut prices on its private label and sales stayed flat. Why might that be?" — [source: your case-round notes]

### Round 4: Final round (next)
- **Duration:** 90 min: a 20-minute case presentation to a partner, then a 40-minute values conversation
- **Conducted by:** a partner and a programme manager
- **What they evaluate:** how your recommendation holds up when an assumption changes; candour; client focus
- **Reported questions:**
  - "Your key assumption turns out 30% too optimistic. What changes in your recommendation?" — [source: Inès Moreau]
  - "Tell me about a time you told someone something they didn’t want to hear." — [source: Inès Moreau]
- **How to prepare:** rehearse the case twice against a timer, and bring one sensitivity slide for your main assumption.

## Likely Questions

### Technical
- "How would you estimate price elasticity from transaction data with frequent promotions?" [inferred from JD] — your thesis method (store and week effects), then what you would change with promotion flags.
- "How do you know a forecast is good enough to plan on?" [inferred from JD] — the capstone’s held-out season and the comparison against the incumbent method.
- "Walk me through a dbt model you’ve built." [inferred from JD] — be honest that it was course-level, then show the capstone rebuild.

### Behavioral
- "Tell me about a time you told someone something they didn’t want to hear." [source: Inès Moreau] — The elasticity number that was wrong.
- "Describe a time a teammate let the group down." [inferred from JD] — The teammate who went quiet.
- "Tell me about something you built that people actually used." [inferred from JD] — The markdown ladder that cleared the season.

### Role-Specific
- "Which rotation would you pick first, and why?" [source: recruiter screen] — pricing first: it is where your thesis and internship already point, and it makes the client-analytics rotation sharper afterwards.
- "What would you want to learn on a client pricing engagement?" [inferred from JD] — how a client decides which price changes to test, and what evidence moves them.

### Background Red Flags
- "You have one internship. Why should we expect you to handle client work?" — The internship had you presenting to category managers who could overrule you, and the capstone had a real client with a real deadline. Say that plainly.
- "You studied in Ghent and Lyon. Are you staying in Lyon?" — Yes: Lyon is your first-choice city, and you are already there.

## Story Bank Mapping

| # | Likely question/topic | Competency | Best story from story-bank.md | Fit | Gap? |
|---|----------------------|-----------|-------------------------------|-----|------|
| 1 | Telling someone unwelcome news | communication | The elasticity number that was wrong | strong | |
| 2 | A teammate who let the group down | conflict | The teammate who went quiet | strong | |
| 3 | Something you built that people used | impact | The markdown ladder that cleared the season | strong | |
| 4 | Working through ambiguity with a client | ambiguity | The forecast that beat the spreadsheet | partial | |
| 5 | Leading without formal authority | leadership | Case night for 120 students | partial | |
| 6 | A stakeholder who disagreed with your numbers | customer | — | none | yes |

You need a story about a stakeholder who pushed back on your analysis. Consider the category manager at Adventure Works who overruled the ladder for two product families, and what the sales data showed afterwards.

## Technical Prep Checklist
- [ ] Rehearse a pricing case end to end against a timer — why: "the final round is a presented case with a changed assumption"
- [ ] Build one sensitivity slide for your main assumption — why: "they change one assumption live" [source: Inès Moreau]
- [ ] Rebuild the capstone data preparation in dbt — why: "dbt is listed as preferred in the posting"
- [ ] Refresh fixed effects and clustered errors — why: "elasticity estimation is the pricing rotation’s core method" [inferred from JD]
- [ ] Prepare two questions about the pricing practice’s client work — why: "shows you have already chosen a rotation"

## Company Signals
- **Values they screen for:** candour and client focus; the posting says they "would rather hear the bad news early".
- **Vocabulary to use:** rotation, engagement, data product.
- **Things to avoid:** overselling a model; Inès says partners like hearing what the model can’t tell you.
- **Questions to ask them:**
  - How does the pricing practice decide which engagements graduates join?
  - What does a strong first rotation look like at the promotion review?
  - Where is the data-products team taking its pricing tools next?
