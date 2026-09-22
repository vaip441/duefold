---
name: Duefold
description: A prepared reading room for investor documents — calm, editorial, information-dense, on one plane.
colors:
  ground: '#f2f3f1'
  ground-sunken: '#e8eae7'
  ground-raised: '#f7f8f6'
  ink: '#1b211f'
  ink-muted: '#555f58'
  ink-faint: '#616a63'
  rule: '#c7cdc7'
  rule-strong: '#7e877f'
  accent: '#006b5e'
  accent-strong: '#00544a'
  accent-contrast: '#ffffff'
  accent-wash: '#dfe8e4'
  danger: '#8e2c1c'
  notice: '#7a5310'
  selection-ground: '#cfe0da'
  ground-dark: '#161a18'
  ground-sunken-dark: '#111513'
  ground-raised-dark: '#1e2320'
  ink-dark: '#e8ebe7'
  ink-muted-dark: '#a7b0a9'
  ink-faint-dark: '#939c95'
  rule-dark: '#2e3531'
  rule-strong-dark: '#666e68'
  accent-dark: '#5fc9b4'
  accent-strong-dark: '#7fd8c6'
  accent-contrast-dark: '#0b0f0d'
  accent-wash-dark: '#1d2f2b'
  danger-dark: '#f0958a'
  notice-dark: '#ddb25e'
typography:
  title:
    fontFamily: "'Source Serif 4 Variable', 'Source Serif 4', georgia, serif"
    fontSize: '1.5rem'
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: '-0.011em'
  section:
    fontFamily: "'Source Serif 4 Variable', 'Source Serif 4', georgia, serif"
    fontSize: '1.125rem'
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: '-0.011em'
  body:
    fontFamily: "'Public Sans Variable', 'Public Sans', system-ui, sans-serif"
    fontSize: '0.9375rem'
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 'normal'
  meta:
    fontFamily: "'Public Sans Variable', 'Public Sans', system-ui, sans-serif"
    fontSize: '0.8125rem'
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 'normal'
  label:
    fontFamily: "'Public Sans Variable', 'Public Sans', system-ui, sans-serif"
    fontSize: '0.6875rem'
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: '0.08em'
rounded:
  control: '2px'
spacing:
  '1': '0.25rem'
  '2': '0.5rem'
  '3': '0.75rem'
  '4': '1rem'
  '5': '1.5rem'
  '6': '2rem'
  '7': '3rem'
components:
  button:
    backgroundColor: '{colors.ground}'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    padding: '{spacing.2} {spacing.4}'
    height: '2.5rem'
  button-hover:
    backgroundColor: '{colors.ground-raised}'
    textColor: '{colors.ink}'
  button-primary:
    backgroundColor: '{colors.accent}'
    textColor: '{colors.accent-contrast}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    padding: '{spacing.2} {spacing.4}'
    height: '2.5rem'
  button-primary-hover:
    backgroundColor: '{colors.accent-strong}'
    textColor: '{colors.accent-contrast}'
  button-primary-disabled:
    backgroundColor: '{colors.ground-sunken}'
    textColor: '{colors.ink-faint}'
  button-quiet:
    backgroundColor: 'transparent'
    textColor: '{colors.ink-muted}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    padding: '{spacing.1} {spacing.2}'
    height: '2.25rem'
  input:
    backgroundColor: '{colors.ground-raised}'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    padding: '{spacing.2} {spacing.3}'
    height: '2.75rem'
  index-entry:
    backgroundColor: 'transparent'
    textColor: '{colors.ink-muted}'
    typography: '{typography.body}'
    padding: '{spacing.2} {spacing.5}'
  index-entry-current:
    backgroundColor: '{colors.ground-raised}'
    textColor: '{colors.ink}'
  notice:
    backgroundColor: 'transparent'
    textColor: '{colors.ink}'
    typography: '{typography.meta}'
    padding: '{spacing.2} 0 {spacing.2} {spacing.3}'
  region-label:
    backgroundColor: 'transparent'
    textColor: '{colors.ink-faint}'
    typography: '{typography.label}'
---

# Design System: Duefold

## Overview

**Creative North Star: "The Prepared Reading Room"**

