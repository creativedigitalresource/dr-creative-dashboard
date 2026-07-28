# DESIGN.md — DR Creative Dashboard

Light theme only (users work on laptops in bright rooms). Brand applied per
`digital-resource-brand-v2` (July 2026) — see that skill for the full deliverable
guide; this file only tracks what actually shipped in the dashboard and why.
Tokens live in `static/style.css :root`.

## Tokens (current — DR brand applied)
- Brand reference: `--dr-navy #010f37`, `--dr-orange #f6931e`, `--dr-blue #26a9e1`,
  `--dr-lime #d5de23`, `--dr-charcoal #404041`
- Surfaces: `--bg #f4f5f9`, `--surface #fff`, `--surface2 #f7f4ef`, `--border #e7e5df`
- Text: `--text` = `--dr-navy`, `--text-muted #6b7093`
- Accent (actions, selection, primary buttons, links): `--accent` = `--dr-orange`,
  `--accent-light #fef3e6`, `--accent-hover #dd7d0f`
- Semantic (untouched by brand — see rationale below): `--success #10b981`,
  `--warning #f59e0b`, `--danger #ef4444` (each with `*-light` tint)
- Radii: `--radius 15px` panels (brand spec exact value), `--radius-sm 10px` controls,
  `--radius-pill 100px` buttons only (brand spec: buttons are always full pill)
- Font: **Inter Tight** (`static/fonts/*.ttf`, weights 400/500/600/700/900 via
  `@font-face`), falling back to system sans. Brand-correct — v1 dashboard used
  plain "Inter" via system stack, not the actual Inter Tight files.
- Logo: real asset (`static/img/dr_logo_navbar.png`, cropped from the brand skill's
  `dr_logo_primary.png` to drop the tagline line for navbar proportions — transparent
  background, works on any surface). Used in both app headers and the PIN gate.
  No white/reversed logo variant was available, so headers stay light — a navy
  header would need that variant, which doesn't exist yet.
- Designer identity colors come from the `DESIGNERS` list in main.py and are data,
  not theme — untouched by the brand pass.

**Deliberately not applied** (v2 documents these but they're marketing/landing-page
patterns, wrong register for an internal ops tool per this project's "Restrained"
color strategy): gradient text, hero blob gradients, the 3D glossy icon system,
donut/glow-donut stat visuals, vibrant-lines ribbon, navy callout panels. If a
future page in this app needs one of those (e.g. a client-facing report), pull it
from the v2 skill then — don't retrofit it into the daily-use surfaces.

## Color discipline (agreed July 2026)
Red means one thing: a real deadline signal (past-due HDD pill, days-late text, "+Xh over" text).
Everything else keeps its own color:
- Progress bars stay in the designer's identity color, even when a task is over budget.
- At-risk / warnings use amber (`--warning`), never brand orange, never red.
- Revision limbo uses fuchsia (`#a21caf` on `#fdf4ff`, border `#f0abfc`).
- True EST uses teal (`#0d9488` on `#f0fdfa`); its "needed" prompt state is amber, dashed border.
- Capacity bars: green under 60%, amber 60–85%, red 85%+ (thresholds already in calendar code).

## Component vocabulary
- **meta-pill**: small rounded status/edit chips on task rows (HDD, EST, TRUE, logged). Editable
  pills get `cursor:pointer` and open an inline input, never a modal. "Prompt" pills (missing
  value that needs a human decision) are dashed-border amber or fuchsia.
- **cap bar**: 5–8px rounded track `#e2e8f0` with a colored fill; always paired with an
  explicit number (pct or hours). Never a bar without a number.
- **avatar**: colored circle with initials in the designer's identity color.
- **badge rows** (`↩ Revisions · waiting Nd`, `↓ starting this week`): tinted rounded labels,
  11px, weight 600.
- Tables for dense task detail; cards only for genuinely independent units. No nested cards.
- Empty states say what the emptiness means ("Nothing past due"), never just blank.

## Bans (project-specific, on top of house rules)
- No colored left/right side-stripe borders as accents.
- No hero-metric tiles, no gradient text, no modals for anything editable inline.
- No red as a general emphasis color; see color discipline above.
- No invisible/transparent placeholder text for column alignment; use a muted dash.

## Motion
150–250ms, ease-out only. Accordion expand, bar width transitions, hover backgrounds.
Nothing animates on page load.
