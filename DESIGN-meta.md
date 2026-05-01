# Design System Inspired by Meta (Store)

## 1. Visual Theme & Atmosphere

The Meta Store is a product-forward retail experience built to sell hardware — Quest VR headsets, Ray-Ban Meta smart glasses, and accessories. The design walks a tightrope between consumer electronics showroom and lifestyle editorial, deploying cinematic product photography against expansive white canvas to create a gallery-like sense of aspiration. Every design decision serves the merchandise: generous negative space frames hero product shots like museum pieces, while alternating light and dark surface sections create a visual rhythm that mimics the experience of walking through a physical retail space.

The "Dolly" design system (Meta's internal name for the store layer) sits atop the broader FDS (Facebook Design System) foundation, inheriting its gray scale and semantic tokens while overlaying its own product-focused palette. The result is a system that feels distinctly Meta — the custom Optimistic typeface brings warmth and approachability to what could otherwise be cold tech retail — yet flexible enough to showcase wildly different product lines (from VR headsets to fashion eyewear) without feeling disjointed. The surface strategy is binary: pure white for browsing and information, rich dark for immersive product moments.

The store's visual hierarchy is ruthlessly simple. Photography does the heavy lifting, supported by short, punchy headlines in Optimistic Medium and body text that stays brief and scannable. Calls to action are pill-shaped, unmistakable, and always Galaxy Violet. There is no visual noise, no decoration for decoration's sake — every element either sells or navigates.

**Key Characteristics:**
- Photography-first retail design where products are the visual heroes, not UI
- Binary surface strategy: pure white for information, deep galaxy navy for immersive product moments
- Pill-shaped CTAs in saturated galaxy violet create unmistakable action points
- Optimistic VF typeface with OpenType ss01/ss02 features brings geometric warmth
- Generous whitespace frames products like gallery exhibits
- 8px spacing grid with disciplined vertical rhythm
- Alternating light/dark sections create a "walkthrough" retail cadence

## 1.5 Register, color strategy, motion principles

**Register:** product. The desktop app is a power-user tool — the user spends hours in it making decisions. Design serves the work. Familiarity is a virtue (Linear / Stripe / Things 3 / Raycast as benchmarks); strangeness without purpose is the failure mode. One display moment per primary view; everything else stays in the dense workhorse scale.

**Color strategy:** Restrained. Tinted neutrals + one saturated accent (galaxy violet) ≤10% of the surface. The accent reads as action; semantic tokens (success / warning / danger) read as state. The chart palette (`chart-1`…`chart-7`) is its own categorical track, isolated to multi-series data viz. Tier and status scales never collapse into the chart track and vice versa.

**Theme:** light. Physical scene — a job seeker reviewing AI-generated offer evaluations on a 14" laptop in a quiet evening home office, sometimes for hours, deciding which of 200 listings deserves an application. That sustained-reading scene calls for light surfaces. The two dark moments are intentional — the OnboardingGate immersive (brand reveal) and the ActivityPanel matte body (live AI streaming, terminal feel).

**Motion:** every transition lands at 150–250 ms with `cubic-bezier(0.25, 1, 0.5, 1)` (ease-out-quart, the `ease-quart` Tailwind token). Motion conveys state (load, hover, selection, expansion) — never decoration. No orchestrated mount sequences; no comet trails on every primary CTA; no auto-playing animations. The persistent atmospherics live in two places only — the universal `cosmos-grain` overlay and the opt-in `galaxy-stars` decoration on dark idle surfaces.

## 2. Color Palette & Roles

### Primary

- **Galaxy Violet** (`#7C5CFF`): Primary CTA background, interactive links, action-driving elements throughout the app (`--accent`, Tailwind token `accent`)
- **Galaxy Violet Hover** (`#5B3FE8`): Darkened violet for hover states on primary buttons (`--accent-hover`, token `accent-hover`)
- **Galaxy Violet Pressed** (`#4A2FC8`): Deepest violet for active/pressed button states (`--accent-press`, token `accent-press`)
- **Galaxy Violet Light** (`#B5A3FF`): Lighter violet variant used on dark backgrounds for CTAs and hover halos (`--accent-light`, token `accent-light`)
- **Galaxy Violet Soft** (`rgba(124,92,255,0.12)`): Translucent violet wash for active-nav fill, hover tints, focus rings (token `accent-soft`)

### Secondary & Accent — Tier and Status

The product-line accents are replaced by the **tier scale** (evaluation strength) and **status scale** (application lifecycle). Both ladder off the galaxy violet primary so the system reads as one palette.

**Tier scale** — galaxy violet gradient. T1 deep indigo for the strongest matches; T4 fades to slate so the worst rows recede. Used for tier chips (badge + matching `tier-N-bg` surface):

- **Tier 1 / Deep Galaxy Indigo** (`#3D2BB5`): Strongest evaluation match. Token `tier-1`. Surface: `tier-1-bg #EFEAFF`.
- **Tier 2 / Galaxy Violet** (`#7C5CFF`): Strong match (matches the primary accent). Token `tier-2`. Surface: `tier-2-bg #F1ECFF`.
- **Tier 3 / Muted Lavender** (`#A89CD9`): Softer match. Token `tier-3`. Surface: `tier-3-bg #F4F1FA`.
- **Tier 4 / Faded Slate** (`#94A3B8`): Weak/skip — barely there. Token `tier-4`.

**Score scale** — continuous score colors (Database dial, Trends top-X, slide-over rollups, Reports list) DIVERGE from the tier scale. Tier chips have chip-context (label + matching `-bg`) that grounds the lavender; floating score numbers don't, so they use a 5-band gradient calibrated to the score-interpretation ladder in `modes/_shared.md`. Aurora teal at the top is the only non-violet hue — it earns its slot because (a) it's the documented "cool counterpart" of galaxy violet so it stays in the cosmic family, (b) it breaks the all-violet monotone exactly where it's rare and deserved, and (c) teal reads as "premium / exceptional" without crossing into warm "warning" hues. See `frontend/src/lib/tier.ts → scoreColor` for the implementation.

- **≥ 9.0 / Aurora Teal** (`#2EB8A8`, chart-3 hue): Strong match — "stellar" tier; rare and earned.
- **≥ 8.0 / Deep Galaxy Indigo** (`#3D2BB5`): Good match; salient brand-deep.
- **≥ 7.0 / Galaxy Violet** (`#7C5CFF`): Decent match; brand anchor at the apply threshold.
- **≥ 5.0 / Slate Gray** (`#5D6C7B`, text-3): Below the apply threshold — reads as "data, not hierarchy".
- **< 5.0 / Faded Slate** (`#94A3B8`, T4 base): Sub-floor; fully receded.

**Status scale** — semantic colors mapped to the application lifecycle (see `STATUS_COLORS` in `frontend/src/types/index.ts`):

- **Evaluated** → Galaxy Violet (`#7C5CFF`, info/accent shared token)
- **Applied / Responded** → Galaxy Violet (`#7C5CFF`)
- **Interview** → Warning amber (`#F7B928`)
- **Offer** → Success green (`#007D1E`)
- **Rejected** → Error red (`#C80A28`)
- **Discarded / SKIP** → Muted text (`#8595A4`)

### Surface & Background

- **White** (`#FFFFFF`): Card / popover / nav-bar surfaces (token `bg-base`)
- **Cosmos Wash** (`oklch(0.99 0.004 285)`): App-shell page surface — a barely-perceptible OKLCH violet bleed so cards and chrome feel like they're floating in galaxy space rather than sitting on raw white (token `bg-cosmos`). Pair with the `cosmos-grain` overlay (see § Decorative Depth) for the full atmospheric base.
- **Soft Gray** (`#F1F4F7`): Secondary background for content sections (`--dolly-bg-grey`, token `bg-panel`)
- **Warm Gray** (`#F7F8FA`): Flat card background, subtle surface differentiation (token `bg-elevated`)
- **Web Wash** (`#F0F2F5`): Deemphasized background areas, sidebar/topbar chrome (token `bg-chrome`)
- **Galaxy Deep** (`#0A0820`): Immersive splash background — onboarding, brand reveal (`--galaxy-deep`, token `galaxy-deep`)
- **Galaxy Matte** (`#1F1B36`): Activity panel body — matte/pastel dark surface (`--galaxy-matte`, token `galaxy-matte`)
- **Galaxy Matte 2** (`#2A2548`): Activity panel header — slightly lighter matte (`--galaxy-matte-2`, token `galaxy-matte-2`)
- **Overlay** (`rgba(0, 0, 0, 0.6)`): Modal/lightbox backdrop

### Neutrals & Text

- **Primary Text** (`#050505`): Main headings, max-contrast labels (token `text-1`)
- **Dark Charcoal** (`#1C2B33`): Body and default heading text (`--dolly-text-primary`, token `text-2`)
- **Slate Gray** (`#5D6C7B`): Supporting copy, secondary labels, placeholder hints (`--dolly-text-secondary`, token `text-3`)
- **Muted Slate** (`#8595A4`): Disabled labels, tertiary metadata, retired statuses (token `text-4`)
- **Divider Gray** (`#DEE3E9`): Default content separators, card borders (`--divider-gray`, token `border-default`)
- **Strong Divider** (`#CED0D4`): Stronger outline — input borders, scrollbar thumbs (token `border-strong`)
- **Hover Slate** (`#909396`): Stronger outline on hover for scrollbars and outline elements

### Semantic & Accent

- **Success Green** (`#007D1E`): Offer status, positive indicators, success badges (token `success`)
- **Warning Amber** (`#F7B928`): Interview status, attention badges (token `warning`)
- **Error Red** (`#C80A28`): Rejected status, critical badges, destructive actions (token `danger`)
- **Info Violet** (`#7C5CFF`): Evaluated status, informational hints — aliased to the primary accent so info reads as part of the brand (token `info`)
- **Positive BG** (`rgba(0, 125, 30, 0.12)`): Subtle success background tint
- **Error BG** (`rgba(200, 10, 40, 0.12)`): Subtle error background tint
- **Warning BG** (`rgba(247, 185, 40, 0.15)`): Subtle warning background tint
- **Info BG** (`rgba(124, 92, 255, 0.12)`): Subtle informational violet tint (matches `accent-soft`)

### Data Viz palette — categorical chart series

Multi-series charts (TrendsView dimension lines, future radar/spider, breakdown panels) need 5–7 distinguishable hues without collapsing into one violet ladder. The palette is "aurora-tuned": galaxy violet anchors the brand series, then cool and warm cousins fan out so adjacent lines never read as the same color. These tokens are reserved for **categorical data series only** — they don't replace tier or status semantics, and they don't get used for chrome.

| Token | Hex | Role |
|-------|-----|------|
| `chart-1` | `#7C5CFF` | Galaxy violet — anchor / Overall (matches `accent`) |
| `chart-2` | `#3D2BB5` | Deep galaxy indigo — strongest fit dimension (matches `tier-1`) |
| `chart-3` | `#2EB8A8` | Aurora teal — cool counterpart |
| `chart-4` | `#E84F8E` | Nebula pink — warm counterpart (distinct from the magenta in `.galaxy-text`) |
| `chart-5` | `#F2A837` | Cosmic amber — warm tertiary (distinct from `warning #F7B928`) |
| `chart-6` | `#4D8DFF` | Azure — cool tertiary |
| `chart-7` | `#8595A4` | Slate — neutral / "muted by intent" series |

Use `chart-1` first (the anchor), then alternate warm/cool/warm/cool when adding series so neighbours contrast. Don't reach for `accent`, `tier-*`, or `success/warning/danger` for chart series — they carry semantics that conflict with arbitrary categorical use. The chart palette stays separate so a status stays semantic and a series stays categorical.

### Gradient System

- **Brand Wordmark Gradient** (`linear-gradient(135deg, #5B3FE8 0%, #7C5CFF 50%, #A121CE 100%)`): Used by `.galaxy-text` to clip-fill the "starpath" wordmark — three-stop violet running into a magenta highlight.
- **Galaxy Ambient Wash** (`.galaxy-bg`): Layered radial gradients — `radial-gradient(ellipse at 78% 18%, rgba(124, 92, 255, 0.06)…)` + `radial-gradient(ellipse at 22% 88%, rgba(124, 92, 255, 0.07)…)` + `radial-gradient(ellipse at 50% 50%, rgba(161, 33, 206, 0.025)…)` over `#FFFFFF`. Used on hero/empty-state cards.
- **Galaxy Immersive Wash** (`.galaxy-immersive`): Same recipe at higher opacity over `#0A0820` — onboarding splash, brand reveal moments.
- **Galaxy Border** (`.galaxy-border`): `linear-gradient(135deg, rgba(124,92,255,0.4), rgba(91,63,232,0.4), rgba(161,33,206,0.4))` border-box on top of a white padding-box — used for empty-state cards that want the brand glow without a fill change.
- **Dark Overlay Gradient**: `linear-gradient(rgba(0,0,0,0), rgba(0,0,0,0.6))` — applied over dark photography for text legibility.
- **Shadow Alpha Scale**: 0.04, 0.06, 0.08, 0.10, 0.15, 0.20, 0.30 — softer than Meta's because the palette is lower-contrast; black alpha ramps for layered transparency.

## 3. Typography Rules

### Font Family

**Primary:** Optimistic VF (variable font by Dalton Maag, commissioned by Meta)
- Fallbacks: Montserrat, Helvetica, Arial, Noto Sans
- OpenType features: `"ss01", "ss02"` — stylistic sets that activate Meta-specific alternate glyphs
- Variable font with continuous weight axis (observed: 300, 400, 500, 700)

**Secondary:** Helvetica
- Fallbacks: Arial
- Used for small utility text (12px footer links, legal copy)

### Hierarchy

| Role | Size | Weight | Line Height | Letter Spacing | Notes |
|------|------|--------|-------------|----------------|-------|
| Display 1 | 64px | 500 (Medium) | 1.16 | — | Hero headlines on desktop, ss01+ss02 |
| Display 2 | 48px | 500 (Medium) | 1.17 | — | Section heroes, product titles |
| Heading 1 | 36px | 500 (Medium) | 1.28 | — | Major section headings |
| Heading 2 | 28px | 300 (Light) | 1.21 | — | Subheadings, lighter feel |
| Heading 3 | 18px | 700 (Bold) | 1.44 | — | Card titles, bold callouts, ss01+ss02 |
| Body | 18px | 400 (Regular) | 1.44 | — | Product descriptions, body copy |
| Body Compact | 16px | 500 (Medium) | 1.50 | -0.16px | Navigation links, UI labels |
| Caption Bold | 14px | 700 (Bold) | 1.43 | — | Emphasized labels, price text |
| Caption | 14px | 400 (Regular) | 1.43 | -0.14px | Secondary labels, metadata |
| Small | 12px | 400 (Regular) | 1.33 | — | Footer links, legal text, timestamps |
| Button | 14px | 400 (Regular) | 1.43 | -0.14px | Button label text |

### Principles

Optimistic VF is the cornerstone of Meta's typographic identity — a humanist sans-serif with geometric underpinnings that strikes a balance between Silicon Valley precision and consumer warmth. The "ss01" and "ss02" stylistic sets introduce alternate glyphs that give headlines a distinctive Meta character. Weight 500 (Medium) dominates headlines, creating a presence that commands without shouting, while the unexpected use of weight 300 (Light) at 28px adds an airy, editorial quality to subheadings. Negative letter-spacing at smaller sizes (-0.14px to -0.16px) tightens the optical rhythm for UI elements, keeping the reading experience crisp and efficient.

### Tailwind tokens for the display scale

The app is a power-user product (register: product). Per the product doctrine, display fonts are reserved for one-off "moments," not pages — every surface beyond the entry hero stays on the dense `text-page` and below scale. A single display token (`text-display-2`, capped at 36px) covers the editorial hero on Scouting and Applying.

| Tailwind class | Maps to | Use |
|----------------|---------|-----|
| `text-display-2` | 36px / 500 / 1.12 / -0.02em tracking | The **one** hero moment per primary view. Title only — never apply to subheads, labels, or data |
| `text-page`      | 22px / 500 / 1.28 | Title-bar headings, page titles in dense views (Trends, Reports, Database) |
| `text-section`   | 16px / 500 / -0.16px tracking | Subheads, hero summary prose, section headers |
| `text-body`      | 13px / 400 / 1.5 | Default body, table cells |
| `text-label`     | 12px / 400 / -0.14px | Form labels, secondary metadata |
| `text-micro`     | 11px / 600 uppercase / 0.06em tracking | Eyebrow tags, axis labels |

## 4. Component Stylings

### Buttons

**Primary (Pill)**
- Background: Galaxy Violet (`#7C5CFF`)
- Text: White (`#FFFFFF`)
- Border: none
- Border radius: fully rounded pill (100px)
- Padding: 10px 22px
- Font: Optimistic VF, 14px, 500 (Medium), -0.14px tracking
- Shadow: `0 1px 2px rgba(76, 47, 200, 0.15)` resting
- Hover: darkens to `#5B3FE8`, shadow lifts to `0 4px 12px rgba(124, 92, 255, 0.35)`
- Pressed: `#4A2FC8`, scale(0.98)
- Disabled: `#DEE3E9` background, `#8595A4` text, no shadow, cursor not-allowed
- Focus: 1px violet ring `rgba(124, 92, 255, 0.45)` (no offset)
- Transition: background 200ms ease, transform 150ms ease, box-shadow 200ms ease

**Secondary (Outlined Pill)**
- Background: transparent
- Text: Dark Charcoal (`#1C2B33`)
- Border: 2px solid `rgba(10, 19, 23, 0.12)`
- Border radius: fully rounded pill (100px)
- Padding: 10px 22px
- Hover: background shifts to `rgba(70, 90, 105, 0.08)`

**Ghost/Link Button**
- Background: transparent
- Text: Galaxy Violet (`#7C5CFF`)
- Border radius: 24px
- Padding: 4px 12px

**Disabled**
- Background: `#DEE3E9` (Divider Gray)
- Text: `#8595A4` (Muted Slate)
- Cursor: not-allowed, no hover effects

### Cards & Containers

- Background: White (`#FFFFFF`) or Warm Gray (`#F7F8FA`)
- Corner radius: 20px (`--card-corner-radius`) for standard cards, 24px for product feature cards
- Padding: 10px horizontal, 20px vertical
- Shadow: `0 12px 28px 0 rgba(0,0,0,0.08), 0 2px 4px 0 rgba(0,0,0,0.04)` (`shadow-card` token)
- Lift shadow: `0 16px 32px 0 rgba(0,0,0,0.10), 0 2px 6px 0 rgba(0,0,0,0.05)` (`shadow-lift` token)
- Subtle shadow: `0 2px 4px 0 rgba(0,0,0,0.06)` (`shadow-subtle` token)
- Hover: subtle lift via translateY(-2px) and shadow intensification
- Transition: transform 300ms ease, box-shadow 300ms ease
- Product cards use full-bleed imagery with text overlay on dark gradient

### Inputs & Forms

- Background: White (`#FFFFFF`)
- Border: 1px solid `#CED0D4` (`border-strong`)
- Border radius: 8px
- Font: Optimistic VF, 16px
- Focus: border color shifts to Galaxy Violet `#7C5CFF`, 1px outer ring `rgba(124, 92, 255, 0.45)`
- Error: border and label color `#C80A28`
- Placeholder: `#5D6C7B` (`text-3`)
- Transition: border-color 200ms ease, box-shadow 200ms ease

### Navigation

- Background: White (`#FFFFFF`) or Web Wash (`#F0F2F5` for sidebar chrome), sticky at top
- Frosted glass effect: `rgba(241, 244, 247, 0.8)` with backdrop-filter blur (`.frosted` utility)
- Logo: `<StarpathLogo />` SVG paired with the galaxy-violet wordmark, left-aligned
- Links: Optimistic VF, 13px (`text-body`), Dark Charcoal (`#1C2B33`)
- Active item: `bg-accent/15` galaxy-violet wash + `text-text-1` + `font-medium` weight bump. **No side-stripe rail** — colored borders >1px on a list item are decorative noise; the background tint plus weight contrast is enough.
- Hover: `text-text-2` + `bg-bg-elevated`
- CTA: Galaxy Violet pill button, right-aligned
- Mobile: hamburger collapse, full-screen overlay nav
- Height: approximately 56px desktop, 48px mobile
- Border-bottom: subtle `#DEE3E9` separator (`border-default`)

### Image Treatment

- Product hero: full-width, cinematic aspect ratio (~21:9 on desktop, ~4:3 on mobile)
- Product cards: 1:1 or 4:3, edge-to-edge within card radius
- Feature images: rounded corners matching card radius (20-24px)
- Dark text-over-image: gradient overlay `linear-gradient(rgba(0,0,0,0), rgba(0,0,0,0.6))`
- Lazy loading: native loading="lazy" on below-fold images
- WebP format with JPEG fallback

### Tier and Status Sections

The Meta Store's product-line sections (Quest dark, Ray-Ban warm-lifestyle, Portal teal-blue) are replaced by **tier and status sections** in the career-ops UI:

- **Tier 1 sections** (top recommendations): white surface, deep indigo accents (`#3D2BB5`), `tier-1-bg #EFEAFF` chip washes, galaxy-violet CTAs.
- **Tier 2 / Tier 2-high sections**: standard white surface, galaxy-violet accents (`#7C5CFF`).
- **Tier 3 / Tier 4 sections**: white surface, muted lavender / faded slate accents — visually recede so the eye lands on higher-tier rows.
- **Galaxy immersive moments** (onboarding splash, brand reveal): `.galaxy-immersive` background (`#0A0820` base with violet + magenta radial washes), white text, galaxy-violet CTAs.
- **Activity panel**: `galaxy-matte #1F1B36` body with `galaxy-matte-2 #2A2548` header — for live spawn/log streaming where the streaming text needs a calm dark surface.

## 5. Layout Principles

### Spacing System

Base unit: 8px

| Token | Value | Use |
|-------|-------|-----|
| space-1 | 1px | Hairline borders |
| space-2 | 4px | Tight internal padding |
| space-3 | 8px | Base unit, icon gaps |
| space-4 | 10px | Card horizontal padding |
| space-5 | 12px | Button icon spacing, tight margins |
| space-6 | 14px | Caption line height spacing |
| space-7 | 16px | Standard paragraph spacing, nav padding |
| space-8 | 18px | Body text vertical rhythm |
| space-9 | 24px | Card section spacing, grid gaps |
| space-10 | 32px | Section content padding |
| space-11 | 40px | Major content block spacing |
| space-12 | 48px | Section vertical padding (compact) |
| space-13 | 64px | Section vertical padding (standard) |
| space-14 | 80px | Hero section padding, large section gaps |

### Grid & Container

- Max container width: ~1440px, centered with auto margins
- Product grid: 3-column on desktop, 2-column on tablet, 1-column on mobile
- Feature grid: 2-column split (image + content), stacks on mobile
- Grid gap: 24px between cards, 16px on mobile
- Page horizontal padding: 24-40px depending on breakpoint

### Whitespace Philosophy

Whitespace is the store's primary luxury signifier. Sections breathe with 64-80px vertical padding, creating a sense of unhurried browsing. Product images float in generous negative space rather than being crammed edge-to-edge. This restrained spacing communicates premium positioning — the visual equivalent of wide aisles in a high-end retail store.

### Border Radius Scale

| Value | Context |
|-------|---------|
| 8px | Inputs, small UI elements, glimmer placeholders |
| 12px | Mid containers, code blocks, table radius |
| 20px | Cards (`--card-corner-radius`) |
| 24px | Feature cards, product highlight areas, ghost buttons |
| 100px | Pill buttons, tags, badges (fully rounded) |

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Flat | No shadow, background differentiation only | Default cards, sections |
| Level 1 | `0 2px 4px 0 rgba(0,0,0,0.06)` (`shadow-subtle`) | Subtle lift for interactive cards |
| Level 2 | `0 12px 28px 0 rgba(0,0,0,0.08), 0 2px 4px 0 rgba(0,0,0,0.04)` (`shadow-card`) | Elevated cards, dropdowns |
| Lift | `0 16px 32px 0 rgba(0,0,0,0.10), 0 2px 6px 0 rgba(0,0,0,0.05)` (`shadow-lift`) | Raised feature cards on hover |
| Overlay | `rgba(0,0,0,0.6)` full-screen | Modal/lightbox backdrop |
| Inset | `rgba(255,255,255,0.5)` inset | Inner glow on glass-effect surfaces |

The Meta Store favors a primarily flat elevation model. Most surface differentiation comes from background color shifts (white → soft gray → galaxy navy) rather than shadows. When shadows appear, they are soft, diffused, and use the dual-shadow pattern (a large blurred shadow for ambient light + a small sharp shadow for direct light). This creates a physically plausible depth feel without heavy visual weight. Note the alphas are softer than Meta's reference values — the lower-contrast galaxy palette doesn't tolerate Meta's 0.20 ambient shadow.

### Decorative Depth

- **Frosted glass nav**: `rgba(241, 244, 247, 0.8)` background with backdrop-filter blur, creating a translucent navigation bar (`.frosted`).
- **Active-nav running halo**: `0 0 0 4px rgba(124, 92, 255, 0.20), 0 0 12px 4px rgba(124, 92, 255, 0.30)` — emitted around the Activity sidebar icon when a spawn is running, paired with an `animate-pulse` class.
- **Dark section gradient**: `linear-gradient(rgba(0,0,0,0), rgba(0,0,0,0.6))` overlay on product photography for text legibility.
- **Glimmer loading states**: Shimmer animation over `#F1F4F7` → `#E4E8EC` → `#F1F4F7` gradient, 1500ms infinite — used for skeleton screens (`.shimmer` utility).
- **Cosmos grain overlay** (`.cosmos-grain`): Fixed-position, full-viewport SVG noise at 2.5% opacity tinted to galaxy violet. Mounted once in the AppShell so every screen carries the same subliminal texture — keeps `bg-cosmos` from reading as a flat tinted background. `pointer-events: none`, never attached to a scroll container (per perf guardrails).
- **Twinkling starfield** (`.galaxy-stars`): Opt-in decoration for **dark surfaces only** — `galaxy-immersive`, `galaxy-matte`, `galaxy-deep`. Two tiled radial-gradient layers (slow 7s + fast 4.2s with `cubic-bezier(0.25, 1, 0.5, 1)`) animate opacity for delicate parallax twinkle. Stars are intentionally small and quiet — the surface is the hero, not the decoration. Host element must be `position: relative` and `overflow: hidden`. Honors `prefers-reduced-motion`. **Don't use over light surfaces** — stars vanish on white.
- **Galaxy-tinted shadows** (`shadow-cosmos`, `shadow-cosmos-lift`): Ambient + direct shadow pair on the violet hue axis instead of pure black. Used on hero cards (Scouting / Applying / Profile editorial heroes) so cast shadow inherits the brand temperature rather than reading as generic black drop.

## 7. Do's and Don'ts

### Do

- Use pill-shaped (100px radius) buttons for all primary and secondary CTAs
- Let product photography dominate — make images the visual hero of every section
- Alternate between light (white / soft gray) and dark (galaxy navy) surface sections to create visual rhythm
- Use Optimistic VF with ss01 and ss02 features for all display text
- Keep body copy brief and scannable — this is retail, not editorial
- Use the dual-shadow pattern (ambient + direct) when elevation is needed
- Apply Galaxy Violet (`#7C5CFF`) exclusively for actionable elements
- Use generous whitespace (64-80px section padding) to convey premium feel
- Apply gradient overlays on dark photography when placing text over images
- Use the semantic color tokens (success `#007D1E`, warning `#F7B928`, danger `#C80A28`, info `#7C5CFF`) consistently for status communication
- Use the tier scale (`tier-1` → `tier-4`) for evaluation strength — never reach for an arbitrary new color when a tier already exists

### Don't

- Don't use sharp corners (< 8px radius) — the system is all smooth curves
- Don't mix tier accents within the same section (a Tier 1 card and a Tier 4 card shouldn't both be highlighted; let the lower tier recede)
- Don't add decorative borders or ornamental dividers — dividers are functional only
- Don't place important text directly on photography without a gradient scrim
- Don't use weight 300 for anything smaller than 28px — it becomes too thin
- Don't introduce a second blue/violet for CTAs — Galaxy Violet (`#7C5CFF`) is the only primary action color. If you need an alternate emphasis, drop to the secondary outlined pill rather than picking a new hue.
- Don't crowd product images — maintain generous padding around all photography
- Don't use more than 2 levels of text hierarchy in a single card
- Don't add drop shadows to cards in galaxy/dark sections — rely on `border-default` and color separation
- Don't use long paragraphs — limit to 2-3 lines of body copy per block
- Don't reach for a magenta or pink accent on top of the gradient wordmark — `#A121CE` exists only inside `.galaxy-text` and `.galaxy-bg/.galaxy-immersive` washes; don't promote it to a standalone token

