# The FocusFrost sandbox

A fake browser you can drive, wrapped around the **real** extension.

The point of this folder is honesty: it does not re-implement the rules. `preview.js` fakes just enough of the `chrome.*` API for the production `background.js` to boot unchanged, then the sandbox gives it tabs to police. Every intervention gate, grace window, cooldown, focus hour and pause limit you see here comes from `extension/shared/engine.js` — the same file the installed extension runs.

That includes the pages. When the worker redirects a tab, the sandbox renders the **real** `intervention/intervention.html` or `blocked/blocked.html` in the viewport, so you can breathe through the actual gate.

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
│  the real intervention gate and blocked page   ├───────────────────────┤
│  open / leave / return / close                 │ the real popup        │
│  time travel: +10s +1m +5m +30m +2h            ├───────────────────────┤
│                                                ├───────────────────────┤
│                                                │ event log             │
└────────────────────────────────────────────────┴───────────────────────┘
```

- **The real content script** is injected into each simulated page, so the on-page countdown chip is the production chip.
- **The real intervention page** is where you land first. The gate is a real page with a real breath timer; when it finishes, the harness forwards the `interventionDone` message to the worker just as Chrome would, and the worker grants the one-visit pass.
- **The real settings page** opens from *Settings page →* in the sandbox toolbar (or directly at `/extension/options/options.html`). It autosaves to the same worker, so changes made there immediately change what happens in the fake browser.
- **The real popup** is embedded on the right and talks to the same worker, so the hold-to-pause button in the panel affects the tab you are driving.
- **Time travel** advances a virtual clock (the harness patches `Date.now` inside the worker's world), which is how you can watch a ten-minute cooldown expire in a second. Cooldown and pause deadlines are absolute timestamps, so they shrink correctly.
- **The event log** records everything the worker did: redirects, tab closes, notifications, clock jumps.

## A 60-second tour

1. **Open** `youtube.com`. You land on the **intervention gate** — the seeded sandbox uses a 4-second breath so you do not have to wait long.
2. **Get through it.** Either *Close the tab* (counted as a walk-away) or continue with an intention. Only then does the chip appear with a 20s grace countdown.
3. **Leave tab**, then **Return** quickly — you are back on the same visit for free.
4. **+1m**, then **Leave tab**. The tab is closed instantly and YouTube starts cooling down.
5. **Open** it again: you land on the cooling-down page with the real countdown. The gate does not get you out of a cooldown.
6. **+30m** (or use the pause button in the popup): the gate is back, and clearing it opens the site.

Try **Settings page →** to turn the gate off, switch to 4-7-8 breathing, add a focus window that spans the whole day, or ration pauses to zero — the fake browser reacts on your next click.

## Files

| File | Role |
| --- | --- |
| `server.js` | Zero-dependency static server. Serves `extension/` and `demo/`, and injects the harness (`window.__FF_DEMO` + `preview.js`) as the first thing in every extension page. |
| `preview.js` | The fake `chrome.*`, the fake browser kernel, and the iframe bridge. Also boots `background.js`. |
| `sandbox.html` / `sandbox.js` / `sandbox.css` | The sandbox UI. |
| `site.html` | A neutral stand-in page (no internet needed) that loads the real content script. |

## Caveats

- It is a simulation: no real network, no real site content, and "focus" is a flag the sandbox flips rather than your operating system.
- The popup/settings/dashboard also run standalone here (they behave as if opened as tabs), which is handy for screenshots.
- Extension pages hand navigation back to the sandbox through `window.parent.__FF_DEMO_NAV__`; in Chrome they call `location.replace`. That is the only demo-specific branch in product code, and it is inert outside the sandbox.
- Only for development and demos. It is not included in the shipped extension.
