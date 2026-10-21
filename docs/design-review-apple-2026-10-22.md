# Design review: starpath against Apple's Human Interface Guidelines

Date: 2026-10-22. Reviewer: the `apple-design` skill run (dickwu/apple-design-skill v2026-10-15, which mirrors 124 HIG pages from developer.apple.com) over the desktop app at commit `5ea2c39`.

Platform: macOS only, Electron 29, React 18 + Tailwind (web-rendered UI, not AppKit). Category: a personal job-search console used in long sessions by one person. Artifact: 24 screenshots of the running app at 1470 × 922 CSS px in the default Blue hour theme, taken over the Chrome DevTools Protocol, plus the source under `frontend/`. Contrast figures below are computed from the token values in `frontend/src/app/themes.css`, not estimated from pixels. Screenshots contain personal data and stay out of the repo.

Citations are `file.md › Heading` into `references/hig/` of the skill, with Apple's words in quotes. A finding with no citation is the reviewer's judgment and says so.

## Summary

starpath is a quiet operating console with one bold thing: the night-sky sidebar and the violet-to-slate score ladder that carries every number. The thesis holds across every view; the chrome is neutral, the primary action is near-black and alone, numbers are tabular, labels are sentence case without exception. Overall rating: **Critical issues**, for one reason only: two text colours that carry real content sit below Apple's contrast floor. Fix those and the rating is **Good**: the remaining findings are platform conventions a web-rendered app has not adopted yet (no application menu, no dark appearance, no context menus) and a handful of medium polish items.

## Critical

- **Tertiary text and the faded score tier are below 4.5:1.** `text-4` is rgb(133 145 166): 3.18:1 on white cards, 2.97:1 on the page wash, 2.70:1 on panels. It is used 218 times in components for hints, dates, denominators and footnotes, text people read. `tier-4` is rgb(167 177 192): 2.17:1 on white, and `scoreColor()` paints every Match or Ease below 5.0 in it, so a real score of 3.2 is drawn at 2.17:1. `nav-faint` is 3.72:1 on the sidebar. `tier-3` (3.36:1 on white) passes only where the number is bold and 14 px or larger.
  - **Why:** `accessibility.md › Vision`: "Strive to meet color contrast minimum standards." Apple's floor is 4.5:1 for text up to 17 pt and 3:1 for larger or bold text. `color.md › System colors`: "don’t use the separator color as a text color, or secondary text label color as a background color" (roles must stay legible for their purpose).
  - **Fix:** in every theme block, lift `text-4` to at least 4.5:1 on `bg-cosmos` (Blue hour: about rgb(106 118 140), 4.6:1) and keep it for placeholders and footnotes only; add a guard in `themes.test.ts` for `text-4` and `nav-faint` at 4.5:1. For the score ladder, keep the four hues but floor `tier-4` at 3:1 for the bold number sizes (`ScoreNumber`) and at 4.5:1 where the number is 13 px regular (table cells, chips): Blue hour `tier-4` at about rgb(120 134 158) reaches 3.5:1 on white and 3.3:1 on the wash. A score that is low should read as low by its position on the ladder and its figure, not by fading out.

## Improvements

- **High. No application menu bar.** `electron/main.ts` never builds a `Menu`, so the window carries Electron's stock menu: no Settings… (⌘,), no Hide Sidebar, no Scan or Go commands, no entry for Add listing, Export, Full scan, API only, Filtered scan, the command palette or the shortcuts panel. The only routes to most commands are the title bar, the ⌘K palette and the g-chords.
  - **Why:** `designing-for-macos.md › Best practices`: "Use the menu bar to give people easy access to all the commands they need to do things in your app." `the-menu-bar.md › App-specific menus`: "Even when commands are available elsewhere in your app, it’s important to list them in the menu bar." `settings.md › Desktop (macOS)`: "Include a settings item in the App menu." `toolbars.md › Desktop (macOS)`: "Make every toolbar item available as a command in the menu bar."
  - **Fix:** a `Menu.buildFromTemplate` in `main.ts` with the standard order: starpath (About, Settings… ⌘,, Hide/Quit roles), File (Add Listing… ⌘N, Export…), Edit (roles, so Undo/Cut/Copy/Paste/Select All work in every field), View (Show/Hide Sidebar ⌃⌘S with the title swapping, Go to Scout ⌘1 … Go to Settings ⌘8, the zoom roles so 200 % text stays reachable), Scan (Full Scan, API Only, Filtered Scan…), Window (roles), Help (Keyboard Shortcuts ⌘/, starpath Help). Each item sends one IPC message the renderer maps onto the existing nav store and action handlers. Items stay present and disabled when unavailable (`the-menu-bar.md › Best practices`: "disable the action instead of hiding it").