Duefold looks like a special-collections reading room where the material has
already been catalogued and laid out: a finding-aid index at the edge, a broad
worktable in the middle, access notes at the table's edge, and fine rules
separating one from another. The founder arrives to find the collection organized
rather than a dashboard reporting on it. Nothing floats, nothing hovers, and
nothing competes with the document.

The system is deliberately quiet because the work is long and consequential.
Hierarchy is carried by typography, alignment, rules, and state — never by
elevation. One controlled green marks what is active and what the primary action
is; everything else is ink on paper in two weights of ground. Density is high and
unapologetic, because a person publishing a diligence room needs to see the
collection, not scroll through it.

This build ships the design system, the app shell, and the authentication
surfaces. Room browsing, the document register, the viewer, and admin surfaces
land on this system later rather than reinventing it.

**Key Characteristics:**

- One plane; regions are separated by rules, ground shifts, and space
- Type-led hierarchy from a five-size scale, two families, both self-hosted
- Exactly one accent green, reserved for active state and the primary action
- No shadows, no cards, no radius above 2px
- Full token parity between light and dark; document pixels never inverted
- Motion only where it explains a state change; nothing animates on first paint

## Brand

The Duefold brand mark is the **Ribbon**: a capital D formed from one folded ribbon. Its upright stem signals a dependable document spine; the open bowl gives the identity motion without turning it into an ornamental seal. The diagonal negative space is the fold, and the small lower gap is the ribbon tail. Both gaps are essential to the silhouette.

### Geometry

- **Grid:** Built on a 32×32 unit viewBox. Drawn content spans x 6–26 and y 4–28.
- **Stem:** Ink path `M6 4.75 11.33 10.09V28H6Z`.
- **Bowl:** Accent path `M6.75 4H14A12 12 0 0 1 14 28H12.33V22.67H14A6.67 6.67 0 0 0 14 9.33H11.33V8.58Z`.
- **Fold:** The diagonal gap between stem and bowl stays unfilled at every size.
- **Tail:** The lower gap where the bowl ends beside the stem stays open.

### Rules

- **Clear space:** Minimum clear space around the mark or lockup is equal to 50% of the mark's height on all four sides. No text, icons, rules, or borders may intrude into this zone.
- **Minimum size:**
  - Mark only: 16×16 px (e.g. browser favicon, document status indicator).
  - Full horizontal lockup (mark + wordmark): 100 px wide (or 20 px mark height).
- **Colours:**
  - Light Ground: stem in Ink (`#1b211f`), bowl in Accent (`#006b5e`).
  - Dark Ground: stem in Dark Ink (`#e8ebe7`), bowl in Dark Accent (`#5fc9b4`).
  - Single-color / Monochrome: both paths use `currentColor`; the fold and tail remain legible as negative space.
- **Wordmark:** “Duefold” is Source Serif 4 SemiBold (weight 600) with `-0.015em` tracking. Static lockups use outlined glyphs; the app uses live text in the self-hosted font.
- **Lockup:** Mark height is 0.9× the wordmark font size; the gap is 0.28× the wordmark font size; both are vertically centred.

## Colors

A cool, paper-toned neutral field with a single deep green accent and two
low-chroma status hues. Every foreground/ground pair in both themes is measured,
not estimated; the ratios below are asserted by
`apps/web-client/src/tokens.unit.test.ts`.

### Primary

- **Reading-Room Green** (`#006b5e` light, `#5fc9b4` dark): the current index
  entry, the primary action, the focus ring, and link text. 5.78:1 on the light
  ground and 8.79:1 on the dark ground. White on the light accent fill is 6.43:1;
  near-black on the dark accent fill is 9.65:1.
- **Green Pressed** (`#00544a` light, `#7fd8c6` dark): hover and active on the
  primary action, and hovered links. 7.97:1 and 10.49:1 respectively.
- **Green Wash** (`#dfe8e4` light, `#1d2f2b` dark): available as a current-item
  ground. Never used as the sole ground behind body text.

### Secondary

None. The system has one accent by design.

### Tertiary

- **Iron Oxide** (`#8e2c1c` light, `#f0958a` dark): validation errors and problem
  notices. 7.47:1 / 7.84:1.
