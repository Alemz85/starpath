# starpath design system

The single source of truth for how the desktop app looks. Values live in `frontend/tailwind.config.ts` and `frontend/src/app/globals.css`; reusable pieces live in `frontend/src/components/ui/`. When a decision is not covered here, raise it before improvising.

## 1. Register

starpath is a tool someone uses for hours, deciding which of two hundred listings deserve an application. Mode: Operate. Familiarity, scanability and consistency outrank expression. The identity lives in precise details: the theme's accent and night sidebar, the cosmos wash under the page, the grain, the starfield on dark panels, the orbital loaders, the constellation on Profile. Everything else is quiet.

Three principles:

- **The data is the visual interest.** Scores, tiers, charts and statuses carry colour. Chrome, panels and labels stay neutral.
- **One vocabulary.** The same action looks the same on every screen. Buttons, chips, labels, headings and numbers come from the primitives in `components/ui/`; a view never invents its own.
- **Depth only where something floats.** Cards, inputs and secondary buttons sit on the page wash with a hairline and no shadow; overlays, menus and the report sheet float on a wide, faint, night-tinted shadow. No grey bands: title bars, tab strips and table headers live on the page surface and separate with a hairline. The dark Activity terminal and the onboarding splash are the only immersive surfaces.

**Identity, kept on purpose.** Two outside rulebooks were run over the app on 2026-10-22 (`docs/design-review-apple-2026-10-22.md` against Apple's HIG, and the taste-skill app-screens chapter). Both would strip the night sidebar with its stars, the cosmos wash and the galaxy wash under stat cards, and the violet and indigo accents of two themes. Those stay: they are the three things a person remembers about starpath, each spent in one place, and the HIG's own branding page asks for exactly that ("branding defers to content"). Everything else those reviews found was taken.

## 2. Colour

### How colour works: themes and roles

The app has switchable colour themes (Settings › General › Appearance). A component never names a colour; it names a **role** ("primary button", "selected", "top score", "sidebar background"), and the active theme decides what colour that role gets. Switching theme repaints everything through CSS variables, with no re-render.

- **Values** live in one file: `frontend/src/app/themes.css`, one `[data-palette="<id>"]` block per theme, every block defining the same tokens.
- **Classes** come from `frontend/tailwind.config.ts`, which maps each role to a Tailwind name (`bg-accent`, `text-text-3`, `border-nav-line`) and replaces Tailwind's default palette, so `bg-gray-100` does not exist.
- **Inline styles, SVG and chart props** use `themeColor('accent', 0.2)` from `lib/themes.ts`, or the tier helpers in `lib/tier.ts` (`scoreColor`, `tierColor(tier, alpha?)`, `TIER_COLOR`, `TIER_BG`).
- **The rule:** a raw colour (hex, `rgb(…)` with numbers, `oklch`, `bg-[#…]`) in a component fails `npm test` (`src/lib/colorLiterals.test.ts`). So does an opacity modifier off Tailwind's scale (`bg-accent/12` generates no CSS; use `/10`, `/15` or `/[0.12]`). The only exceptions are listed in that test with a reason: `themes.css`, fallback company-logo avatars, the Claude mark, and onboarding.
- **When no role fits**, add a role to every theme (and to `CHANNEL_TOKENS` in `lib/themes.ts` and `tailwind.config.ts`), document it in the table below, and let `src/lib/themes.test.ts` check that every theme defines it and stays readable. Never hard-code "just this once".
- The attribute is `data-palette`, not `data-theme`: a future light/dark axis would sit beside it. Don't rename it.

### Themes

| id | Name | Character |
|---|---|---|
| `bluehour` | **Blue hour** (default) | One blue family from night to sky: navy sidebar with stars, navy primary buttons, cerulean accent, navy→cerulean→steel ladder, one pale starlight brand star. |
| `aurora` | Aurora | Navy night sidebar with stars and an aurora glow at its foot; jade carries selection and the score ladder; navy buttons. Success shifts to leaf green so it never reads as a score. |
| `starchart` | Star chart | Prussian-blue sidebar with a drawn gold constellation; chart-blue selection; gold marks only Go / T1 and the brand. Warning is burnt orange so it never reads as gold. |
| `observatory` | Observatory | Night-violet sidebar with stars, lavender day, indigo pill actions. |
| `galaxy` | Galaxy | The original v2 palette: galaxy violet on cool greys, light sidebar. Kept as it shipped, apart from the active-nav highlight that `bg-accent/12` used to drop. |

Onboarding and the tailoring screen pin `data-palette="galaxy"` on their root, whatever theme is stored.

### Roles

Values per theme are in `themes.css`; the table says what each role is for.

| Role (class) | Use |
|---|---|
| `bg-cosmos` | App shell / page wash. Never raw white for the page. |
| `bg-base` | Cards, popovers, inputs, the slide-over |
| `bg-elevated` | Chips, hover rows, inset wells |
| `bg-panel` | Secondary sections, skeleton blocks |
| `border-default` · `border-strong` | Every hairline (`/70` for row separators) · scrollbar thumbs, emphasised outlines |
| `divider` · `divider-soft` · `control-border` | Report-prose rules and table rows · checkbox outline |
| `text-1` … `text-4` | Headings and primary values · body · labels and secondary copy · placeholders, footnotes, denominators. Every tier holds 4.5:1 on the wash and on cards (`themes.test.ts`); `text-4` is quiet, never faint |
| `action` · `action-hover` · `action-press` · `action-text` | **Primary buttons only.** A theme may set it apart from the accent (navy buttons beside a cerulean accent); Galaxy maps it to the accent. |
| `accent` · `accent-hover` · `accent-press` · `accent-text` · `accent-light` · `accent-soft` | **Selection and links**: the active nav item, selected chips and rows, links, focus rings, tinted "AI run" buttons, the one "act now" figure on a page. Small text on white uses `accent-text`. Not a decoration colour, not a category colour. |
| `tier-1` … `tier-4` (+ `-bg`, `-light`) | The ordinal score ladder (below) |
| `score-mid` | Scores 5.0–6.9, and the neutral score fallback |
| `success` · `warning` (+ `warning-text`) · `danger` | State only (below) |
| `chart-1` … `chart-7` | Categorical chart series only |
| `night-deep` · `night` · `night-2` · `scrim` | Dark surfaces: the Activity terminal, dark tooltips, the onboarding sky, the sheet backdrop |
| `term-*` | Activity terminal line colours (text, tool use, ok, error, warning) |
| `nav-*` | The sidebar: background, line, text, strong, muted, faint, hover, active background/text, count badge, accent (running indicator), brand gradient, search input |
| `track` · `track-strong` · `bar-track` | Scrollbar thumbs · their hover · score-bar and shimmer tracks |
| `glow-2` · `star-1` · `star-2` · `shadow` · `shadow-accent` | Atmosphere: the second wash hue, star tints, the tint of every shadow |

### Tier ladder

One ordinal scale shared by tier chips and score numbers: the deeper the tier colour, the stronger the fit. Never a second hue inside one theme. The ladder fades by chroma, not by lightness: `tier-3` and `tier-4` hold 4.5:1 on the wash and on their chip tints, so a Match of 3.2 is still a number someone can read (Apple's floor for text under 18pt). `scoreColor()`: ≥ 8.0 `tier-1`, ≥ 7.0 `tier-2`, 5.0–6.9 `score-mid`, < 5.0 `tier-4`. Chips use `<TierChip>`, numbers use `<ScoreNumber>`. Every stored tier is normalised to T1–T4 at the store boundary (`normalizeTier` in `lib/tierLevers.ts`); the UI never sees another vocabulary.

Scoring v2 (`docs/scoring-v2.md`) colours **Match** and **Ease** each on their own with `scoreColor()`. There is no combined score: Priority (√(Match × Ease)) is a sort key and is never shown as a headline number or coloured on the ladder.

### Semantic

`success`, `warning` (text on white: `warning-text`), `danger` mean **state**: application lifecycle (Interview amber, Offer green, Rejected red), process state (failed, finished with warnings, overdue, due soon), the eligibility gate (green, amber, red; see § 7), and nothing else. A list of keywords is not a state; it gets neutral chips.

### Contrast

`src/lib/themes.test.ts` checks every theme: body text (`text-1…3`, `accent-text`, `score-mid`, semantic text, `tier-1`) ≥ 4.5:1 on white, `action-text` on `action` ≥ 4.5, sidebar text on the sidebar ≥ 4.5, `tier-2` and the T2/T3 chips ≥ 3. T3 and T4 are deliberately faded steps. Galaxy keeps its one known miss (white on `#7C5CFF`, 4.35) as shipped.

### Charts

`chart-1…7` are for categorical series only. They never appear in chrome, chips or text.

- **Count bars** (Trends › Listings posted per week / month): bars count listings by the period they were posted (scan-history's posting date, else their first evaluation), split into the strong matches at the foot in `tier-1` (`tierColor('T1')`: Match ≥ 8.0 and not blocked, the colour a Match of 8 takes everywhere), the rest in `chart-7`, and the blocked share on top in `danger` at 0.4 (the eligibility red). No score line: a count needs no gate. The tooltip states the counts and which date placed the bar's listings (posting date or first evaluation); a `text-micro text-4` footnote under the chart gives the totals and the wanted rule.
- **Composition bars** (Trends › Archetype focus): 100% stacked rows, one per half of the window, segments in the categorical palette with the muted `chart-7` for the tail, and a legend that doubles as the table (share, shift). No scores on a composition card.

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
| Controls: buttons, inputs, menu items | `rounded` 8px | none at rest (a hairline, never a hairline and a shadow); primary `shadow-pill` |
| Chips, badges, counts, logos ≤ 20px | `rounded-pill` / `rounded-full` | none |
| Containers: cards, panels, table wrappers | `rounded-lg` 14px | none: the hairline separates |
| Wells: kanban columns, inset lists | `rounded-lg` 14px, `bg-panel/50`, hairline `/60` | none |
| Overlays: modal, popover, command palette | `rounded-xl` 18px | `shadow-lift` / `shadow-menu` |
| Edge sheet: the report dossier (any future side panel) | square against the window edge, `.sheet` | lit left edge + deep night-tinted shadow, over a dimmed and blurred backdrop |

Shadows are tinted from the theme's night (`shadow` role) so depth reads as light from the page wash, never as a grey drop. `.sheet` (globals.css) is the one surface with heavier depth: an accent-tinted hairline cut edge, a 1px white highlight just inside it, and a wide shadow falling onto the app, which the dimmed backdrop (`bg-scrim/[0.32]`) pushes back. Use it for panels that cover the app, never for cards. **No blur anywhere:** scrims dim, they do not frost (HIG materials: blur belongs to the floating layer the system draws, never to content), and `prefers-reduced-transparency` removes any `backdrop-filter` that slips in. `prefers-contrast: more` steps every hairline to `border-strong` and every grey tier up one. `rounded-md` (10px) is for small image frames. Nothing has a coloured left border wider than 1px. Native checkboxes and selects are restyled globally (rounded accent checkbox, quiet chevron), so views never need a custom control for them.

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

- **Scout** (`components/scout/ScoutView.tsx`, home; the former Scouting and Today tabs). Header meta carries last-scan and scans-this-month. Body: (1) the **"Where things stand"** card, a `card galaxy-bg` with a titled header row, split two ways by a hairline: left, "Applications" as a row of five figure-over-label cells (Sent, Responded, Interviews, Offers, then Rejected set apart by a hairline), each a `text-stat` figure over a `text-label text-3` label, the figure in `text-1` at zero and in its tone only when the count is non-zero (accent in motion, amber interviews, green offers, red rejected), with a one-line conversion read-out under the row; right, a **"Needs you"** list of 40px rows (label, hint, figure) for listings to filter, deadlines, waiting for a reply, waiting for next round, with act-now figures in accent or danger plus a dot. No icon tiles, no bars, no Evaluated cell (that count lives in the card's meta): a KPI is type, and an icon that repeats its label is an accessory. (2) The action row, centred under the card: large pill buttons, scans grouped (Full scan primary, API only, "Filtered scan…" with its selection count), a divider, Filter to Database, a divider, "Add listing…" (tinted) and the model chip (ghost), with a one-line hover description centred under the row. A button that opens a dialog ends in an ellipsis. (3) The daily brief when enabled, then a flush **Deadlines** panel with 56px rows filling the rest.
- **Filtered scan picker**: a dialog (`rounded-xl shadow-lift`, 720px, opens from the Filtered scan pill) listing every tracked company as a `chip chip-md` toggle with its logo, dream companies first with a Star; footer: Clear and Reset to dreams as ghost, Cancel secondary, Run filtered scan primary. The selection lives in the scan-filter store and the pill shows its count.
- **Applying** (tracks, never nags: no next-step prompts, no overdue badges): `StatStrip` (Sent, Responded, Interviewing, Offers, then Rejected in `danger` when non-zero), then the kanban: six columns (Evaluated → Offer, then Rejected) that share the width with a 220px floor and scroll sideways below it; columns are soft wells (`bg-panel/50`, hairline `/60`) with a dot-plus-label header. A card: logo, company, role; Match · Ease (one decimal) with the **date cue** on the right (a 12px icon for which date it is, `CalendarClock` deadline, `CalendarPlus` posted, `Radar` first scan, plus a short `text-label text-3` span like "12d"; the full date in the tooltip; only a deadline within a week on an Evaluated card turns `warning-text`); a rejected card adds one `text-label text-3` line "12 Oct · after the case study" with a ghost pencil; the bottom row is the quiet stage dropdown (ghost `xs`, board stages), the files strip and an icon-only Report button that opens the report sheet in place. Moving a card to Rejected opens a 420px dialog asking only for the date (today by default, past allowed) and showing the inferred stage, with optional one-click `chip chip-md` refinements (selected = `chip-accent`). Discarded rows sit in the collapsed Closed strip under the board.
- **Database**: the table in a floating `card` beside the filter rail (§ 8). The title bar holds Untapped and Export only; the "Show unscored" checkbox sits in the search row with the other view options, never in the window frame.
- **Token usage** (Settings › General, `components/settings/UsageSection.tsx`, a `SettingRow`): two figures (`text-stat`, `text-1`) for this week and last week with a `text-label text-4` line under each (runs, tokens in / out), then a hairline-bordered list of recent runs in 32px rows (label `text-body font-medium`, the run kind in `text-label text-3` or `text-danger` when it failed, date, tokens, cost right-aligned and tabular), scrolling inside 220px, and a `text-micro text-4` count underneath. Empty = one `text-label text-3` line.
- **Report dossier** (`components/reports/ReportSlideOver.tsx`, a `.sheet` 1040px wide; self-contained, so any view can mount it): the header is the identity line (company logo, name, role, close), then two zones. Left, under the name, the **job facts** as a stacked label/value list (Location, Work mode, Contract, Seniority, Salary, Archetype, Posted — or First seen when the scan had no posting date —, Deadline, Documents, Evaluated, Also in), facts the data lacks left out; Documents is what the application asks you to submit ("CV, transcript required · cover letter optional · 1 file, 1 MB max", plain `text-1` like every fact, never a semantic colour; the per-item breakdown and its source on hover) and, when the report's line knows nothing, a muted `text-3` "Not stated" rather than nothing, so an unknown never reads as "not needed"; a multi-city listing reads "first city +N more" with every city on hover, never the whole list. Right, a 392px well (`rounded-lg bg-panel/50`, hairline `/60`) with what the app made of the listing: VerdictChip with its action, the Eligibility chip, Match · Ease, then the actions (Apply status, Open listing, files strip, View in Database). Then underline tabs (Scouting report, Application prep, History). Body is a 168px section rail (scroll-spy over every `data-slug` element, one entry per slug) beside the content: the **summary card** in thirds (outline entry "Summary": the two score tiles stacked on the left, the report's own TL;DR on the right two thirds, verbatim; reports without one show the Recommendation's opening paragraph labelled "From the recommendation"; no verdict in this card), the scores as a statement-style table (group header with rollup, rows of number, label with a 56px bar, reasoning; long calculations clamp to three lines), the peer-context panel, then the markdown sections.
## 7. Components

Import from `@/components/ui`.

- **Button** `tone` primary | secondary | ghost | tinted | danger | stop, `size` xs | sm | md | lg, `icon`, `trailing`, `iconOnly`, `loading`, `pill`. A page-level action row (Scouting's scan buttons) uses `size="lg" pill`; everything inside panels, tables and dialogs stays on the 8px shape. Primary = the one main action in view. Secondary = everything else that commits. Ghost = low-emphasis and toolbar actions. Tinted = accent-wash for "AI run" actions (Generate, Analyze, Run filtered scan). Stop = a running action that can be killed. Raw elements may use the CSS classes `.btn .btn-primary …`.
- **Chip** `tone` neutral | accent | success | warning | danger | muted | plain, `size`. Always pill-shaped, sentence case. **TierChip** for tiers, **StatusChip** for lifecycle statuses.
- **PageHeader** title · meta · actions.
- **StatStrip / Stat** value · label · hint · tone · dot · title. The strip is a card with the galaxy wash by default; `flat` for strips inside panels.
- **SectionHeading** title · meta · action · rule. Used inside cards and for page sections; replaces every icon-plus-uppercase heading.
- **Panel** card with an optional heading.
- **ScoreNumber** sizes sm | md | lg | xl, optional `/10` denominator; **ScoreBar** 3px magnitude bar. These replace ring dials and gradient bars.
- **Score tile** (`components/reports/DossierParts`): the one large score treatment, used only in the dossier's summary card. A `rounded-lg` tile washed with its score's ladder colour (`color-mix` of `scoreColor()` at 7%, border at 20%), the label and a one-line question on the left, the number at `text-stat` with a muted `/10` on the right, and a ten-segment meter underneath (6px pill segments on `bar-track`, filled in the ladder colour, the last one partly for decimals). Match and Ease each get a tile; never a combined one, never a ring.
- **Job facts** (`components/reports/DossierParts`): a stacked `dl`, 88px label column in `text-3`, values in `text-1`, `text-label`, one fact per line and truncated with the full text on hover.
- **Match · Ease** (`components/shared/MatchEase`): the one way to show a listing's scores. Match first, then Ease, as two `ScoreNumber`s at size md, each with a `.label` caption ("Match 8.3 · Ease 5.6"), each in its own ladder colour. Never one combined number, never Priority. Dense cells under a column header may drop the captions (`bare`) and go to size sm. A missing score shows "—". A blocked listing has no scores: its reason replaces the pair as plain `text-label text-danger`.
- **Eligibility chip** (`components/shared/EligibilityChip`): `Chip` with tone success "Eligible" (green), warning "Check first" (amber), danger "Blocked" (red). The reason goes in the tooltip or in plain `text-label text-3` beside it. A compact dot form exists for dense table cells.
- **Verdict** labels come from `tierVerdict()` only: Go, Stretch, Growth target, Solid, If pipeline thin, Skip, Blocked; `tierVerdict(v)` appends the action ("Stretch — apply with prep"), `{ short: true }` gives the label alone. A verdict has no colour of its own: `VerdictChip` is a `TierChip` coloured by the verdict's tier (`verdictTier()`: go T1; stretch, solid, thin T2; growth T3; skip, blocked T4).
- **Switch** (`ui/switch.tsx`): the control for a setting that is on or off (`role="switch"`, 28 × 16 track on `border-strong`, `action` when on, 12px knob, the knob alone transitions). A choice between named options stays a segmented control; a form field stays a checkbox. Never an On | Off segmented pair.
- **ContextMenu** (`ui/context-menu.tsx`): the secondary-click menu on Database rows, Applying cards and Reports rows, with the same actions the row popover or card shows (view report, open listing, the AI runs, then the destructive one last). Items that do not apply are left out, not dimmed; no shortcut hints inside it; Control-click opens it too. Every item also exists as a visible control, so the menu is a shortcut, never the only route.
- **ViewTabs** (shared) for sub-surfaces. **EmptyState** for "no data yet" surfaces.
- **Demo badge** (`components/layout/DemoBadge`): while the app shows the fictional demo, the sidebar slot the profile switcher normally uses holds a quiet `nav-input` row (Telescope icon in `text-nav-accent`, "Demo data · read-only" in `text-label text-nav-text`) plus one ghost action ("Use my own data" or "Set up my own search"); collapsed sidebar = icon button only. No new colours or shapes.
- **Read-only gating**: in demo mode every action that writes or spawns work stays visible but disabled (`useWriteGate()`), with the tooltip "Demo data is read-only". Never hide the action: the demo should show what the app can do.
- CSS classes for plain markup: `.input`, `.input-sm`, `.kbd`, `.th` (table header cell), `.card`, `.label`.

Every interactive element has hover, focus-visible, disabled and (where it applies) loading and active states. Icons come from `lucide-react` at 14px (buttons, headings), 13px (chips, dense rows) or 12px (inline), never hand-drawn and never emoji.

## 8. Tables and lists

A full-page table lives in a `card` on the page wash (the Database), with its filter rail beside it on the wash rather than in a bordered sidebar. Header cells use `.th` (12 / 500 / `text-3`, sentence case) on the table surface with a bottom hairline, no fill. Rows are 44–52px (52 when a row carries two text lines and a logo) with a `border-default/50` hairline between them, hover `bg-bg-elevated`, selected `bg-accent-soft`. The table fits its container; when it cannot, the first column is sticky and the rest scroll. Numbers are right-aligned and tabular. In the Database, the application status (Applied, Responded, Interview, Offer, Rejected) has its own Status column left of Match · Ease, a `StatusChip` per row with 24px of air before the scores; untouched listings leave it empty. Secondary facts (peer rank, upgrade lever, archetype) are plain `text-3` text, not chips, unless they carry a state.

- **Prose lists.** Inside `.prose-report` (reports, Messages bodies, chat replies) `ul` shows disc → circle → square markers by depth and `ol` decimals, in `text-3` so the marker recedes behind the text; GFM task lists (`.contains-task-list`) keep their own checkbox and no marker. Preflight strips list styles, so the prose class restores them; never add `list-disc` per call site.

## 8a. The Mac around the app

starpath is a macOS app, so the window's conventions are Apple's, whatever the web content inside does.

- **The menu bar carries every command.** `electron/main.ts` › `buildMenu` builds the application menu in Apple's order: starpath (About, Settings… ⌘,), File (Add Listing… ⌘N, Export Database… ⇧⌘E), Edit (the roles, Find ⌘F), View (Hide/Show Sidebar ⌃⌘S with the title following the state, the destinations as ⌘1 … ⌘9 in sidebar order, Command Palette… ⌘K, the zoom roles so text reaches 200 %), Scan (Full Scan, API Only, Filtered Scan…, Filter to Database), Window, Help (Keyboard Shortcuts ⌘/). Each item sends one `menu:command` id; `components/layout/MenuCommands.tsx` maps it onto the nav store or the command bus in `lib/appCommands.ts`, and the view that owns the action subscribes with `onAppCommand` and runs the handler its own button uses. A new page-level action gets a menu item and a command id in the same change; `lib/shortcuts.ts` › `shortcutGroups` lists it for the cheatsheet.
- **Native menu items are title-style** ("Add Listing…", "Hide Sidebar") because the system draws them beside its own menus. Everything inside the window stays sentence case (§ 3).
- **Custom shortcuts are ⌘-based.** ⌘1 … ⌘9 go to views; the g-then-letter chords remain as an extra and the cheatsheet says so. No Control-based shortcut, nothing that collides with a standard ⌘ key.
- **A button that opens a dialog or picker ends in "…"**: Add listing…, Filtered scan…, Change….
- **Secondary click opens a context menu** on rows and cards (§ 7 ContextMenu).
- **The pointer is the arrow** on buttons, rows and tabs; the hand is for links that leave the app (Open listing, report links).
- **Not yet done, and known:** a dark appearance that follows `prefers-color-scheme` (every theme is light content under a night sidebar; `nativeTheme.themeSource` is pinned dark so the title bar matches the sidebar), and Settings as its own window. Both are listed in `docs/design-review-apple-2026-10-22.md`.

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
5. Replace `text-[Npx]` with the scale in § 3; replace radii and shadows with § 4 (nothing at rest carries a shadow; overlays, menus and the sheet float). No `backdrop-blur`.
6. Replace ring dials and gradient bars with `<ScoreNumber>` / `<ScoreBar>`; replace `scoreColor` call sites that expect teal.
7. Check contrast (body ≥ 4.5:1), hover/focus/disabled on every control, truncation on long strings, and the view at 1280px wide.

## 12. Changelog

Newest first; every entry below landed on 2026-10-20 unless dated. The audit that started this is `docs/design-audit-2026-10-20.md`.

- **2026-10-22: Apple pass.** From `docs/design-review-apple-2026-10-22.md` (the HIG review) with the taste-skill app chapter read alongside: `text-4`, `tier-3`, `tier-4` and `nav-faint` lifted to 4.5:1 in every theme and the theme test now holds them there; a native menu bar with every command, ⌘1 … ⌘9, Settings… ⌘, and Hide/Show Sidebar (§ 8a); `prefers-contrast` and `prefers-reduced-transparency` blocks; blur removed from every scrim and the unused `.frosted`; resting shadows removed from cards, inputs and secondary buttons; Scout's stage row and "Needs you" list without icon tiles; a `Switch` for on/off settings and the Show unscored checkbox moved out of the title bar; secondary-click `ContextMenu` on Database rows, Applying cards and Reports rows; ellipses on dialog-opening buttons; the pointing hand kept for links only; a chart `aria-label` on Trends; the chat footer says answers can be wrong; the token-usage total ignores ledger rows whose cost cannot be a price. Kept on purpose (§ 1): the night sidebar, the cosmos and galaxy washes, the violet themes.

- **2026-10-21: Documents fact.** The dossier's job facts gain Documents, from the report's `**Documents:**` line (§ 6).
- **2026-10-21: prose list markers.** Markdown lists in `.prose-report` render with muted bullets and numbers again (§ 8).
- **Applying rework.** Applying tracks instead of nagging: next-step buttons, follow-up badges, the progress strip, the per-card Tailor / Draft / Prep icons and the inbox card are gone; a stage dropdown per card, a Rejected column with a date + stage dialog (and a pencil to correct it), a date cue (deadline, else posted, else first scan) and the report sheet opening in place. An Evaluated card can't be rejected (the move asks to discard it). The report's job facts show Posted (else First seen) and Deadline from scan-history. The Pipeline tab is removed. Trends' time chart counts listings by posting date with a strong-match split and drops the gated mean-Match line. The Database row popover wraps its chip row instead of letting the liveness chip cover the Ease number.

- **Trends rework.** Trends is one page (the Score trend sub-tab, Verdict distribution and What drives your fit are gone): top lists first, named by their axis (Top companies by Ease, Top locations by Match, Top archetypes by Ease); the score line became listings per week / month with a gated mean-Match line; Archetype mix became Archetype focus (composition bars, no scores).
- **Dossier header and summary.** Report header split into job facts (stacked, left) and a decision well (verdict, scores, actions, right); the summary card becomes two stacked score tiles beside the report's verbatim TL;DR. Database gets a Status column; Scout's action row is centred; the Add listing dialog loses its helper line and keyboard hints.
- **Demo mode.** Onboarding opens on a choice (Explore the demo / Set up my own search); the demo badge sits in the profile-switcher slot; write actions are disabled with a "Demo data is read-only" tooltip; Settings › General gains a Data row with the Show demo data switch.
- **Colour themes.** Switchable colour themes: every colour became a role token in `app/themes.css` (Blue hour default; Aurora, Star chart, Observatory, Galaxy), Settings › Appearance picker, primary buttons on their own `action` role, the sidebar on `nav-*` roles with a per-theme sky, Tailwind's default palette removed, and two guard tests (theme completeness + contrast, colour literals). Fixed in passing: `bg-accent/12` (off Tailwind's opacity scale) had silently dropped the active-nav and count-badge highlight.
- **Dossier outline.** The dossier's first card is the "Summary" outline entry; the markdown "Recommendation" section keeps its own name, so the outline never lists Verdict twice.
- **Report sheet.** Report panel becomes a 1040px `.sheet` with a lit edge, deep tinted shadow and a dimmed, blurred backdrop.
- **Dossier spacing.** More room around the dossier: header padding, taller tabs, 168px section rail, deeper body inset.
- **Scout stages.** Scout's application stages as icon tiles, Rejected set apart at the right, bars and the Evaluated tile removed.
- **Scout home.** Today merged into Scout: "Where things stand" card, action row, daily brief, Deadlines panel; `today` view id aliases `scouting`.
- **Database card.** Database table in a floating card with 52px rows; scan row as large pill buttons; Filtered scan is a picker dialog.
- **Softening pass.** Softening pass after review: radii 8/10/14/18, pill chips, lighter hairlines, no grey chrome bands, violet-tinted shadows, restyled native checkboxes and selects.
- **Design system v2.** IBM Plex, seven-step scale, sentence case, one violet ladder, primitives in `components/ui/`, every view migrated except onboarding, report dossier rebuilt, tier and city parsing fixes.
- Scoring v2 (the "Scoring system rework" session) merged on top the same day: Match · Ease, Verdict, eligibility chips, `SCHEMA_VERSION` 8; § 7 documents its components.

Open: a full visual pass once the scoring batch has refilled `data/score-history.tsv` (listings were archived for the re-score); a charts pass (Bklit radar in the dossier, heatmap, funnel) proposed as a separate session; onboarding screens untouched by request.
