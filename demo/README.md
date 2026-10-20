# starpath demo workspace

A fictional job search for trying the starpath app and taking screenshots. **Nothing here is real.** The candidate, her schools and employers, every company, person, URL and number are invented. Company names are placeholder names in the style of Contoso, Fabrikam and Northwind; every link and email address is on example.com; the tax, cost-of-living and salary-band caches hold illustrative demo values, not real data.

This folder has the same layout as a private data root (`private/`), so the app and the scripts read it the same way.

## The persona

**Elise Varden**, Belgian, based in Lyon. MSc in Business Analytics (Northfield Business School, Lyon) and BSc in Economics (Lakeside University, Ghent), one commercial-analytics internship. She targets pricing, analytics and strategy roles in Lyon, Vienna, Munich, Prague, Brussels, Porto. French native, English C2, Dutch B2, German B1.

## What's inside

| Path | What |
|------|------|
| `user/` | CV, `profile.yml` (eligibility, calibration, preferred cities), `_profile.md`, `portals.yml`, `article-digest.md` |
| `data/scouting.md` | 25 evaluated listings: 3 Go, 3 Stretch, 2 Solid, 2 If pipeline thin, 2 Growth target, 11 Skip, 2 Blocked |
| `data/applications.md` | 7 applications: Offer, Rejected, Interview, Discarded, Responded, Applied, Evaluated |
| `data/pipeline.md` | 30 pending inbox URLs and 25 processed |
| `data/score-history.tsv` | one row per evaluation (25) |
| `data/scan-history.tsv` | 54 postings across 13 scanner runs |
| `data/network.md`, `outreach.md`, `follow-ups.md` | 6 contacts, 6 outreach touches, 3 follow-ups |
| `data/*-cache.tsv` | demo tax, cost-of-living and salary-band values |
| `reports/tier-1..3/` | 12 evaluation reports (Go, Stretch / Solid / If pipeline thin, Growth target); Skip and Blocked write no file |
| `reports/briefs/` | one daily brief |
| `interview-prep/` | a story bank with 6 STAR+R stories and 2 interview-prep files |

## How it is made

`scripts/demo/build-demo.mjs` generates everything from `scripts/demo/seed.mjs`. Each listing in the seed holds the facts from its posting, integer judgment scores and the report prose. The build runs every listing through `scripts/score-listing.mjs`, so Want, Ease, verdict and tier always come from the current rubric. Dates are day offsets from the as-of date in `.demo-meta.json`, so a rebuild never looks stale.

Don't edit these files by hand. Change the seed and rebuild:

```bash
npm run demo:build                           # as of today
npm run demo:build -- --as-of 2026-10-20     # reproduce this exact build
node --test scripts/demo/build-demo.test.mjs # reproducibility + parser checks
```

## Using it

- **App:** pick "Explore the demo" at onboarding, or turn on Settings › General › Show demo data.
- **CLI:** scripts that read through the data root accept `STARPATH_DATA=demo`, for example `STARPATH_DATA=demo npm run brief`.