- **Aged Brass** (`#7a5310` light, `#ddb25e` dark): caution notices such as an
  expired code or a paused request. 6.14:1 / 8.87:1.

### Neutral

- **Paper** (`#f2f3f1` light, `#161a18` dark): the one plane. Every region sits
  on it.
- **Paper Sunken** (`#e8eae7` light, `#111513` dark): the collection index and
  the access-notes margin. A ground shift *within* the plane, never a card.
- **Paper Raised** (`#f7f8f6` light, `#1e2320` dark): the current index entry and
  field interiors.
- **Ink** (`#1b211f` light, `#e8ebe7` dark): body and heading text. 14.69:1 /
  14.62:1.
- **Ink Muted** (`#555f58` light, `#a7b0a9` dark): secondary rows, lead
  paragraphs, notice bodies. 5.96:1 / 7.89:1.
- **Ink Faint** (`#616a63` light, `#939c95` dark): region labels, help text, empty
  states. 5.03:1 on the light ground and 4.63:1 on the sunken ground — it clears
  4.5:1 on *both*, which is why it is not lighter.
- **Hairline** (`#c7cdc7` light, `#2e3531` dark): region separation. Decorative;
  never the sole carrier of meaning.
- **Stroke** (`#7e877f` light, `#666e68` dark): control borders. 3.33:1 / 3.34:1,
  meeting WCAG 1.4.11 for non-text contrast.

### Named Rules

**The One Green Rule.** The accent means exactly three things: this item is
current, this is the primary action, or this element has focus. It is never a
background field, never a decorative rule, never a status hue, and never applied
to inactive state. There are four accent tokens and a test fails if a fifth
appears.

**The Colour-Is-Never-Alone Rule.** Every state that uses colour also states
itself in words or structure. The current index entry carries `aria-current` and a
ground shift alongside its green bar; every notice carries wording that names the
state; no status is conveyed by hue alone.

**The Document-Pixels Rule.** Rendered document content carries
`.df-document-pixels`, which pins a white ground, black text,
`color-scheme: light`, and `forced-color-adjust: none`. Document pixels are
colour-accurate in both themes and are never theme-inverted.

## Typography

**Display Font:** Source Serif 4 Variable (with Source Serif 4, Georgia, serif)
**Body Font:** Public Sans Variable (with Public Sans, system-ui, sans-serif)
**Label Font:** Public Sans Variable, tracked and uppercased at the label size

**Character:** A working editorial pairing rather than a branded one. Source Serif
4 carries titles and section headings because the product is read, not monitored;
it is a text serif designed for long-form screen reading, so it stays legible at
the small sizes a dense interface needs. Public Sans carries every piece of
interface furniture — labels, controls, tables, metadata — because it was drawn
for government forms and dense administrative use, which is precisely the register
of a finding aid.

Both faces are **self-hosted** from `@fontsource-variable/source-serif-4@5.3.0`
and `@fontsource-variable/public-sans@5.3.0`, both **OFL-1.1**, both verified
against the shipped `LICENSE` file. No font is fetched from a third-party CDN at
runtime: a CDN font request would disclose viewer activity to a third party on
every page load, so all fonts are served locally. Both are variable fonts, so the
three weights below cost one file per subset.

### Hierarchy

Five sizes. A sixth was drafted and deleted because nothing consumed it. Sizes are
fixed rem rather than fluid: a product interface is read at consistent DPI, and a
heading that shrinks inside a narrow region reads as a bug. Because they are rem,
a reader's browser font-size setting scales the whole interface.

- **Title** (600, 1.5rem, 1.25, -0.011em): the single `h1` per view. Serif.
- **Section** (600, 1.125rem, 1.25, -0.011em): region and group headings. Serif.
- **Body** (400, 0.9375rem, 1.55): running text, table cells, control labels.
  Sans. Prose is bounded at 68ch.
- **Meta** (400, 0.8125rem, 1.55): metadata, help text, notices, secondary rows.
  Sans.
- **Label** (600, 0.6875rem, 0.08em, uppercase): region labels only — Collection,
  Access notes, Counterparties. Sans.