## 8. Responsive Behavior

### Breakpoints

| Name | Width | Key Changes |
|------|-------|-------------|
| Mobile | <768px | Single column, hamburger nav, hero text shrinks to 36px, full-width product cards, 48px section padding |
| Tablet | 768-1024px | 2-column product grid, compact nav, hero text at 48px |
| Desktop | 1024-1440px | 3-column product grid, full horizontal nav, hero text at 64px, 80px section padding |
| Large Desktop | >1440px | Max-width container (1440px) centered, increased horizontal margins |

### Touch Targets

- Minimum touch target: 44x44px (WCAG AAA compliant)
- Mobile button height: minimum 44px with 10px vertical padding
- Nav hamburger icon: 48x48px touch area
- Product card tappable area: full card surface

### Collapsing Strategy

- **Navigation**: Horizontal links collapse to hamburger menu below 768px; CTA button remains visible
- **Product grids**: 3-col → 2-col at 1024px → 1-col at 768px
- **Hero sections**: Display text scales from 64px → 48px → 36px; CTA buttons stack vertically on mobile
- **Feature sections**: 2-column (image + text) → full-width stacked below 768px, image on top
- **Section padding**: 80px → 64px → 48px → 32px as viewport narrows
- **Card radius**: Remains consistent at 20-24px across all breakpoints