- **High. No dark appearance, and the window is pinned dark.** All five themes are light content with a dark sidebar; `nativeTheme.themeSource = 'dark'` forces the title bar dark so it matches the sidebar; there is no `prefers-color-scheme` rule anywhere. A person running macOS in Dark Mode gets a white app in a dark system.
  - **Why:** `color.md › Best practices`: "Even if your app ships in a single appearance mode, provide both light and dark colors". `dark-mode.md › Best practices`: "In rare cases, consider using only a dark appearance in the interface." (the exception is media apps, not a data tool). `dark-mode.md › Dark Mode colors`: "The color palette in Dark Mode includes dimmer background colors and brighter foreground colors."
  - **Fix:** the theme system already routes every colour through role tokens, so this is one dark block per theme (or one shared "night" variant) under `[data-palette="…"][data-appearance="dark"]`, chosen from `prefers-color-scheme` by default with the existing picker staying for hue. Dark values are not an inversion: dim the grounds, brighten `text-1..3`, re-tune the accent and the ladder for 4.5:1, soften pure-white logos (`dark-mode.md › Dark Mode colors`: "Soften the color of white backgrounds."). Drop the forced `themeSource` once the content follows the system. This is the largest item here; it is a project, not a patch.

- **High. Increase Contrast and Reduce Transparency are ignored.** No `prefers-contrast` or `prefers-reduced-transparency` rule exists; `prefers-reduced-motion` does.
  - **Why:** `accessibility.md › Vision`: "ensure it at least provides a higher contrast color scheme when the system setting Increase Contrast is turned on." `liquid-glass.md › Review checklist`: "Reduce Transparency gets an opaque fallback, Increase Contrast gets stronger fills and borders".
  - **Fix:** one `@media (prefers-contrast: more)` block that moves `border-default` to `border-strong`, `text-3` to `text-2`, and the active-nav pill to a solid fill; one `@media (prefers-reduced-transparency: reduce)` block that removes every `backdrop-filter` and makes the scrim opaque.

- **High. The token-usage figure is wrong by orders of magnitude.** Settings › Token usage shows a week at $193,348.18 for 40 runs with 51.0 M tokens in and 22.2 M out. The app ledger (`batch/logs/app-usage.tsv`, 15 rows) sums to $28.26; the batch ledger (`batch/logs/usage.tsv`, 25 rows) sums to $193,319.91 because its `cost_usd` column holds values like 10691 and 14839 per run, which are not dollars. This is a data bug in the batch runner's ledger writer rather than in the view, but the view presents it as fact.
  - **Why:** judgment, under `design-principles.md › Responsibility`: "Act in people’s best interest." and `feedback.md › Best practices`: "Make sure all feedback is accessible." A figure that cannot be true costs trust in every other number on the screen.
  - **Fix:** find what the batch runner writes into `cost_usd` (it looks like a value in a smaller unit or a different column) and correct it at the source; in `usage.ts`, refuse rows whose cost is implausible for their token counts (above the published per-token ceiling) and show the week as "at least $X" with a footnote, as the code already does for rows with no cost.

- **Medium. Blur on every scrim.** Six modal backdrops and the report sheet use `backdrop-blur`; `globals.css` also defines an unused `.frosted` with a 20 px blur.
  - **Why:** `materials.md › Liquid Glass`: "Don’t use Liquid Glass in the content layer." `liquid-glass.md › Tauri and Electron`: "Prefer real system materials over CSS imitation." `sheets.md › Desktop (macOS)`: "The parent window is dimmed while the sheet is onscreen" (dimmed, not blurred).
  - **Fix:** keep the dim (`bg-scrim/[0.32]`), drop `backdrop-blur` from the seven scrims, delete `.frosted`. The sheet's lit edge and tinted shadow already separate it from the page.