The ratio between steps is roughly 1.15–1.33, tighter than a brand scale because
there are more type elements here and exaggerated contrast would read as noise.

### Named Rules

**The One-H1 Rule.** Each view has exactly one `h1`, and it lives in the
worktable, naming the task rather than the product. Region labels are `h2`. The
wordmark is not a heading.

**The Tabular-Figures Rule.** Anything aligned or compared — tables, times,
countdowns, the OTP field, anything marked `data-numeric` — uses
`font-variant-numeric: tabular-nums` so digits form columns instead of words.
Monospace is never used as a costume for "technical".

## Layout

The shell is one CSS grid with five named areas: `facts` across the top,
`index | worktable | notes` across the middle, and `counterparties` across the
bottom. DOM order matches visual order, so focus order needs no `tabindex`.

- **Index:** fixed `15rem`. A finding aid is scanned, not read, so it does not
  flex.
- **Worktable:** `minmax(0, 1fr)`. It takes the remainder; the `0` minimum stops
  long content forcing overflow.
- **Notes:** fixed `17rem` — wide enough for plain-language policy sentences.
- **Spacing:** one 4px-derived ramp (`0.25rem` to `3rem`). Region padding uses
  steps 5–6, groups use 2–3. More space above a heading than below it.

Responsive behaviour is **structural**, not a scale factor:

- **≤68rem:** the notes margin moves below the worktable rather than being
  compressed into an unreadable column, and drops its side rule for a top rule.
- **≤48rem:** one column. The index becomes a disclosure above the worktable,
  expanded by default so a keyboard user never has to open it to reach the
  collection. At this width a persistent tree would leave the document no room.
- **320px:** verified free of horizontal overflow, with the room-facts controls
  wrapping rather than pushing the line wider than the viewport.

## Elevation & Depth

**This system has no shadows.** Not "few" — a test asserts that no `box-shadow` or
`drop-shadow` appears anywhere in the stylesheets. Depth is expressed entirely by
tonal layering and rules on a single plane.

### Named Rules

**The One-Plane Rule.** This is the rule later surfaces must not drift from. Every
region sits on the same plane. A region is separated from its neighbour by exactly
one of:

1. a 1px rule on the shared edge,
2. a small ground shift (`--ground-sunken` behind the index and notes), or
3. space.

Never by a border on all four sides, never by a shadow, never by a radius above
`--radius-control`, and never by a floating container. **A region that needs to
feel separate gets a heading and a rule, not a box.**

**The Declare-Elevation-Once Rule.** Because there are no shadows, a border is the
only elevation signal, and it is used once per boundary. A 1px border under a soft
shadow — the ghost card — cannot occur here by construction.

## Shapes

Radii stop at 2px (`--radius-control`), applied to buttons, fields, and the skip
link. A test asserts that every `border-radius` in the codebase resolves to
`var(--radius-control)`, so a literal 12px radius cannot slip in. Nothing is a
pill; nothing is a rounded card.

The recurring silhouette is the **rule**: a 1px hairline separating regions, a 1px
hairline under a sheet title, a 2px inline-start bar marking a current entry or a
notice's tone. The one non-rectangular form in the system is the disclosure
marker, a rotated 0.5rem square border used at narrow widths.

## Components

- **Accessible primitives:** `@base-ui/react` provides the publication and
  safe-link dialogs plus the create-folder collapsible. It owns focus trapping and
  return, Escape/outside dismissal, semantic relationships, and exit presence;
  Duefold supplies all styling and motion tokens. Base UI also provides
  `ConfirmationDialog` — one dialog for every reviewed, typed or single-press
  confirmation in room administration, with the consequence stated before the field
  that unlocks the action and Cancel taking initial focus — and `NewRoomDialog`,
  which focuses its title field because nothing destructive sits behind its primary
  action. The responsive account disclosure stays local because its arbitrary form
  children must exist exactly once in the DOM; it provides the same Escape,
  outside-dismissal, focus-return, and exit behavior without cloning labelled controls.
