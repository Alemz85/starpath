# starpath design system

The single source of truth for how the desktop app looks. Values live in `frontend/tailwind.config.ts` and `frontend/src/app/globals.css`; reusable pieces live in `frontend/src/components/ui/`. When a decision is not covered here, raise it before improvising.

## 1. Register

starpath is a tool someone uses for hours, deciding which of two hundred listings deserve an application. Mode: Operate. Familiarity, scanability and consistency outrank expression. The identity lives in precise details: the galaxy-violet accent, the cosmos wash under the page, the grain, the starfield on dark panels, the orbital loaders, the constellation on Profile. Everything else is quiet.

Three principles:

- **The data is the visual interest.** Scores, tiers, charts and statuses carry colour. Chrome, panels and labels stay neutral.
- **One vocabulary.** The same action looks the same on every screen. Buttons, chips, labels, headings and numbers come from the primitives in `components/ui/`; a view never invents its own.
- **Soft depth, not chrome.** Cards sit on the page wash with a hairline and a one-pixel contact shadow; overlays and menus float on a wide, faint, violet-tinted shadow. No grey bands: title bars, tab strips and table headers live on the page surface and separate with a hairline. The dark Activity terminal and the onboarding splash are the only immersive surfaces.

## 2. Colour

### Surfaces

| Token | Value | Use |
|---|---|---|
| `bg-cosmos` | `oklch(0.99 0.004 285)` | App shell / page wash. Never raw white for the page. |
| `bg-base` | `#FFFFFF` | Cards, popovers, inputs, the slide-over |
| `bg-elevated` | `#F7F8FA` | Chips, hover rows, inset wells |
| `bg-panel` | `#F1F4F7` | Secondary sections, skeleton blocks |
| `bg-chrome` | `#F6F7FA` | Sidebar rail only |
| `border-default` | `#E4E8ED` | Every hairline (`/70` for row separators and rails) |
| `border-strong` | `#D3D9E0` | Scrollbar thumbs, emphasised outlines |

### Text

`text-1 #050505` headings and primary values · `text-2 #1C2B33` body · `text-3 #5D6C7B` labels and secondary copy · `text-4 #8595A4` tertiary, disabled, placeholders.

### Accent

Galaxy violet `accent #7C5CFF` (hover `#5B3FE8`, press `#4A2FC8`, wash `accent-soft` 12%). Small text on white uses `accent-text #5B3FE8` for contrast. The accent means **action or selection**: primary buttons, the active nav item, selected chips and rows, links, focus rings, the one "act now" figure on a page. It is not a decoration colour and it is not a category colour.

### Tier ladder

One ordinal scale shared by tier chips and score numbers. Deeper violet = stronger fit. Never a second hue.

| Band | Token | Value | Score colour band |
|---|---|---|---|
| T1 | `tier-1` | `#3D2BB5` | score ≥ 8.0 |
| T2 | `tier-2` | `#7C5CFF` | score ≥ 7.0 |
| T3 | `tier-3` | `#8B7FC2` | score 5.0–6.9 renders slate `#5D6C7B` |
| T4 | `tier-4` | `#94A3B8` | score < 5.0 |

`lib/tier.ts` owns `scoreColor()`, `tierHex()`, `tierVerdict()`, `verdictTier()` and `tierLabel()`. Chips use `<TierChip>`, numbers use `<ScoreNumber>`. Every stored tier is normalised to T1–T4 at the store boundary (`normalizeTier` in `lib/tierLevers.ts`); the UI never sees another vocabulary.

Scoring v2 (`docs/scoring-v2.md`) colours **Want** and **Ease** each on their own with `scoreColor()`. There is no combined score: Priority (√(Want × Ease)) is a sort key and is never shown as a headline number or coloured on the ladder.

### Semantic

`success #007D1E` · `warning #F7B928` (text on white: `warning-text #8A5A00`) · `danger #C80A28`. These mean **state**: application lifecycle (Interview amber, Offer green, Rejected red), process state (failed, overdue, due soon), the eligibility gate (green, amber, red; see § 7), and nothing else. A list of keywords is not a state; it gets neutral chips.

### Charts

`chart-1…7` (`#7C5CFF #3D2BB5 #2EB8A8 #E84F8E #F2A837 #4D8DFF #8595A4`) are for categorical series in charts only. They never appear in chrome, chips or text.

## 3. Type

IBM Plex Sans for everything, self-hosted through `next/font` (`--font-sans`). IBM Plex Mono (`--font-mono`) only for log output, file paths and code. Numbers use tabular figures in the sans (`tabular-nums` is set on `body`); never reach for mono to make a number look like data.