### Image Behavior

- Responsive images via srcset with multiple resolutions
- WebP format with progressive JPEG fallback
- Hero images: full-bleed on mobile, contained on desktop
- Product grid images: maintain aspect ratio, scale proportionally
- Art direction: hero crop changes between desktop (wide cinematic) and mobile (tighter product focus)
- Lazy loading with glimmer skeleton (pulsating gray placeholder) during load

## 9. Agent Prompt Guide

### Quick Color Reference

- Primary CTA / accent: Galaxy Violet (`#7C5CFF`)
- Background: White (`#FFFFFF`)
- Heading text: Primary Text (`#050505`)
- Body text: Dark Charcoal (`#1C2B33`)
- Secondary text: Slate Gray (`#5D6C7B`)
- Muted/disabled text: Muted Slate (`#8595A4`)
- Border/divider: Divider Gray (`#DEE3E9`); strong: Strong Divider (`#CED0D4`)
- Secondary surface: Soft Gray (`#F1F4F7`); elevated: Warm Gray (`#F7F8FA`); chrome: Web Wash (`#F0F2F5`)
- Dark immersive sections: Galaxy Deep (`#0A0820`); matte panels: Galaxy Matte (`#1F1B36`)
- Tier scale: T1 `#3D2BB5` → T2 `#7C5CFF` → T3 `#A89CD9` → T4 `#94A3B8`
- Status: success `#007D1E`, warning `#F7B928`, danger `#C80A28`, info `#7C5CFF`
- Chart series (categorical only): `chart-1` `#7C5CFF` · `chart-2` `#3D2BB5` · `chart-3` `#2EB8A8` · `chart-4` `#E84F8E` · `chart-5` `#F2A837` · `chart-6` `#4D8DFF` · `chart-7` `#8595A4`
- App shell wash: `bg-cosmos` `oklch(0.99 0.004 285)` — never raw `#FFFFFF` for the page; cards still use `bg-base`