- **Status table:** the Status section is one `df-register` table, twelve rows in
  §20.2's order. Every state is a word — Passing, Needs attention, Failing, Not yet
  checked, Out of date — and only Passing carries the accent. Every recorded instant is a
  `<time>` whose `dateTime` and title hold the UTC value; rows read live say "Now". A failing
  check stays Failing when its answer is also old, because the last known answer to it is a
  failure. When any row fails, a problem notice leads with the count.
- **Installation review:** the installation download default reuses `ConfirmationDialog`.
  Both directions open on the server's review of the rooms and published documents the
  change reaches; allowing adds the server's phrase and a fresh sign-in, denying is one
  press, as returning a room to draft is.

### Buttons

- **Shape:** near-square, 2px radius (`var(--radius-control)`), 1px border.
- **Default:** paper ground, ink text, `--rule-strong` border, `2.5rem` min
  height, `0.5rem 1rem` padding.
- **Primary:** accent fill, `--accent-contrast` text, semibold. One primary action
  per surface.
- **Quiet:** transparent border and ground, muted ink, `2.25rem` min height. For
  secondary actions such as sign-out-everywhere.
- **Hover:** border darkens to `--ink-faint`, ground lifts to `--ground-raised`;
  the primary deepens to `--accent-strong`.
- **Active:** `scale(0.985)` over 120ms, so the control confirms it heard the
  press.
- **Focus:** 2px accent outline at 2px offset.
- **Disabled:** sunken ground, faint ink, `not-allowed` cursor.
- **Busy:** `data-busy="true"` plus label text that states the action in progress.
  There is no spinner — a spinner beside text that already says "Verifying…" is
  decoration.

### Text links

Underlined at 1px with a 0.18em offset, accent-coloured, `24px` minimum target
height so they satisfy WCAG 2.2 2.5.8 without looking like controls.

### Cards / Containers

**There are none.** See the One-Plane Rule. The nearest equivalents are:

- **The sheet** (`.df-sheet`): the unauthenticated surface. A `27rem` measured
  column on the ordinary plane, with a hairline under the title. No box.
- **The region** (`.df-index`, `.df-notes`): a ground shift plus one edge rule.

### Inputs / Fields

- **Style:** `--ground-raised` interior, 1px `--rule-strong` border, 2px radius,
  `2.75rem` min height.
- **Hover:** border darkens to `--ink-faint`.
- **Focus:** the global 2px accent outline.
- **Invalid:** `aria-invalid` plus a danger-coloured border plus a text error
  referenced by `aria-describedby`. Three signals, never colour alone.
- **Disabled:** sunken ground, faint ink.
- **Code field:** tracked 0.32em at 1.25rem with tabular figures and a `12ch` cap,
  so eight digits read as eight digits.

### Navigation

The collection index is a list of buttons, indented by depth to read as a finding
aid. The current entry carries three simultaneous signals: a 2px accent
inline-start bar, a `--ground-raised` ground, and `aria-current="true"`. Entries
declare `aria-controls` pointing at the worktable, so the relationship between
index and worktable is programmatic rather than visual. At ≤48rem the index
collapses behind a disclosure with a rotating marker and `aria-expanded`.

### Notices (signature component)

A notice is a **ruled band on the plane**, not an alert box: one 2px inline-start
rule in the state colour, optional bold title, body text, and no container. Four
tones — neutral, action (accent), problem (danger), caution (notice). Problem
notices carry `role="alert"`; informational ones carry `role="status"`. Every tone
is legible without its colour, because the wording states the state.

### Status region (signature component)

One visually hidden `role="status" aria-live="polite"` region per view, empty on
first paint, updated when an asynchronous operation starts or settles. It is how a
screen-reader user learns about pending work and outcomes that are otherwise only
visible.

## Motion

Motion explains a state change or a spatial relationship, or it does not ship.

- **Tokens:** `--duration-press` 120ms, `--duration-state` 160ms,
  `--duration-region` 200ms; `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` for
  entry/exit and `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)` for on-screen
  movement.
- Every duration is under 300ms; a test asserts it.
- Transitions **name their properties**. `transition: all` is asserted absent.
- **Nothing animates on initial application paint.** There are no `@keyframes`,
  no `animation-name`, and no `@starting-style` rules; tests assert all three.
  Base UI's transition attributes are used only after an overlay or disclosure
  changes state.
