# DESIGN.md — DR Creative Dashboard

Light theme only (users work on laptops in bright rooms). One typeface, system stack:
`-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif`, base 14px.
Tokens live in `static/style.css :root`.

## Tokens (current)
- Surfaces: `--bg #eef2ff`, `--surface #fff`, `--surface2 #f5f7ff`, `--border #e2e8f8`
- Text: `--text #1a2240`, `--text-muted #7b8db8`
- Accent (actions, selection): `--accent #2563eb`, `--accent-light #eff4ff`
- Semantic: `--success #10b981`, `--warning #f59e0b`, `--danger #ef4444` (each with `*-light` tint)
- Radii: `--radius 16px` panels, `--radius-sm 10px` controls
- Designer identity colors come from the `DESIGNERS` list in main.py and are data, not theme.

DR brand (navy `#010f37`, orange `#f6931e`, blue `#26a9e1`, lime `#d5de23`) is reserved for
identity moments (header, logo) in a later restyle pass. Brand orange is never a warning color.

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