### Example Component Prompts

- "Create a product hero section with a full-width cinematic image, `linear-gradient(rgba(0,0,0,0), rgba(0,0,0,0.6))` text overlay, Optimistic-style 64px/500 white headline, and a Galaxy Violet (`#7C5CFF`) pill button (100px radius, 10px 22px padding, hover `#5B3FE8`)"
- "Design a 3-column product card grid with 20px rounded corners, white backgrounds, edge-to-edge product images at top, 18px/400 body text in Slate Gray (`#5D6C7B`), and 24px grid gap"
- "Build a sticky navigation bar with white background, `rgba(241, 244, 247, 0.8)` frosted glass effect (`.frosted` utility), 13px/500 dark text links, an active-state `bg-accent/15` wash with `font-medium` weight bump (no border rail), and a right-aligned Galaxy Violet pill CTA"
- "Create a galaxy-immersive section with `#0A0820` background plus violet-and-magenta radial washes (the `.galaxy-immersive` recipe), white 48px/500 headline, `#5D6C7B` body text, and a secondary outlined pill button with `rgba(10, 19, 23, 0.12)` border"
- "Design a tier comparison grid with Soft Gray (`#F1F4F7`) background, 24px rounded cards, tier-coloured chips (`tier-1 #3D2BB5`, `tier-2 #7C5CFF`, `tier-3 #A89CD9`, `tier-4 #94A3B8`), and 14px/700 bold labels"

### Iteration Guide

When refining existing screens generated with this design system:
1. Focus on ONE component at a time
2. Reference specific color names and hex codes from this document
3. Use natural language descriptions, not CSS values — "pill-shaped Galaxy Violet button" not "border-radius: 100px; background: #7C5CFF"
4. Describe the desired "feel" alongside specific measurements — "generous whitespace like a gallery" means 64-80px section padding
5. For dark sections, specify which immersive context (Galaxy Deep `#0A0820` for splash/onboarding, Galaxy Matte `#1F1B36` for activity panel body, Galaxy Matte 2 `#2A2548` for activity panel header)
6. Always specify the Optimistic VF weight explicitly (300, 400, 500, or 700) — each creates a dramatically different feel
7. When picking a tier color, name the tier — "Tier 1 indigo" reads better than "deep violet" because it carries the semantic