- The authored moments are: the skip link translating into view on focus, button
  press feedback, disclosure-marker rotation, a 100/160ms opacity handoff between
  member and viewer authentication tasks, a 200ms FLIP translation when a
  structure row changes position, and short Base UI transitions for the
  publication/link dialogs, mobile account popover, and create-folder disclosure.
  Routine section navigation, document paging, search results, and progress remain
  instant.
- **Reduced motion:** `prefers-reduced-motion: reduce` removes transforms, smooth
  scrolling, FLIP movement, and accordion travel. Opacity and colour transitions
  remain at the normal short state duration so feedback and hierarchy stay legible.

## Accessibility commitments

Target: WCAG 2.2 AA.

**Verified automatically.** `@axe-core/playwright` reports zero violations, and
the token, keyboard, and responsive suites pass. Coverage is NOT uniform across
every state: the sign-in, OTP request/verify, and shell surfaces are scanned in
both themes at desktop and 320px, while the locked-OTP and collapsed-shell states
are scanned in one theme only, and the loading, offline, unavailable, and
rate-limited states are not axe-scanned at all. Treat the list below as the rules
automation can decide, not as a claim that each criterion is fully discharged:

- 1.1.1 non-text content, 1.3.1 info and relationships, 1.3.5 input purpose
- 1.4.3 contrast (computed from tokens, both themes, both grounds)
- 1.4.4 resize text (rem sizing), 1.4.10 reflow (320px, no horizontal scroll)
- 1.4.11 non-text contrast (control borders and focus ring measured)
- 1.4.12 text spacing, 2.4.1 bypass blocks (skip link exercised by keyboard)
- 2.4.2 page titled, 2.4.6 headings and labels
- 2.4.7 focus visible (computed outline width asserted ≥2px)
- 2.5.3 label in name, 2.5.8 target size (every control measured ≥24px)
- 3.2.4 consistent identification, 3.3.1 error identification
- 3.3.2 labels or instructions, 4.1.2 name role value, 4.1.3 status messages
- 2.3.3 animation from interactions (reduced-motion honoured)

**WCAG 2.2 additions, tested behaviourally** in `test/browser/wcag22.spec.ts`,
because axe cannot decide most of them. Each runs against a populated room with a
real participant, a real grant, and real processing rows:

- 2.5.8 target size, measured on every rendered control at desktop and 320px,
  applying the spacing exception as WCAG states it — 24px circles centred on each
  target must not overlap, not merely "boxes are 24px apart". The suite includes a
  self-check that injects a genuinely cramped pair and requires the detector to
  report it, so the check cannot silently stop meaning anything.
- 2.4.11 focus not obscured, by tabbing the surface and asserting the focused
  control is in the viewport and not covered at its own centre point. The skip link
  is exempt because it animates into view on focus.
- 2.5.7 dragging movements: zero `draggable` elements, no grab cursors, and the
  move up/move down buttons plus the numeric position field asserted present.
- 3.3.8 accessible authentication: the code field carries `one-time-code`, a real
  delivered code is pasted in one action and completes sign-in, and no puzzle,
  arithmetic, or transcription step exists.
- 3.2.6 consistent help, with a support contact actually configured in the
  database, present on both sign-in surfaces at the same relative focus position.
  An earlier version of this test passed with help absent from both, proving
  nothing; it now requires presence first.

**Engine coverage is two engines, not three.** Chromium and Gecko run the whole
suite; `mobile-chromium` is a third project on the same engine as `chromium`.
WebKit is not configured because launching it needs roughly twenty-five system
libraries this host lacks and root to install them. **Safari and iOS behaviour is
therefore unverified**, and the release evidence must say so rather than implying
three engines were covered.

2.4.3 focus order is only PARTIALLY automated: the keyboard suite asserts the skip
link is first and that a sign-out control is reachable, which would not catch many
incoherent reorderings. A meaningful sequence still needs human judgement.

**Requires human review** — an axe pass is not an accessibility guarantee, and
these cannot be verified mechanically:

- 1.3.2 meaningful sequence beyond DOM order
- 2.4.6 whether headings and labels are genuinely descriptive
- 3.3.3 whether error suggestions are actually actionable
- 1.4.1 use of colour, judged by a human on the rendered result
- 4.1.3 whether live-region announcements are useful rather than merely present
- Screen-reader journeys with real assistive technology (NVDA, JAWS, VoiceOver)
- Cognitive load of the OTP flow for a first-time viewer
- Whether the neutral security copy is comprehensible to a non-technical reader
- 3.3.7 redundant entry and 3.3.9 accessible authentication (enhanced): the flows
  are short enough that no re-entry occurs today, but nothing asserts it, so both
  are claimed by inspection rather than tested.

**Structural commitments:** semantic landmarks on every shell region, exactly one
`h1` per view, programmatic index↔worktable relationship, one polite live region
per view, complete keyboard operation with visible focus, no colour-only meaning,
light/dark/system with an individual override, and a designed state for loading,
empty, validation, denied, expired, revoked, rate-limited, failure, retry, and
offline.

## Security-bearing UI decisions

These are design decisions the threat model depends on, recorded so a later change
does not undo them casually.

**The viewer OTP surface must not disclose eligibility.** The server answers a
code request identically whether or not the address was invited, and delivery is
asynchronous. The UI therefore has one request path, one response handler, and one
resulting screen; copy says "If this address has access" rather than asserting an
email was sent; and there is no client-side eligibility check that could reveal an
unknown address before submission. A browser test asserts the invited and
uninvited screens are byte-identical in text.

**Expiry and lockout are derived from client-observed facts only.** `consumeOtp`
deliberately returns a single `null` for an invalid code, an expired code, a locked
challenge, and a never-invited address, so the server emits one uniform 401. The
UI does not reconstruct the distinction the server refused to make. The distinct
"expired" and "locked" states come only from facts the client observes for itself —
elapsed time against the published ten-minute lifetime, and the client's own
submitted-attempt count against five. Two constraints follow: the client's derived
state never contradicts the server, so if the client believes a code is still live
and the server returns 401 the server wins and the copy stays neutral; and wording
and timing are identical regardless of invitation status, with no early
client-side validation that would reveal an address is unknown before submission.

**CSRF is a double-submit cookie, wired in one place.** The session row stores only
`csrf_digest`, so the raw token exists exactly once, at issuance. It is set as
`__Host-duefold_csrf` — `Secure`, `SameSite=Lax`, host-only, and deliberately
readable by same-origin script — and `apps/web-client/src/api/client.ts` echoes it
in `x-duefold-csrf` for every mutation. `HttpOnly` is deliberately false: a CSRF
token has never been an XSS control, because script on this origin can already
issue any mutation using the HttpOnly session cookie. What the token must resist is
a cross-origin *read*, which the cookie jar and the absence of CORS carry. The
`__Host-` prefix forbids `Domain`, so no sibling subdomain can read it. **Whoever
wires `rotateSession` into a live route must set this cookie in the same reply**;
rotation mints a new digest and a stale cookie would surface as opaque 403s.

**Nothing is persisted.** No token, session value, or protected content is written
to `localStorage`, `sessionStorage`, IndexedDB, a service worker, or a cache. The
theme override is held in React state rather than storage for the same reason. A
browser test asserts all five are empty after a full sign-in.

**The browser is never the authorization boundary.** The client renders what the
server said; it makes no access decision, and a hidden control is never treated as
a permission.

**No DRM claim.** The interface makes no statement that screenshots or browser
workarounds can be prevented, and a test asserts no catalogue string does.

**Status never shows configuration.** The Status section renders codes the server
records, translated to copy; it has no field that could show an issuer, endpoint,
bucket, host, credential or address, and the server has none to send. What a check could
not see is said in its copy — the storage privacy check names the public URLs it cannot
reach.

## Build-time composition in the browser

Module composition is resolved at build time and is absent from the product UI.
The mechanism has one subtlety worth stating plainly:
`.duefold/generated/browser-entries.ts` records each composed module's browser
entry as a source **path string**, and a string cannot pull code into a bundle.
The loading mechanism is therefore the Vite plugin at
`apps/web-client/build/browser-entries-plugin.ts`, which reads that registry at
build time and emits a virtual module of **literal static imports**. Do not mistake
the string registry for the loader.

