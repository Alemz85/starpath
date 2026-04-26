# career-ops — design system

A foundation document. Tokens, principles, and generic component patterns. Not feature-locked — extend as decisions get made.

## Philosophy

career-ops is a daily-use data tool first, with a small expressive surface for first impressions. The aesthetic borrows from Linear and Raycast on work surfaces — dark, dense, keyboard-first — and from a deep-space register on entry surfaces.

Three principles drive everything:

- **The data is the visual interest.** Tier chips, score numerals, charts — these carry the color. Backgrounds, panels, and chrome stay quiet so the data can speak.
- **Expressive on entry, flat on work.** Galaxy gradients and decorative elements live on the dashboard hero, sidebar header, login screen, empty states, and loading shimmers. Work surfaces (tables, forms, report bodies, modals) stay flat. The two registers are bridged by a violet accent that appears as selection/hover/focus on work surfaces — galaxy DNA without compromising readability.
- **Daily durability over demo polish.** Decisions optimize for the 50th time the app opens, not the first. No effects that exhaust the eye, no colors that scream, no animations in the way.

## Color system

Dark mode is the default and only mode for v1. Light mode deferred.

### Backgrounds

| Token | Hex | Use |
|---|---|---|
| `bg-base` | `#0D0A1F` | App background, deepest layer |
| `bg-panel` | `#15102B` | Cards, table surface, modals |
| `bg-elevated` | `#1D1638` | Hover row, selected-row tint base |
| `bg-chrome` | `#1A1432` | Sidebar, table header, top bar |
| `border-default` | `#2A2342` | Dividers, card borders |
| `border-strong` | `#3D3458` | Emphasized borders, input outlines |

### Text

| Token | Hex | Use |
|---|---|---|
| `text-primary` | `#E8E6F0` | Body, headings — slight warm cast |
| `text-secondary` | `#C8C5D6` | Secondary content, metadata |
| `text-muted` | `#8A83A8` | Labels, hints, disabled |
| `text-subtle` | `#6B6680` | De-emphasized text on dim rows |

### Tier palette (metals)

The tier metaphor is podium hierarchy: gold/silver/bronze for the top three, off-podium for everything else. T4 isn't a metal — it's "filtered by default."

| Tier | Color | Hex | Chip text |
|---|---|---|---|
| T1 | Champagne gold | `#E8B547` | `#1A0F00` |
| T2 | Warm platinum | `#C8C5D6` | `#2A2342` |
| T3 | Burnished bronze | `#C77B3B` | `#1A0A00` |
| T4 | Off-podium gray | `#525252` @ 55% opacity | `#D3D1C7` |

Apply tier color to: filled chip background, score numeral, distribution-bar segments, 2px left-edge accent on rows. Never tint full row backgrounds.

### Accent

| Token | Hex | Use |
|---|---|---|
| `accent` | `#7C5CFF` | Selection, focus rings, primary buttons, active nav item, links |
| `accent-soft` | `#7C5CFF` @ 15% | Selected-row tint, input ring background |
| `accent-text` | `#B5A3FF` | Inline links in body text |

The accent is the galaxy thread on work surfaces. It only appears when the user takes an action.

### Semantic

| Token | Hex | Use |
|---|---|---|
| `success` | `#10B981` | Confirmations, applied states |
| `warning` | `#F59E0B` | Approaching deadlines, "this month" |
| `danger` | `#EF4444` | Missed deadlines, destructive actions |
| `info` | `#3B82F6` | Informational badges |

Keep semantic colors away from tier signaling. Tier encodes quality; semantic encodes state.

## Typography

### Stack

- Sans (UI, body): **Inter**, fallback `-apple-system, system-ui, sans-serif`
- Mono (numbers, identifiers): **JetBrains Mono**, fallback `ui-monospace, SF Mono, monospace`

No third typeface. No serif. No display fonts.

### Scale

| Use | Size | Weight | Line height |
|---|---|---|---|
| Page title | 22px | 500 | 1.3 |
| Section heading | 16px | 500 | 1.4 |
| Body | 13px | 400 | 1.5 |
| Table cell | 13px | 400 text / 500 numbers | 1 |
| Label / metadata | 12px | 400 | 1.4 |
| Micro-label (column headers) | 11px | 500 | 1 |

Numbers always use JetBrains Mono so columns align and decimals don't drift.

### Rules

- **Two weights only**: 400 regular, 500 medium. Never 600 or 700.
- **Sentence case** everywhere. No Title Case. ALL CAPS only for micro-labels with letter-spacing.
- **No mid-sentence bolding** in body content. Bold for headings and labels.
- **Letter-spacing**: `0.04em` on micro-labels; default elsewhere.

## Spacing & layout

### Scale

`4 / 8 / 12 / 16 / 20 / 24 / 32 / 48` (px). Component-internal gaps `8`–`12`. Section spacing `16`–`24`. Between major regions `32`+.

### Border radius

| Token | Value | Use |
|---|---|---|
| `radius-sm` | 4px | Chips, badges, tier pills |
| `radius-md` | 6px | Inputs, buttons, small cards |
| `radius-lg` | 8px | Panels, modals, slide-overs |

### Dividers

- 0.5px borders preferred over 1px. Default to `border-default`.
- No zebra striping.
- Sticky headers get a single bottom border, no shadow.

