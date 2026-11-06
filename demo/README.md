# The FocusFrost sandbox

A fake browser you can drive, wrapped around the **real** extension.

The point of this folder is honesty: it does not re-implement the rules. `preview.js` fakes just enough of the `chrome.*` API for the production `background.js` to boot unchanged, then the sandbox gives it tabs to police. Every grace window, cooldown and pause limit you see here comes from `extension/shared/engine.js` — the same file the installed extension runs.

```bash
node demo/server.js
# → http://localhost:4173
```

No dependencies, no build step. `PORT=8080 node demo/server.js` if 4173 is taken.

## What you get

```
┌────────────────────────────────────────────────┬───────────────────────┐
│ fake browser                                   │ service worker        │
│  tab strip · the page · the on-page chip       │  live per-site state  │
│  open / leave / return / close                 ├───────────────────────┤
│  time travel: +10s +1m +5m +30m +2h            │ the real popup        │
│                                                ├───────────────────────┤
│                                                │ event log             │
└────────────────────────────────────────────────┴───────────────────────┘
```

- **The real content script** is injected into each simulated page, so the on-page countdown chip is the production chip.
- **The real popup** is embedded on the right and talks to the same worker, so the hold-to-pause button in the panel affects the tab you are driving.
- **Time travel** advances a virtual clock (the harness patches `Date.now` inside the worker's world), which is how you can watch a ten-minute cooldown expire in a second. Cooldown and pause deadlines are absolute timestamps, so they shrink correctly.
- **The event log** records everything the worker did: redirects, tab closes, notifications, clock jumps.

## A 60-second tour

1. **Open** `youtube.com`. The chip appears bottom-right with a 20s grace countdown.
2. **Leave tab**, then **Return** quickly — you are back on the same visit for free.
3. **+1m**, then **Leave tab**. The tab is closed instantly and YouTube starts cooling down.
4. **Open** it again: you land on the cooling-down page with the real countdown.
5. **+30m** (or use the pause button in the popup): the site opens again.

## Files

| File | Role |
| --- | --- |
| `server.js` | Zero-dependency static server. Serves `extension/` and `demo/`, and injects the harness into extension pages. |
| `preview.js` | The fake `chrome.*`, the fake browser kernel, and the iframe bridge. Also boots `background.js`. |
| `sandbox.html` / `sandbox.js` / `sandbox.css` | The sandbox UI. |
| `site.html` | A neutral stand-in page (no internet needed) that loads the real content script. |

## Caveats

- It is a simulation: no real network, no real site content, and "focus" is a flag the sandbox flips rather than your operating system.
- The popup/options/dashboard also run standalone here (they behave as if opened as tabs), which is handy for screenshots.
- Only for development and demos. It is not included in the shipped extension.
