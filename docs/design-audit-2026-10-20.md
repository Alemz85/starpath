# starpath design audit (2026-10-20)

Method: single-context critique. Evidence came from three sources: screenshots of every view of the running dev app (driven over Chrome DevTools Protocol so nothing touched the user's screen), the Impeccable mechanical detector over `frontend/src`, and a full read of the 16k lines of view code. No sub-agents were used for the two assessments, so treat the heuristic scores as one reviewer's reading, not a consensus.

Mode: Operate. starpath is a daily-use decision tool. Familiarity, scanability and consistency outrank expression; brand lives in precise details.

## 1. Verdict

The bones are good. Navigation is standard, the data model is rich, every surface has real states (loading, empty, error, running), and the violet-on-cosmos identity is distinctive without being loud. What went wrong is cumulative: each feature brought its own button, chip, label and number treatment, and nothing forced them to agree. The app now has roughly eight button styles, ten chip styles, four corner-radius systems, twenty-plus arbitrary font sizes and more than sixty uppercase tracked micro-labels. Each one is defensible alone; together they read as noise, and the report panel is where the most of them pile up.

Two data-plumbing bugs make the mess look worse than the styling alone would: the report panel labels a high-scoring Tier 1 evaluation as "T4 / Below threshold", and every Database row says "City · +1" because "City, Country" is parsed as two cities.

The fix is not a new look. It is a shared component vocabulary applied everywhere, a calmer type and label system, and one rebuilt surface (the report dossier) that shows the standard the rest of the app follows.

## 2. Design health score

| # | Heuristic | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | Visibility of system status | 3 | Running rings, elapsed chips, nav badges and the Activity log are strong. Inline status writebacks give no confirmation beyond the value changing. |
| 2 | Match between system and real world | 2 | CF/AF, "top 25% ·5", "Skills +1", "T2-high", "Untapped", "Fixability" and raw calculation strings leak the engine's vocabulary into the UI. |
| 3 | User control and freedom | 3 | Escape closes everything, filters clear in one click, discards confirm, statuses are reversible. |
| 4 | Consistency and standards | 1 | Same action looks different on every screen (Save, Apply, Generate, Run). Three title-bar patterns, two hero patterns. |
| 5 | Error prevention | 3 | Dirty-state guards on Settings, duplicate-label guard on Offers, disabled states explain themselves. |
| 6 | Recognition rather than recall | 2 | Icon-only file strip, token filters you have to know, peer cells that need a tooltip to be read. |
| 7 | Flexibility and efficiency | 3 | Command palette, `/` to search, facets, sort, export, keyboard tabs. |
| 8 | Aesthetic and minimalist design | 1 | Eyebrow labels on everything, score shown four times in one panel, decorative dials, duplicated page titles, large empty canvases. |
| 9 | Error recovery | 3 | Failure card diagnoses the cause and offers Retry or Sign in again. |
| 10 | Help and documentation | 2 | Good tooltips and setting descriptions. No help surface, and the most important tooltips (Peers, Upgrade path) hide the only explanation. |
| | **Total** | **23/40** | **Acceptable**. Solid foundation, significant consistency work needed. |

## 3. Design specificity

Authored, not interchangeable. The cosmos wash, the violet tier ladder, the orbital loaders, the constellation on Profile and the matte Activity terminal belong to this product. The weakness is the opposite: too many small inventions rather than too few. The detector found four things, all in `globals.css`: a 3px accent left border on report blockquotes, Montserrat listed twice as an overused face, and the gradient-clipped wordmark.

## 4. What is working

- **Information architecture.** Today / Chat / Scouting / Applying as workflow stages, then read-only lenses, then Profile and Settings. Nobody needs to relearn this.
- **States are real.** Loading shimmers match layouts, empty states teach the next action, failure cards diagnose. Most apps at this stage ship half of these.
- **The data layer is honest.** Noise floors, confidence tiers, "n" printed beside every rank. That rigor is a brand asset once the presentation calms down.
- **Decorative restraint on dark surfaces.** The Activity terminal with its quiet starfield is the best-looking screen in the app.

## 5. Priority issues

**[P0] Tier is read from the wrong column.** `data/score-history.tsv` stores the report-depth band in its `tier` column (`full | short | growth | skip`, per `batch/batch-prompt.md` step 6). The renderer treats it as `T1..T4`, so anything that is not literally `T1` falls through to T4. Visible damage: the slide-over badge says T4 on a high-scoring report, the Overall plate says "Below threshold", the panel's accent colour is slate, and the Database tier facet shows T1 = 0 while scouting.md lists a T1. Fix: normalise once when score-history rows enter the store (`full→T1`, `short→T2`, `growth→T3`, `skip→T4`, legacy values via `assignTier`).

**[P1] "City, Country" parses as two cities.** `parseCities('Lyon, France')` returns a multi-city entity. Every row shows "Lyon · +1", the Location facet lists country names as cities, and the slide-over shows a "Cities · Lyon · France" band. Fix: country-aware parsing (strip trailing country tokens, keep the country as a separate attribute for the facet) and bump the cache schema version so entity ids are rebuilt.

**[P1] The report panel has no hierarchy.** Six stacked bands (drag strip, tier stripe, header, pill row, cities band, tabs, score mini-bar) take roughly 300px before any content. The score appears four times (header, mini-bar, Overall plate, parsed H1). The 140px label column with 22px mono numbers and a bar per row creates a ragged left rail. Context rows dump the raw salary formula into a cell. Section icons, eyebrows and a hairline under every heading compete. Fix: rebuild as a dossier (section 7).

**[P1] No shared component vocabulary.** Buttons: `.btn-pill`, `.btn-pill-outline`, Apply outline pill, "Run filtered scan" solid rounded, "Add Listing" tinted pill, "Generate top 5" tinted rounded, "Log a touch" solid pill, Settings outline rounded, Save tinted, Kanban next-step tinted full-width, card micro-buttons. Chips: tier, status, lever, archetype, band, tag, role, dream, city, action. Radii: 4, 8, 12, 20, 24, pill. Fix: a primitives layer (`Button`, `Chip`, `PageHeader`, `StatStrip`, `SectionHeading`, `Score`) and tokens, then mechanical migration.

**[P1] Uppercase tracked labels everywhere.** FILTERS, LISTING, SCORE, CF / AF, EVALUATION, CITIES, SKILLS…COMP, OVERALL FIT, SKILLS MATCH, INBOX, EVALUATED, CAREER POSITIONING HUB, SORT:, NEAR-MISS, TOTAL EVALUATED, SCORE DISTRIBUTION, TARGETING MOMENTUM, ACTIVE PROCESSES, YOUR CAREER CONSTELLATION, TOP SCORE, IDENTITY, LANGUAGES, RELATED, and dozens more. This is the single largest source of visual noise. Fix: sentence-case 12px medium labels, no tracking, no transform.

**[P2] Page anatomy is inconsistent.** Scouting, Applying, Today and Outreach open with a 180px "editorial hero" card that repeats the title already in the title bar ("Scouting" twice; "Today" then "What's next"). Database, Reports, Trends have none. Pipeline uses its own header that ignores the title-bar height, so its top edge no longer aligns with the sidebar. Chat and Activity prefix their titles with an accent icon; others do not. Scouting then leaves a 400px empty canvas between its buttons and the Filtered Scan bar. Fix: one title bar for every view, stat strips inline (no card), content that fills the canvas.

**[P2] The Database table overflows.** Eleven columns at a 900px minimum behind a 220px sidebar and a 210px facet rail: Archetype, Added and the URL action are clipped at 1470px. The ring dial, stacked CF/AF block, peer text, lever chip and archetype pill all compete at 10–11px. Fix: plain tabular score number coloured by band, CF · AF on one line, text instead of chips for lever and archetype, sticky first column, fit-to-width.

**[P2] Applying cards overflow their own width.** Four micro-buttons under each card wrap ("Tailor CV" on two lines). Each card stacks six layers. Fix: one next-step button plus a compact icon row.

**[P2] Type system.** Montserrat is wide and loose at 11–13px, and JetBrains Mono is used for every number, date, count and code-like token, so half the screen reads as "terminal". Fix: a product sans with tabular figures (IBM Plex Sans), mono reserved for logs, paths and code.

**[P2] Colour discipline.** Violet carries actions, selection, tiers, scores, chart series, lever chips, role chips, model chips and links, so it no longer signals "action". Settings › Portals paints the must-match list green and the exclude list red: semantic colour used as category colour, a full wall of it. Score colours add teal above 9.0, so the mini-bar reads as random categories. Fix: accent for action and selection only; one ordinal violet ladder for scores and tiers; semantic colours only for lifecycle state; neutral chips in Portals.

**[P3] Smaller defects.** Profile shows a stray "name:" chip (the roles regex runs into the dream-companies block); achievement badges are emoji; constellation labels truncate ("Rotational /…"). Trends' Targeting Momentum splits 14 same-day evaluations into "earlier" and "recent" halves and declares "Declining −1.1". Reports' card grid goes ragged when one card carries a fixability footer. The command palette's first group duplicates the sidebar. `docs/DESIGN.md` still describes a dark theme with gold/silver/bronze tiers and contradicts `DESIGN-meta.md`.

## 6. Root causes

1. Tokens exist for colour but not for shape, control height or label style, so every component picked its own.
2. The type scale has six named steps, but code uses `text-[10.5px]`-style arbitrary values in more than 300 places.
3. "Eyebrow + big number" and "icon + uppercase heading" became the default way to introduce anything.
4. Two surfaces (Scouting cockpit, report panel) grew by accretion and were never re-planned as a whole.

## 7. Direction

Keep the identity: galaxy violet accent, light cosmos surface, the starpath mark, the grain, the starfield on dark panels, the orbital loaders. Replace the component layer underneath it.

- **Type.** IBM Plex Sans for all UI, self-hosted. Scale: 11 / 12 / 13 / 14 / 16 / 20 / 28. Numbers use tabular figures in the same face. IBM Plex Mono only for log output, file paths and code.
- **Labels.** Sentence case, 12px, weight 500, `text-3`. No uppercase, no letter-spacing, no eyebrows above headings.
- **Colour.** Accent = primary action, selection, active nav, links. Scores and tiers share one ordinal ladder: ≥ 8 deep indigo, ≥ 7 violet, 5–7 slate, < 5 faded slate. Semantic green / amber / red only for application lifecycle and process state. Chart palette unchanged, charts only.
- **Shape.** Controls 6px, containers 12px, overlays 16px, badges pill. Cards are flat with a hairline; shadow only on overlays and menus.
- **Page anatomy.** Every view: a 44px title row (title 15/600, meta 12 `text-3`, actions right). Stat strips inline, number 22/600 tabular, label 12. No hero cards. Content fills the canvas.
- **Density.** Rows 36–40px, tables sized to the viewport with a sticky first column.
- **Signature move.** The report dossier: compact header, verdict card, scores as a statement-style table with subtotal rows, prose with a sticky section index that tracks scroll.
- **Motion.** Unchanged: 150–250ms, state only.

`DESIGN-meta.md` is updated in the same change set; `docs/DESIGN.md` is retired to a pointer.

## 8. Change set

Foundation (shared, one owner): `tailwind.config.ts`, `globals.css`, `layout.tsx` (fonts), `lib/tier.ts`, `lib/entityId.ts`, `store/data.ts` (tier normalisation), `electron/db/schema.ts` (version bump), new `components/ui/{button,chip,page-header,stat-strip,section-heading,score}.tsx`, `DESIGN-meta.md`.

Surfaces (disjoint, parallelisable): report panel (`ReportSlideOver`, `PeerContextCard`); Database (`DatabaseView`, `OffersTable`, `FacetSidebar`, `FilterBar`, `RowActionPopover`); Applying + Today + Pipeline; Scouting + Activity + Add Listing; Reports + Trends; Settings + Profile + Chat + Outreach + Sidebar + CmdK. Onboarding is out of scope by request.

Verification: typecheck, unit tests, one batched screenshot pass of every view through the CDP driver, detector re-run.

## 9. Component libraries worth pulling in later

Checked on 2026-10-20 through the shadcn registry CLI (`npx shadcn@latest search …`). None are added in this change set; each would be a separate, scoped addition.

- **Bklit charts (`@bklit/*`, visx-based).** `radar-chart` fits the report dossier: a six-dimension fingerprint next to the scores table would be the one chart this app lacks. `heatmap-chart` matches the Profile activity grid, `funnel-chart` the Pipeline conversion panel, `line-chart`/`area-chart` the Trends time series. Adopting them means replacing recharts (`TrendsView`) and adding visx as a dependency, so do it as one "charts" change, not piecemeal.
- **Motion Primitives (`@motion-primitives/*`).** Only `animated-number` / `sliding-number` are justified here (the stat-strip figures animating when data changes is a state change, not decoration). `text-shimmer` could replace the custom shimmer on loading labels. Everything else in that registry (magnetic, tilt, spotlight, glow, cursor, dock) is decoration and stays out of an Operate surface.
- **shadcn/ui.** `empty`, `sidebar`, `data-table` exist but the app already has equivalents tuned to its data; not worth the churn. Worth revisiting only if the app moves to a `components.json`-managed component set.
- **Kokonut UI.** Needs Tailwind v4; the app is on v3. Skip until the Tailwind upgrade.
