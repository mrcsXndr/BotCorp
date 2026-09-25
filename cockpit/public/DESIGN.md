# Cockpit design system: "Quiet Sage"

The cockpit's look comes from one set of CSS custom properties in
`tokens.css`, which every cockpit page links (`index.html`, `guide.html`).
Components use tokens only: no raw colours, sizes or radii in component rules
or in `app.js`. The terminal stays dark in both themes because it is the TUI's
own surface; its colours are tokens too (`--term-*`), and `app.js` reads them
when it builds the xterm theme.

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

| token | light | dark | role |
|---|---|---|---|
| `--bg` | #F7F8F6 | #121513 | the page |
| `--side` | #EEF1EC | #0E110F | the bot column |
| `--surface` | #FFFFFF | #1A1F1C | cards, assistant bubbles, menus, modals, buttons |
| `--field` | #FBFCFB | #151916 | inputs, code |
| `--task` | #F7F8F6 | #121513 | task cards (on the page tone) |
| `--hover` | text at 5% | text at 5% | hover and selected rows |
| `--line` / `--line-strong` | #DDE3DC / #C9D1C8 | #29302B / #38413B | hairlines; strong = inputs, buttons, chips |
| `--text` / `-2` / `-3` | #1C2320 / #56625B / #7F8A83 | #E4E9E5 / #A3AEA7 / #76817A | primary, secondary, meta |
| `--accent` / `--accent-ink` | #2E6A54 / #FFFFFF | #8FC4AB / #0E1A14 | the one accent: primary buttons, links, focus |
| `--accent-soft` / `-line` | #E4EEE8 / #C8DBD0 | #1E2C25 / #2C4338 | the operator's own bubbles |
| `--ok` | #2A7A4B | #7FD19B | running, sent |
| `--warn` / `-soft` / `-line` | #9A5B00 / #FFF7E8 / #EBCB93 | #E6B35C / #241E14 / #5A4623 | waiting on you, skipped |
| `--bad` / `-soft` / `-line` | #B3261E / #FCEEEC / #EBB8B3 | #F08A80 / #2A1715 / #5C2F2A | down, failed, errors |
| `--selection`, `--scrim` | | | text selection, modal backdrop |
| `--term-bg/fg/cursor/selection` | dark in both | | the terminal |

The accent is used sparingly: one primary action per view, links and focus
rings. State is shown with coloured text or the bot-row stub, not filled
badges. `--text-3` is for meta only (timestamps, counts); sentences and hints
use `--text-2`, which keeps readable contrast on every surface.

## Type

- **Faces:** `--font-sans` is the system UI stack. `--font-mono` is for numbers
  and code only: pids, readout values, sizes, run times, code, the terminal.
- **Scale:** `--fs-xs` 11.5, `--fs-sm` 12.5, `--fs-ui` 13.5, `--fs-body` 14.5
  (chat text), `--fs-lg` 16, `--fs-xl` 18 (the bot name).
- **Line height:** `--lh-body` 1.6 for reading, `--lh-ui` 1.4 for controls.

## Spacing, radii, elevation, motion

- **Spacing:** `--sp-1..8` = 4, 8, 12, 16, 20, 24, 32 px.
- **Radii:** `--r-xs` 4 (chips, code), `--r-btn` 6 (buttons, inputs, list rows,
  notices), `--r-card` 10 (bubbles, drawers, cards, modals). No pills.
- **Elevation:** tight and downward, never a halo.
  - `--shadow-1` (light: `0 1px 2px` at 7%; dark: a 1px black underline) for
    cards, buttons and the active bot.
  - `--shadow-2` is for things that float: menus, modals, the toast.
- **Motion:** `--t-fast` 120 ms (hover and state colour), `--t-med` 200 ms (the
  toast), with `--ease`. Nothing moves on hover, and nothing is hidden behind an
  entrance animation. `prefers-reduced-motion` turns transitions off.

## Components (in `index.html`)

- **Bot row:** the signature. A chamfered stub (`--stub` clip-path) on the
  row's left edge carries the state: `--ok` running, `--warn` waiting on you,
  `--bad` down, `--text-3` stopped.
- **Header:** the bot name, then the state as text, then the Telegram chip,
  then the readouts (values in mono), over a `--line` hairline.
- **Buttons:** `--r-btn`, weight 600. Primary = accent fill; secondary =
  surface + `--line-strong`. Disabled, in every variant: transparent,
  `--text-3`, a dashed `--line-strong` border, no shadow.
- **Notices:** the "waiting on you" bar is a full `--warn-line` hairline around
  a `--warn-soft` fill (no left accent bar). The session-exit bar is the same
  shape in `--bad-soft` / `--bad-line`.
- **Chat:**
  - Operator bubbles use the soft accent; assistant bubbles are surface cards.
    Both render markdown through `md.js` (the only `innerHTML` source for
    transcript text).
  - An attachment from a channel (voice note, photo, file) is a labelled line
    in the operator bubble: "Voice note 0:12", "File report.pdf · 240 KB". The
    server sends labels only, never a path or a file id. A voice note's
    transcript (the bot's own transcriber output) is added under it with a
    "Transcript" label.
  - A task card (a background agent or command reporting back) sits in the
    assistant lane on `--task`. It shows a status word, the summary and a meta
    line; the result is collapsed by default.
- **Drawers** (details, pairing, vault, runs): a tab row with the active tab on
  `--surface`. Run outcomes are coloured words: sent/exit 0 `--ok`, skipped
  `--warn`, failed `--bad`.
- **States:** loading is a `.loading` line in `--text-3`; an error is an
  `.errbox` (`--bad-soft` fill, `--bad-line` hairline); an empty list or chat
  is an `.empty` / `.cempty` line saying what to do next.
- **Phone (at most 700px wide):** the bot column becomes a top strip, the
  header wraps, and the terminal keys form an even 6-column grid.