- **Medium. Secondary click does nothing.** No `onContextMenu` anywhere: Database rows, Applying cards, Reports rows and sidebar items open nothing on right-click or Control-click, while the same actions exist in the row popover.
  - **Why:** `pointing-devices.md › Desktop (macOS)` (click table): "Reveal contextual menus." `context-menus.md › Best practices`: "Support context menus consistently throughout your app." and "Always make context menu items available in the main interface, too."
  - **Fix:** one `ContextMenu` primitive (the popover's item list, minus shortcuts) wired to `onContextMenu` on Database rows, Applying cards and Reports rows: View Full Report, Open Listing, Tailor CV…, Prep Application…, then Mark Not Interested last.

- **Medium. On/off settings are segmented controls.** "Run on its own" and "Evaluate automatically" are On | Off segments; "Show unscored" is a checkbox in the title bar.
  - **Why:** `toggles.md › Best practices`: "Use a toggle to help people choose between two opposing values that affect the state of content or a view." `segmented-controls.md › Content`: "Use nouns or noun phrases for segment labels." `toggles.md › Desktop (macOS)`: "Use switches, checkboxes, and radio buttons in the window body, not the window frame."
  - **Fix:** a `Switch` primitive (28 × 16, accent when on, knob moves, `role="switch"`) for the two schedule settings; move "Show unscored" into the Database filter rail as a checkbox row.

- **Medium. Custom shortcuts without Command.** Navigation is `g` then a letter; `?` opens the shortcuts panel; `/` focuses search. In the running app Shift+/ typed into the search field instead of opening the panel.
  - **Why:** `keyboards.md › Custom keyboard shortcuts`: "Prefer the Command key as the main modifier key in a custom keyboard shortcut." and "Avoid adding Shift to a shortcut that uses the upper character of a two-character key." (show ⌘? not ⇧⌘/).
  - **Fix:** ⌘1 … ⌘8 for the destinations and ⌘/ for the shortcuts panel, both listed in the View and Help menus; keep the g-chords as an extra, shown in the panel as "also g then d".

- **Medium. The assistant does not say it can be wrong, and replies have no Retry.** The chat empty state explains scope ("read live from your own pipeline") and the footer promises it never sends anything, which is the right instinct; nothing states that answers may be wrong, and a reply has no regenerate or dismiss control (not verified beyond the empty state and the transcript component's strings).
  - **Why:** `generative-ai.md › Inputs`: "clearly communicate that AI-generated content may contain errors." `generative-ai.md › Outputs`: "surfacing controls like Edit, Undo, Retry, or Adjust near generated content preserves people’s agency".
  - **Fix:** one line in the footer ("Answers can be wrong; check a report before acting on it"), and a Retry on the last assistant turn.

- **Medium. Charts have no accessible description.** The Trends bar chart is an SVG with a legend and a footnote; it is not verified whether the chart element carries a `role`, `title` or per-bar labels (recharts emits none by default).
  - **Why:** `charting-data.md › Best practices`: "Make every chart in your app accessible." `charts.md › Enhancing accessibility`: "a chart often needs to offer an accessibility label for each important or interactive element."
  - **Fix:** `role="img"` with an `aria-label` that states the message ("Listings per month, 50 over 14 months, strongest in the last two"), and an `aria-label` per bar naming month and counts; keep the footnote.

- **Medium. Settings is a view, not a window.** Settings lives in the sidebar with four tabs; there is no ⌘, and no App menu entry.
  - **Why:** `settings.md › Desktop (macOS)`: "a custom settings window contains a toolbar that includes buttons for switching between views — called *panes*" and "Include a settings item in the App menu."
  - **Fix (judgment):** keep the in-window view, which suits a single-window tool and is where Slack, Linear and Things put it, but add the App menu item and ⌘, from the menu-bar fix above, and restore the last-opened tab (`settings.md › Desktop (macOS)`: "Restore the most recently viewed pane.").

- **Low. Buttons that open a dialog carry no ellipsis.** Add listing, Filtered scan, Export, Change (repository) all open a dialog or picker.
  - **Why:** `buttons.md › Desktop (macOS) › Push buttons`: "Append a trailing ellipsis to the title when a push button opens another window, view, or app."
  - **Fix:** "Add listing…", "Filtered scan…", "Export…", "Change…".

- **Low. Pointing hand on buttons and rows.** 19 `cursor-pointer` call sites put the hand on controls.
  - **Why:** `pointing-devices.md › Pointers`: "Standard pointer for selecting and interacting with content and interface elements." The hand is for "a URL link to a webpage, document, or other item."
  - **Fix (judgment):** this is a web convention most Electron apps keep; the cost of following Apple here is low, so remove `cursor-pointer` from buttons and rows and leave it on real links (Open listing, report links).

- **Low. Extra-small controls at 24 px.** `.btn-xs` is 24 px tall (and 24 × 24 icon-only), used in 53 places: card stage menus, row actions, chip toggles.
  - **Why:** `accessibility.md › Mobility`: "Strive to meet the recommended minimum control size for each platform": macOS default 28 × 28 pt, minimum 20 × 20 pt. 24 px is legal but under the default.
  - **Fix:** leave the glyph at 24 px and give `.btn-xs` a 28 px hit region with negative margin, or promote the kanban stage menu to `sm` (28 px).

- **Low. Sentence case on buttons, menus and column headings.** The app uses sentence case for everything, by its own rule (DESIGN-meta.md § 3). Apple uses title-style capitalization for buttons, menu items and column headings.
  - **Why:** `writing.md › Best practices`: "Choose a style for each UI element type and use it consistently throughout your app". `lists-and-tables.md › Content`: "Use nouns or short noun phrases with title-style capitalization".
  - **Fix (judgment):** keep sentence case in the web content; it is consistent, which is what Apple asks for first, and it reads as the app's voice. The native menu bar must use title-style ("Add Listing…", "Hide Sidebar"), because the system draws it beside Apple's own menus.

- **Low. Messages, Profile and Settings sit at the sidebar's foot.** Messages is an inbox that can hold approvals.
  - **Why:** `sidebars.md › Desktop (macOS)`: "Avoid putting critical information or actions at the bottom of a sidebar."
  - **Fix (judgment):** the bottom group is a common home for Settings and Profile; leave them. Messages with an open approval could also surface in Scout's "Needs you" list, so nothing critical lives only at the foot.

## Craft notes

- **Point of view (keep).** The night sidebar with its faint stars, the cosmos wash under the page and the score ladder are the three things a person would remember. They are spent in one place each and everything else is quiet, which is the balance `branding.md › Best practices` asks for: "Ensure branding always defers to content."
- **Typography.** IBM Plex Sans with Plex Mono only on paths and logs, seven sizes, weights 400 to 600, tabular figures everywhere. One custom family instead of SF is a legitimate choice for a cross-platform web app; it stays crisp at 11 to 13 px. `typography.md › Using custom fonts`: "Make sure custom fonts are legible." holds.
- **Remove one accessory (Medium).** The five icon tiles on Scout's stage row and the four on the "Needs you" list are decoration: the icon repeats the label, the tint repeats the figure's colour. Dropping the tiles leaves label-over-figure, which the strip on Applying already does better. Judgment, not a HIG rule; the same read came from the taste-skill app chapter.
- **Signature element.** The Profile constellation and the Scout overview are the product's own; the rest of the kit is standard components used as Apple describes (`branding.md › Best practices`: "Express your brand with familiar components.").

## What works

- **Colour as roles with tests.** Every colour is a theme token and `themes.test.ts` fails a theme that drops below contrast for body text; the Critical item above is two tokens the test does not yet cover.
- **One prominent action per view, near-black.** Full scan, Run filtered scan, Add & evaluate: `buttons.md › Style`: "Keep the number of prominent buttons to one or two per view." is met everywhere, and the accent stays on selection and links (`branding.md › Best practices`: "Apply your app’s accent color judiciously.").
- **Dialogs have the right anatomy.** Title naming the task, Cancel on the left of the default button, the default trailing, Esc closes, one dialog at a time, sized to content (`alerts.md › Buttons`: "Always place the default button on the trailing side"; `modality.md › Best practices`: "Always give people an obvious way to dismiss a modal view.").
- **Tables.** Sortable headers with `aria-sort` and a direction glyph, rows focusable with `role="row"` and `tabIndex`, right-aligned tabular numbers, no zebra, a persistent selected-row tint behind the popover (`lists-and-tables.md › Desktop (macOS)`: "let people click a column heading to sort a table view").
- **Every icon-only button has a name.** All 20 `iconOnly` buttons carry `aria-label` or `title`; the collapsed sidebar adds tooltips (`icons.md › Best practices`: "Provide alternative text labels for custom interface icons.").
- **Empty states invite the next action.** "No upcoming deadlines … Go to Applying", "Nothing needs you", the chat's three starter questions (`writing.md › Best practices`: "Provide clear next steps on any blank screens.").
- **Responsibility.** "Chat never sends anything on your behalf" in the composer, scheduled runs described by what they do when on, demo mode read-only with a reason in the tooltip.
- **Text is copyable where it should be.** `user-select: none` on the body is undone for paragraphs, cells, list items and report prose (`labels.md › Best practices`: "Make useful label text selectable.").

## Platform notes

- Electron's stock menu is what gives the app ⌘+/⌘- zoom today; when the custom menu lands, keep the `zoomIn`/`zoomOut`/`resetZoom` roles in View so `accessibility.md › Vision` ("enlarge text by at least 200 percent") stays true, and check the Database and the sheet at 200 %.
- The window honours `hiddenInset` traffic lights, a 960 × 600 minimum, remembered bounds and a drag region; the Applying board scrolls sideways under 1,600 px rather than squeezing, which is the right trade.
- Not verified from screenshots: the inactive-window state (selection should go grey when the window is not key, `windows.md › macOS window states`), keyboard reach of kanban cards, and the dirty-form prompt on closing the Add listing dialog with text in it.
- Onboarding was excluded from this review at the owner's request; it holds the only 10 px and 10.5 px text in the app and the only uppercase tracked labels.