An omitted module has no registry entry, is never named by any import, and so
cannot appear in the built output. `test/browser/composition.spec.ts` proves this
against real build artifacts on three legs: no route in the generated registry, no
configuration key, and no code in the built JavaScript.

## Localization

English is the only 1.0 locale, but every UI string resolves through a key in
`apps/web-client/src/i18n/en.ts`. A later locale is a catalogue addition, not a
source rewrite. Security and legal text is never machine-translated.

## 2026-09-22 workspace preparation and reading-room refinement

- Room work now begins with one explicit preparation path: **Collection → Access → Review → Publish**. Collection owns structure and ingestion, Access owns readers and counterparties, Review opens processing readiness, and Publish remains consequence-first behind the server dry-run dialog. Processing, exports, branding, and settings remain supporting sections below the path rather than competing as equal preparation steps.
- The shell no longer owns a global counterparty footer. Counterparties are rendered only by the authorized member Access surface; the viewer reading room never receives or emits that concept in its DOM.
- The viewer collection index is canonical. Folders are non-interactive finding-aid headings, documents activate the worktable, and the previous duplicate collection register was removed.
- Collection rows expose one **Manage** disclosure. Reordering is a dedicated mode, while rename, placement, metadata, download policy, and staged removal stay inside the selected row’s focused task.
- Upload is a reviewed multi-file or directory queue. Browser preflight applies the shared path, depth, count, total-size, collision, and extension rules before transfer; each file then uses the existing per-file intent, multipart transfer, and finalization contract and keeps an independent waiting, progress, accepted, or failed state. Relative paths are review context only because the current server attachment contract does not accept a destination folder.
- Responsive registers carry visible cell labels when headers move off-screen. The preparation path, upload queue, and focused row task restack to one column at 48rem without changing source or focus order.

## Do's and Don'ts

### Do:

- **Do** separate regions with a rule, a ground shift, or space — the One-Plane
  Rule.
- **Do** carry hierarchy in type, alignment, and rules before reaching for
  anything else.
- **Do** reserve the accent for current state, the primary action, and focus.
- **Do** pair every colour-carried state with wording or structure that states it.
- **Do** use `--ink-faint` as the lightest text, and only on `--ground` or
  `--ground-sunken`, where it is measured above 4.5:1.
- **Do** size type in rem, from the five-step scale.
- **Do** give every interactive element default, hover, focus, active, and disabled
  states.
- **Do** state pending work in the control's own label and announce it in the live
  region.
- **Do** restack layouts at breakpoints; verify 320px has no horizontal overflow.
- **Do** name transition properties explicitly and keep durations under 300ms.
- **Do** route every string through a localization key.
- **Do** use the display title when identifying a document.

### Don't:

- **Don't** add a `box-shadow`, a `drop-shadow`, or any elevation. Tests fail.
- **Don't** introduce a card: a bordered, rounded, floating container has no place
  in this system.
- **Don't** exceed the 2px control radius, or write a literal radius instead of
  `var(--radius-control)`.
- **Don't** add a fifth accent token or a second accent hue.
- **Don't** use the accent as a decorative field, a status hue, or a fill behind
  body text.
- **Don't** build a metric-card overview or dashboard chrome.
- **Don't** animate on first paint, add `@keyframes`, or use `transition: all`.
- **Don't** theme-invert document pixels; use `.df-document-pixels`.
- **Don't** fetch a font, script, style, or image from a third-party origin.
- **Don't** persist anything to `localStorage`, `sessionStorage`, IndexedDB, a
  service worker, or a cache.
- **Don't** show an internal code, correlation id, object key, SHA-256 digest,
  storage URL, internal filename, module name, or provider detail in the UI.
- **Don't** let authentication copy differ by whether an address was invited.
- **Don't** derive an OTP failure reason from a server response, or let a
  client-side guess contradict the server.
- **Don't** treat a hidden control as a permission, or gate protected content on
  client state.
- **Don't** claim screenshots or browser workarounds can be prevented.
- **Don't** use emoji or a Unicode glyph as an icon.
