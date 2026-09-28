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
  the viewer picks it. The sidebar's "Theme" row cycles auto, light, dark.
- The viewer's choice is stored in `localStorage` (`cockpit.theme`). Every
  access is wrapped in try/catch, so blocked storage just falls back to auto.
- `theme.js` sets `html[data-theme]` before first paint. The dark values are
  declared twice: once under the media query (guarded by
  `:not([data-theme="light"])`) and once for `[data-theme="dark"]`.

## Colour roles

| token | light | dark | role |
|---|---|---|---|
| `--bg` | #F9FBF8 | #141816 | the page |
| `--side` | #EAF1EB | #101412 | the bot column (a green step off the page) |
| `--surface` | #FFFFFF | #1E2521 | cards, assistant bubbles, menus, modals, buttons |
| `--field` | #FBFCFB | #171C19 | inputs, code |
| `--task` | #F3F7F3 | #19201C | task cards, approval cards in the sheet |
| `--hover` | text at 5.5% | text at 6% | hover and selected rows |
| `--line` / `--line-strong` | #DFE6DF / #C9D1C8 | #2C3530 / #3D4841 | hairlines; strong = inputs, buttons, chips |
| `--text` / `-2` / `-3` | #17201B / #4C5A52 / #7F8A83 | #EAEFEB / #B1BCB5 / #7F8B83 | primary, secondary, meta |
| `--sent` / `-line` | #ECF3F5 / #CFDFE3 | #1A2527 / #2B3C3F | a reply the bot sent on Telegram |
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
  (chat text), `--fs-lg` 16, `--fs-xl` 21 (the bot name).
- **Icons:** one hand-drawn set, inline `<symbol>`s at the top of
  `index.html` (16px grid, 1.5 stroke in `currentColor`, round caps, one
  solid part each). An icon sits bare beside its label, never in a tile.
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
- **Sidebar nav:** icon + label rows (Approvals, Usage, Updates, then New
  chat, Guide, Theme). Approvals with anything pending turns `--warn-soft`
  with a `--warn-line` inset edge and a mono count; on a phone the rows
  become one scrolling strip.
- **Header:** the bot name, then the state as text, then the Telegram chip,
  then the readouts (values in mono), over a `--line` hairline. Context is a
  96x6 bar (fill `--accent`, `--warn` from 75%, `--bad` from 90%) with the
  percent and used / ceiling. The account shows its registered label; the
  token's last 4 are in the tooltip only.
- **Lifecycle:** a background bot shows Restart, plus Start (primary) while
  stopped; never Stop. A pty bot shows Stop and Restart, or Start.
  `cards.js` decides; buttons not offered are hidden, not disabled.
- **Buttons:** `--r-btn`, weight 600. Primary = accent fill; secondary =
  surface + `--line-strong`. Disabled, in every variant: transparent,
  `--text-3`, a dashed `--line-strong` border, no shadow.
- **Notices:** the attention bar ("N things need you", above the header, every
  bot) is a full `--warn-line` hairline around a `--warn-soft` fill (no left
  accent bar); it turns `--bad-soft` / `--bad-line` when any item is bad, and
  a tap opens the attention sheet. A blocked bot's detail lives in the header
  state's tooltip. The session-exit bar is the same shape in `--bad-soft` /
  `--bad-line`.
- **Sheets** (attention, approvals, usage): modals on desktop; on a phone they
  dock to the bottom edge, full width, at most 88dvh, top corners `--r-card`.
  - An attention item carries a 16px `--stub` mark (warn or bad) beside its
    kind label, never a full-height bar, then one action and one quiet action.
  - An approval card sits on `--task`: the stamp icon and the request as a
    title, "Widens: <what>." with one plain sentence, the exact change in a
    mono `--field` box (a bulk append collapses to "show all N"), who asked,
    then Approve (primary) and Decline (quiet). "Decided" rows below say
    "approved by <b>who</b>" with the decision as a coloured `.out` word.
  - A usage meter is a 6px `--line` track with a fill in `--text-2`, `--warn`
    from 75% or `--bad` from 90% (the header readouts' `level()`); the value and reset time are mono. Accounts group
    their bots.
  - Switch account: a quiet "Switch account" under a bot's meters opens a
    picker on `--task` (`.cap` rows: the account, its masked token, the bots
    already on it with their 5 h / 7 d, and Use); the bot's own token is the
    last row. A switch not yet landed is a `--warn` text line, "switching to
    <id> at next idle", never a badge.
- **Operator token:** a 403 `need: approve-token` opens the token modal once;
  the token is kept in `sessionStorage` and sent as `X-Approve-Token`.
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
  - Telegram: an inbound message is an operator bubble whose meta line
    carries the paper-plane icon, the sender in `--text` and the time. A reply
    the bot sent there is a `--sent` bubble in the assistant lane, "Sent on
    Telegram · time", text only.
  - A pending approval for this bot is the same card as the sheet's, on
    `--warn-soft` / `--warn-line`, always last in the chat.
  - Composer: a quiet paperclip button left of the input; the input grows
    from one line to eight, then scrolls. Files attached from the cockpit are
    chips in a row above the input and inside the sent bubble: `--surface`,
    `--line-strong`, `--r-btn`, 36px tall with the name (600) and a mono size;
    an image is a 64px `object-fit: cover` thumbnail instead. A composer chip
    ends in a × (on a thumbnail, a small surface square in its corner).
- **Terminal:** the xterm screen is an unpadded box inside the padded `#term`
  (the fit addon sizes to its parent's full height, padding included), refitted by a
  ResizeObserver, so the last row always ends above the key row.
- **Drawers** (Overview, Telegram access, Secrets, Activity, Automations and
  tools): a tab row with the active tab on `--surface`; the drawer floats on
  `--shadow-2` (no border) and opens with its title and one `--text-2` line on
  what it is for. Raw state sits behind a quiet disclosure. Run outcomes are coloured words: sent/exit 0
  `--ok`, skipped `--warn`, failed `--bad`.
- **Capabilities:** a two-way seg (Automations, Tools) over `.cap` rows: the
  name, a state word (`.out`: enabled `--ok`, paused `--warn`, missing
  `--bad`), a `--text-2` meta line (paths mono), and at most one secondary
  action plus a quiet one. A failure streak of 3 or more is `--bad` text.
  Retire asks `confirm()` first.
- **States:** loading is a `.loading` line in `--text-3`; an error is an
  `.errbox` (`--bad-soft` fill, `--bad-line` hairline); an empty list or chat
  is an `.empty` / `.cempty` line saying what to do next.
- **Phone (at most 700px wide):** the bot column becomes a top strip, the
  header wraps, and the terminal keys form an even 6-column grid. Sheets dock
  to the bottom; every button in a sheet, modal or drawer is at least 44px
  tall, and action rows become an even grid.