## Surface registers

### Entry surfaces

*Where:* dashboard hero band, sidebar header strip, login screen, empty states, onboarding, loading shimmers.

*Allowed:*
- Subtle radial gradients from `bg-base` toward `#1A0F3D` (warmer indigo)
- Star-pixel decoration: 1–2px white or accent dots at 30–60% opacity, sparse
- Larger violet accent moments (icon glows, gradient buttons)
- Decorative wordmark or logo treatment

*Constraint:* gradients stay contained to the band. The moment a data region begins, the canvas goes flat.

### Work surfaces

*Where:* tables, forms, report bodies, modals, command palette, settings.

*Rules:*
- Flat `bg-panel`. No gradients.
- Borders only where structure requires them.
- Color appears only on tier chips, score numbers, and accent moments (selection, focus, hover).
- High-contrast text. No colored backgrounds behind blocks of reading.

The registers connect via the **violet accent**: selection tints, focus rings, active sidebar item, link colors. That's the only place galaxy palette enters work surfaces.

## Component patterns

Generic — adapt to features as they're decided.

### Tier chip

Filled rectangle, `radius-sm`, 2px vertical / 8px horizontal padding, 11px mono. Background is the tier color, text is the matching dark variant.

### Score numeral

JetBrains Mono, 13px, weight 500. T1 scores can take the gold color; others stay `text-primary` and let the chip carry the tier signal.

### Row (table)

36px height, flat background. 6px tier-color stripe on the left edge. Hover lifts to `bg-elevated`. Selected state uses `accent-soft` background + 2px `accent` left border (replaces tier stripe). T4 rows render at 55% opacity by default.

### Card

`bg-panel` background, `border-default` border, `radius-lg`. Padding 16–20px. No shadows. Hover: border shifts to `border-strong` (no scale or transform — they cause layout shift).

### Sidebar

Full-height, collapsible. 56px collapsed (icon-only), 220px expanded. Background `bg-chrome`. Active item: `accent-soft` background, 2px `accent` left border, `text-primary` text. Inactive: transparent background, `text-muted` text.

### Command palette

Triggered by `Cmd+K`. Centered modal, ~600px wide. `bg-panel` background, `border-strong` border, `radius-lg`. Focused row: `accent-soft` background. Keyboard-first: arrows to navigate, enter to confirm, esc to dismiss.

### Slide-over panel

Right-aligned, 60% viewport width, full height. `bg-panel` background, 0.5px `border-default` left border. Esc and click-outside both dismiss. Optional expand button to go full-width.

### Buttons

- **Primary**: `accent` background, white text, `radius-md`. Hover: 90% opacity. Active: 95% scale.
- **Secondary**: transparent background, `border-default` border, `text-primary`. Hover: `bg-elevated` background.
- **Ghost**: transparent, `text-muted`. Hover: `text-primary` + `bg-elevated`.
- **Destructive**: `danger` border + text, transparent background. Confirm action required.

### Inputs

36px height, `bg-base` background (deeper than panel for inset feel), `border-default` border, 13px text. Focus: `accent` border + 2px `accent-soft` ring. No placeholder-as-label — always pair with a real label.

## Charts (Recharts)

### Tier-encoded series

When a chart encodes tier, use the metals directly. Order T1 → T2 → T3 → T4 in legends.

### Non-tier series

Stepped through indigo → violet → soft pink:
- Series 1: `#7C5CFF`
- Series 2: `#A78BFA`
- Series 3: `#D4B5FF`
- Series 4: `#E8C5E8`

Grid lines: `border-default`, dashed, 0.5px. Axis labels: `text-muted`, 11px. Tooltip: `bg-elevated` background, `border-strong` border, `radius-md`.

## Accessibility

- Contrast: `text-primary` on `bg-base` ≈ 16:1. `text-muted` on `bg-base` ≈ 5.5:1. Tier chips with their dark text variants ≥ 7:1.
- Focus visible: every interactive element shows the 2px `accent-soft` ring on focus. Don't strip default outlines without replacing them.
- Keyboard parity: every mouse action reachable by keyboard. `Cmd+K` opens the command palette. `G+letter` shortcuts navigate top-level views.
- Motion: respect `prefers-reduced-motion`. Disable star parallax, accent pulses, and slide-over animations when set.

## Tech stack notes

- **Electron + Next.js**: app shell + renderer. SSR not used — everything client-rendered for local-first.
- **Tailwind**: configure tokens above as theme extensions. Map colors to semantic names (`bg-panel`, not `bg-[#15102B]`) so utility classes stay readable.
- **shadcn/ui**: customize the New York variant with the token map. Override `--background`, `--foreground`, `--primary`, `--accent` in CSS variables.
- **TanStack Table**: column visibility toggle, sticky header, sortable columns, virtualized rows for large datasets.
- **Recharts**: centralize series colors and theme tokens in one config file; reference from every chart.

## Open questions

- Light mode: deferred. Add only if a user requests.
- Animation budget: default to instant for triage actions, 150–200ms for surface transitions.
- Logo / wordmark treatment: TBD.
- Iconography: `lucide-react` likely fits — evaluate against the galaxy register, custom variants may be needed for brand moments.
- Distribution model: personal vs. small-circle share. If shared more widely, revisit accessibility audit and onboarding surface treatments.
