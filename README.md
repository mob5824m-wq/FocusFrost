# FocusFrost

**A customizable cooldown for distracting websites — with a grace window, a hard focus cap, and a pause button you have to really mean.**

FocusFrost is a Chrome extension (Manifest V3) that turns "just checking YouTube" into a deliberate decision. You get one tab, one visit, and one clock. Leaving ends the visit and starts a lockout. And because life happens, there is one escape hatch: a *pause productivity extensions* button you must press and hold for six seconds, after choosing a short, limited window.

```
 open site ──▶ grace window ──▶ focused visit ──▶ leave/close/switch away
                    │                  │                  │
              leave = free      hit the cap = close   cooldown starts
                                                              │
                                    hold 6s to pause ◀── need it for real?
```

---

## The rules, exactly

### Grace window (default 20s)

The moment a tracked page loads, a grace timer starts. If you leave and come back **inside** that window, nothing happens — no penalty, no reset. It is there so a typo, a misclick or a glance at a link does not cost you.

Leave **after** the grace window and the visit is over: the cooldown begins immediately.

### Focused visit (default cap 5 minutes)

Once grace expires, FocusFrost starts counting only while the tab is **visible and the window has focus**. Stay on the page and you get the full cap. Hit the cap and the tab closes itself — even if you were being good. This is the "short period of full attention" part: the site has a budget, not an open tab.

### Cooldown (default 10 minutes) — the part that actually works

The cooldown is a hard timestamp, not a session flag. It survives:

- closing the tab,
- navigating away and back,
- opening a brand-new tab,
- reloading,
- restarting Chrome.

Try any of them inside the cooldown and you land on the FocusFrost cooling-down page with a live countdown. There is no "just one quick look".

### You leave, it closes

Switching tabs, alt-tabbing to another app, or closing the tab after grace **immediately closes the tracked tab**. A content script reports focus loss about once a second, and the service worker independently watches `tabs.onActivated` / `windows.onFocusChanged`, so a backgrounded page cannot sneak by.

### Pause productivity extensions (hold to confirm)

When you genuinely need the site — a tutorial, a link from a colleague, an actual task — the pause is there, deliberately inconvenient:

1. **Choose a length** from your configured presets (`5 / 15 / 30` minutes by default).
2. **Press and hold** the button for a configurable duration (`6 s` by default). Release early and nothing happens.
3. The pause unlocks every tracked site for exactly that long, then re-arms itself automatically.

Pausing is rationed, because otherwise it is just a button that turns the product off:

| Limit | Default | Where |
| --- | --- | --- |
| Pauses per day | `2` | Settings → Pause |
| Minimum gap between pauses | `30 min` | Settings → Pause |
| Allowed lengths | only your presets | Settings → Pause (strict mode) |

Starting a pause also ends any live lockout — that is the price: your cooldown does not come back afterwards.

---

## Install it

1. Download or clone this repo.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.
4. The settings page opens on first install. Add the sites that eat your day.

Works on Chrome 110+ and any Chromium browser with MV3 (`edge://extensions`, `brave://extensions`, …).

## Try it without installing

A live sandbox runs the **real** `background.js`, the real engine and the real pages against a fake browser, so you can watch the rules play out:

```bash
node demo/server.js          # http://localhost:4173
```

Inside the sandbox you get a fake browser with tabs you can open, leave, return to and close, a time-travel control (so you never wait ten real minutes for a cooldown), a live view of the service worker's state, and the actual toolbar popup embedded alongside. See [`demo/README.md`](demo/README.md).

---

## Using it

| Surface | What it does |
| --- | --- |
| **Popup** (toolbar) | Live state — grace, focus countdown, cooldown, pause — plus the hold-to-pause button and per-site status. |
| **On-page chip** | A small frosty pill bottom-right with the current clock. Click to collapse it to a dot. |
| **Blocked page** | The cooling-down wall, with a live countdown and the pause panel. |
| **Options** | Add/remove sites, tune cooldown / grace / cap per site, set pause policy, maintenance. |
| **Dashboard** | Today's metrics, per-site focus time, live engine state, and a rules sandbox. |

### Settings that matter

- **Cooldown** — how long a broken visit costs you. 10 seconds to 24 hours.
- **Grace window** — free time at the start of a visit. `0` means leaving immediately locks the site.
- **Focus cap** — how much focused time one visit may use.
- **Close on blur / one tab only** — the two enforcement behaviours. Both on by default.
- **Hold duration** — 3–10 seconds.
- **Pauses per day / minimum gap** — set `0` per day to disable pausing entirely.

Everything is clamped on the way in, so a hand-edited or synced settings blob can never turn a 10-minute cooldown into a 10-day one.

---

## How it is built

```
extension/
  manifest.json          MV3 manifest
  background.js          service worker: navigation guards, focus watcher, pause clock
  content.js             focus reporter + the on-page chip
  shared/
    util.js              durations, day keys, domain normalisation
    config.js            settings schema, defaults, clamping
    engine.js            ← the whole policy, pure and testable
  popup/                 live state + hold-to-pause
  options/               site manager and policy
  blocked/               the cooling-down page
  dashboard/             metrics + rules sandbox
demo/                    the fake-browser harness (not shipped)
tests/                   engine + worker tests
```

The design rule: **`engine.js` never touches a `chrome.*` API.** It takes a state object and a settings object and returns a decision (`allow`, `block`, `close`). That means the whole ruleset — grace, caps, cooldowns, pause rationing, day rollover — is unit tested, and the service worker is only plumbing: read state, call the engine, apply the result.

State lives in `chrome.storage.local`; settings are mirrored to `chrome.storage.sync`. Nothing leaves your browser: no accounts, no analytics, no network requests (the only external fetches are favicons on your own settings page).

### Tests

```bash
node --test tests/*.test.js      # 29 tests, no dependencies
```

- `tests/engine.test.js` — the policy in isolation: grace edge cases, cap enforcement, cooldown arithmetic, pause rationing, clamping, corrupt-state repair.
- `tests/worker.test.js` — the **real** `background.js` booted in a VM against a fake `chrome` API: navigations, second tabs, tab closes, window focus loss, content-script ports, settings round-trips.

### Permissions, and why

| Permission | Reason |
| --- | --- |
| `storage` | settings + state |
| `tabs` | detect activation, close tabs, read the active URL |
| `webNavigation` | catch a navigation to a tracked site *before* it renders |
| `alarms` | keep the pause clock and cooldowns ticking while the worker sleeps |
| `notifications` | tell you why the tab closed |
| `http://*/*`, `https://*/*` | the content script has to run on the sites you choose to track |

FocusFrost does not read page content. The content script reports one thing per second — "is this tab visible and focused" — plus the hostname.

## Limitations

- Cooldowns are timestamps, not cryptographic seals. Anyone who can open `chrome://extensions` can uninstall the extension; that is deliberate — this is a tool for people who want the friction, not DRM.
- A tracked site opened in a Private window in a different profile is out of scope.
- Tracked sites are matched by domain (subdomains included). Path-level rules are not supported.
- Only the top-level frame is tracked.

## License

MIT — see [LICENSE](LICENSE).