| Class | Size / weight | Use |
|---|---|---|
| `text-display` | 28 / 600 / -0.02em | One number or title per page at most (a verdict score, an empty-state title) |
| `text-stat` | 26 / 600 | Figures in a `StatStrip` |
| `text-page` | 20 / 600 | Modal and slide-over titles |
| `text-title` | 15 / 600 | View title in the title bar, panel titles at page level |
| `text-section` | 14 / 600 | Headings inside cards, markdown `h2` |
| `text-body` | 13 / 400 | Default, table cells, inputs, buttons |
| `text-label` | 12 / 400 | Secondary lines, meta, facet rows |
| `text-micro` | 11 / 500 | Chips, footnotes under figures |

Rules:

- **Sentence case everywhere.** No `uppercase`, no `tracking-*` wider than 0, no letter-spaced eyebrows above headings. A heading carries its own weight.
- **Only the scale above.** No `text-[10.5px]`-style sizes. If a size is missing, add it here first.
- Weights 400, 500, 600 only.
- Labels are `.label` (12 / 500 / `text-3`).

## 4. Shape and elevation

| Role | Radius | Shadow |
|---|---|---|
| Controls: buttons, inputs, menu items | `rounded` 8px | secondary buttons and inputs `shadow-subtle`; primary `shadow-pill` |
| Chips, badges, counts, logos ≤ 20px | `rounded-pill` / `rounded-full` | none |
| Containers: cards, panels, table wrappers | `rounded-lg` 14px | `shadow-subtle` (1px contact) |
| Wells: kanban columns, inset lists | `rounded-lg` 14px, `bg-panel/50`, hairline `/60` | none |
| Overlays: modal, popover, command palette | `rounded-xl` 18px | `shadow-lift` / `shadow-menu` |
| Edge sheet: the report dossier (any future side panel) | square against the window edge, `.sheet` | lit left edge + deep violet shadow, over a dimmed and blurred backdrop |

Shadows are tinted toward the violet (`rgba(40, 32, 90, …)`) so depth reads as light from the page wash, never as a grey drop. `.sheet` (globals.css) is the one surface with heavier depth: a violet hairline cut edge, a 1px white highlight just inside it, and a wide shadow falling onto the app, which the backdrop (`bg-[rgba(20,14,46,0.32)] backdrop-blur-[3px]`) pushes back. Use it for panels that cover the app, never for cards. `rounded-md` (10px) is for small image frames. Nothing has a coloured left border wider than 1px. Native checkboxes and selects are restyled globally (rounded accent checkbox, quiet chevron), so views never need a custom control for them.

## 5. Spacing and density

8px grid. Page body padding 20px (`p-5`); inside cards 16px (`p-4`); between cards 12px; between sections 20px. Table rows 36–40px; list rows 44–48px with a 28–32px logo; kanban cards 10px padding. Title bar height is fixed by `.title-bar` (40px top clearance for macOS traffic lights plus 8px) so the sidebar and every view share one horizontal line.

## 6. Page anatomy

Every view is the same skeleton:

1. `<PageHeader title meta actions />` — the only title, on the page wash with a hairline under it (no grey band). No icon before it, no hero card repeating it below.
2. Optional `<ViewTabs>` strip directly under the header for views with more than one surface.
3. Body: `flex-1 min-h-0` with `p-5` (or a split layout with its own scroll areas). Content fills the canvas; a page never leaves a large empty middle.
4. Key figures, when a page has them, go in a `<StatStrip>` at the top of the body: a quiet card with the faint galaxy wash, figures at 26px with sentence-case labels, at most one figure in the accent or a semantic tone. It replaces the old hero card; the page title stays in the header only.

The Applying board and Outreach lead with a `StatStrip`. Scout has its own overview card instead (below).

### View anatomies

