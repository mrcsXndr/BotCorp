# Cockpit design system

The cockpit's look comes from one set of CSS custom properties at the top of
`index.html` (`:root`). Components use tokens only: no raw colours, sizes or
radii in component rules. The terminal is the one exception. It stays dark in
both themes because it is the TUI's own surface (`--term-bg`, which matches the
xterm theme in `app.js`).

## Themes

- **Light is the default.**
- **Dark** applies when the OS prefers dark (`prefers-color-scheme`), or when
  the viewer picks it. The sidebar's "theme" control cycles auto, light, dark.
- The viewer's choice is stored in `localStorage` (`cockpit.theme`). Every
  access is wrapped in try/catch, so blocked storage just falls back to auto.
- `theme.js` sets `html[data-theme]` before first paint. The dark values are
  declared twice: once under the media query (guarded by
  `:not([data-theme="light"])`) and once for `[data-theme="dark"]`.

## Colour roles

| token | role |
|---|---|
| `--bg` | the page |
| `--side` | the bot column |
| `--surface` | cards, assistant bubbles, menus, modals, buttons |
| `--field` | inputs |
| `--hover` | a translucent tint for hover and selected rows |
| `--line`, `--line-strong` | hairline edges; strong = inputs, buttons, table heads |
| `--text`, `--text-2`, `--text-3` | primary (calm, not pure black), secondary, meta |
| `--accent`, `--accent-hover`, `--accent-ink` | the one accent (a deep, quiet green): primary buttons, links, focus |
| `--accent-soft`, `--accent-soft-line` | the operator's own chat bubbles |
| `--ok`, `--warn`, `--bad` | state text: running / waiting on you / failed |
| `--selection`, `--scrim` | text selection, modal backdrop |

The accent is used sparingly: one primary action per view, links and focus
rings. State is shown with coloured text, not filled badges.

## Type

- **Faces:** `--font-sans` is the system stack (-apple-system, Segoe UI
  Variable, Roboto, Inter as a fallback). `--font-mono` is for data only:
  pids, paths, readout values, code, the terminal.
- **Scale:** `--fs-xs` 11.5, `--fs-sm` 12.5, `--fs-ui` 13.5, `--fs-body` 14.5
  (chat text), `--fs-lg` 16, `--fs-xl` 18 (the bot name).
- **Line height:** `--lh-body` 1.6 for reading, `--lh-ui` 1.4 for controls.

## Spacing, radii, elevation, motion

- **Spacing:** `--sp-1..8` = 4, 8, 12, 16, 20, 24, 32 px.
- **Radii:** small and crisp. `--r-xs` 4 (code, chips), `--r-btn` 6 (buttons,
  inputs, list rows), `--r-card` 10 (bubbles, drawers, cards), `--r-sheet` 12
  (modals). No pill shapes.
- **Elevation:** tight and downward, never a halo.
  - `--shadow-1` is a 1px lift for cards, buttons and the active bot.
  - `--shadow-2` is for things that float: menus, modals, the toast.
  - Depth comes mostly from the surface tone plus a hairline.
- **Motion:** `--t-fast` 120 ms (hover and state colour), `--t-med` 200 ms (the
  toast), with `--ease`. Nothing moves on hover, and nothing is hidden behind an
  entrance animation. `prefers-reduced-motion` turns transitions off.

## Components (in `index.html`)

- **Bot row:** the chamfered stub on its left edge carries the state (running,
  waiting on you, stopped with a stale state file).
- **Header:** the bot name, then the state as text, then the Telegram chip,
  then the readouts (values in mono).
- **Chat:**
  - Operator bubbles use the soft accent and assistant bubbles are surface
    cards. Both render markdown through `md.js`.
  - A task card (a background agent or command reporting back) sits in the
    assistant lane on the page tone. It shows a status word, the summary and a
    meta line. The result is collapsed by default.
- **Phone (at most 700px wide):** the bot column becomes a top strip, the
  header wraps, and the terminal keys form an even 6-column grid.