- **Scout** (`components/scout/ScoutView.tsx`, home; the former Scouting and Today tabs). Header meta carries last-scan and scans-this-month. Body: (1) the **"Where things stand"** card, a `card galaxy-bg shadow-cosmos` with a titled header row, split two ways by a hairline: left, "Applications" as a row of five icon tiles (Sent, Responded, Interviews, Offers, then Rejected set apart by a hairline), each a 36px round tile beside a `text-stat` figure, the tile coloured only when the count is non-zero (accent in motion, amber interviews, green offers, red rejected), with a one-line conversion read-out under the row; right, a **"Needs you"** list of 44px rows (icon tile, label, hint, figure) for listings to filter, deadlines, waiting for a reply, waiting for next round, with act-now figures in accent or danger plus a dot. No bars, no Evaluated tile (that count lives in the card's meta). (2) The action row: large pill buttons, scans grouped (Full scan primary, API only, Filtered scan with its selection count), a divider, Filter to Database, a divider, Add listing (tinted) and the model chip (ghost), with a one-line hover description under the row. (3) The daily brief when enabled, then a flush **Deadlines** panel with 56px rows filling the rest.
- **Filtered scan picker**: a dialog (`rounded-xl shadow-lift`, 720px, opens from the Filtered scan pill) listing every tracked company as a `chip chip-md` toggle with its logo, dream companies first with a Star; footer: Clear and Reset to dreams as ghost, Cancel secondary, Run filtered scan primary. The selection lives in the scan-filter store and the pill shows its count.
- **Applying**: `StatStrip` (Sent, Responded, Interviewing, Offers), the inbox as a one-row card, then the kanban: columns are soft wells (`bg-panel/50`, hairline `/60`) with a dot-plus-label header, cards are `card` with one next-step `Button` and a row of icon-only ghost actions.
- **Database**: the table in a floating `card` beside the filter rail (§ 8).
- **Report dossier** (`components/reports/ReportSlideOver.tsx`, a `.sheet` 1040px wide): header block with the company logo, name, role, a meta line (TierChip, score, verdict, archetype, location, evaluated), the action row (Apply, Open listing, files strip, View in Database), then underline tabs (Scouting report, Application prep, History). Body is a 168px section rail (scroll-spy over every `data-slug` element, one entry per slug) beside the content: the summary card (outline entry "Summary": the big score, the verdict, Current and Aspirational fit, and the why-this-score text), the scores as a statement-style table (group header with rollup, rows of number, label with a 56px bar, reasoning; long calculations clamp to three lines), the peer-context panel, then the markdown sections. Scoring v2 changes the figures shown here (Want · Ease, verdict), not the anatomy.

## 7. Components

Import from `@/components/ui`.

- **Button** `tone` primary | secondary | ghost | tinted | danger | stop, `size` xs | sm | md | lg, `icon`, `trailing`, `iconOnly`, `loading`, `pill`. A page-level action row (Scouting's scan buttons) uses `size="lg" pill`; everything inside panels, tables and dialogs stays on the 8px shape. Primary = the one main action in view. Secondary = everything else that commits. Ghost = low-emphasis and toolbar actions. Tinted = accent-wash for "AI run" actions (Generate, Analyze, Run filtered scan). Stop = a running action that can be killed. Raw elements may use the CSS classes `.btn .btn-primary …`.
- **Chip** `tone` neutral | accent | success | warning | danger | muted | plain, `size`. Always pill-shaped, sentence case. **TierChip** for tiers, **StatusChip** for lifecycle statuses.
- **PageHeader** title · meta · actions.
- **StatStrip / Stat** value · label · hint · tone · dot · title. The strip is a card with the galaxy wash by default; `flat` for strips inside panels.
- **SectionHeading** title · meta · action · rule. Used inside cards and for page sections; replaces every icon-plus-uppercase heading.
- **Panel** card with an optional heading.
- **ScoreNumber** sizes sm | md | lg | xl, optional `/10` denominator; **ScoreBar** 3px magnitude bar. These replace ring dials and gradient bars.
- **Want · Ease** (`components/shared/WantEase`): the one way to show a listing's scores. Want first, then Ease, as two `ScoreNumber`s at size md, each with a `.label` caption ("Want 8.3 · Ease 5.6"), each in its own ladder colour. Never one combined number, never Priority. Dense cells under a column header may drop the captions (`bare`) and go to size sm. A missing score shows "—". A blocked listing has no scores: its reason replaces the pair as plain `text-label text-danger`.
- **Eligibility chip** (`components/shared/EligibilityChip`): `Chip` with tone success "Eligible" (green), warning "Check first" (amber), danger "Blocked" (red). The reason goes in the tooltip or in plain `text-label text-3` beside it. A compact dot form exists for dense table cells.
- **Verdict** labels come from `tierVerdict()` only: Go, Stretch, Growth target, Solid, If pipeline thin, Skip, Blocked; `tierVerdict(v)` appends the action ("Stretch — apply with prep"), `{ short: true }` gives the label alone. A verdict has no colour of its own: `VerdictChip` is a `TierChip` coloured by the verdict's tier (`verdictTier()`: go T1; stretch, solid, thin T2; growth T3; skip, blocked T4).
- **ViewTabs** (shared) for sub-surfaces. **EmptyState** for "no data yet" surfaces.
- CSS classes for plain markup: `.input`, `.input-sm`, `.kbd`, `.th` (table header cell), `.card`, `.label`.

Every interactive element has hover, focus-visible, disabled and (where it applies) loading and active states. Icons come from `lucide-react` at 14px (buttons, headings), 13px (chips, dense rows) or 12px (inline), never hand-drawn and never emoji.

## 8. Tables and lists

A full-page table lives in a `card` on the page wash (the Database), with its filter rail beside it on the wash rather than in a bordered sidebar. Header cells use `.th` (12 / 500 / `text-3`, sentence case) on the table surface with a bottom hairline, no fill. Rows are 44–52px (52 when a row carries two text lines and a logo) with a `border-default/50` hairline between them, hover `bg-bg-elevated`, selected `bg-accent-soft`. The table fits its container; when it cannot, the first column is sticky and the rest scroll. Numbers are right-aligned and tabular. Secondary facts (peer rank, upgrade lever, archetype) are plain `text-3` text, not chips, unless they carry a state.

## 9. Motion

150–250ms, `ease-quart`. Motion conveys state (open, select, hover, load, expand), never decoration. The running indicator (orbital loader) and the one pulsing dot on an "act now" figure are the only animated elements at rest. No mount choreography. `prefers-reduced-motion` disables the starfield, loaders and shimmer.

## 10. Keep / retire

Keep: cosmos grain, `galaxy-bg` on empty states, `galaxy-stars` on the Activity terminal and onboarding, orbital loaders, the Profile constellation, the jokey loading messages.

Retired: the Meta-store hero cards, pill buttons, ring dials, the teal "stellar" score colour, uppercase eyebrows, mono numbers, gradient wordmark text, emoji badges, coloured keyword walls in Settings, duplicate page titles.

## 11. Migrating a view (checklist)

1. Replace the title row with `<PageHeader>`; delete any hero card that repeats the title; move its figures into a `<StatStrip>`.
2. Replace every uppercase/tracked label with `.label` or `<SectionHeading>`; replace icon-plus-caps headings with `<SectionHeading>`.
3. Replace ad-hoc buttons with `<Button>` (one `primary` per view at most), ad-hoc tags with `<Chip>` / `<TierChip>` / `<StatusChip>`.
4. Replace `font-mono` on numbers, dates and counts with plain text (`tabular-nums` is global); keep mono only on paths, logs and code.
5. Replace `text-[Npx]` with the scale in § 3; replace radii and shadows with § 4 (cards get the 1px contact shadow, nothing heavier except overlays and the sheet).
6. Replace ring dials and gradient bars with `<ScoreNumber>` / `<ScoreBar>`; replace `scoreColor` call sites that expect teal.
7. Check contrast (body ≥ 4.5:1), hover/focus/disabled on every control, truncation on long strings, and the view at 1280px wide.

## 12. Changelog

Newest first; every entry below landed on 2026-10-20. The audit that started this is `docs/design-audit-2026-10-20.md`.

- **Dossier outline.** The dossier's first card is the "Summary" outline entry; the markdown "Recommendation" section keeps its own name, so the outline never lists Verdict twice.
- **Report sheet.** Report panel becomes a 1040px `.sheet` with a lit edge, deep tinted shadow and a dimmed, blurred backdrop.
- **Dossier spacing.** More room around the dossier: header padding, taller tabs, 168px section rail, deeper body inset.
- **Scout stages.** Scout's application stages as icon tiles, Rejected set apart at the right, bars and the Evaluated tile removed.
- **Scout home.** Today merged into Scout: "Where things stand" card, action row, daily brief, Deadlines panel; `today` view id aliases `scouting`.
- **Database card.** Database table in a floating card with 52px rows; scan row as large pill buttons; Filtered scan is a picker dialog.
- **Softening pass.** Softening pass after review: radii 8/10/14/18, pill chips, lighter hairlines, no grey chrome bands, violet-tinted shadows, restyled native checkboxes and selects.
- **Design system v2.** IBM Plex, seven-step scale, sentence case, one violet ladder, primitives in `components/ui/`, every view migrated except onboarding, report dossier rebuilt, tier and city parsing fixes.
- Scoring v2 (the "Scoring system rework" session) merged on top the same day: Want · Ease, Verdict, eligibility chips, `SCHEMA_VERSION` 8; § 7 documents its components.

Open: a full visual pass once the scoring batch has refilled `data/score-history.tsv` (listings were archived for the re-score); a charts pass (Bklit radar in the dossier, heatmap, funnel) proposed as a separate session; onboarding screens untouched by request.
