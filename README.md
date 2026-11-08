# FocusFrost

**Friction before, consequences after.** A customizable cooldown for distracting websites — with an intervention screen you have to sit through, a grace window, a hard focus cap, focus hours, and a pause button you have to really mean.

FocusFrost is a Chrome extension (Manifest V3) that turns "just checking YouTube" into a deliberate decision. It combines two ideas that work better together:

- **Friction before entry** ([one-sec](https://one-sec.app/)-style): before a tracked site loads, you get a full intervention screen — a breath, 4-7-8 breathing, a couple of honest questions, a phrase to retype, or a line stating what you came for.
- **Consequences after** (FocusFrost-style): once you are through, you get one visit, one clock and one hard cooldown. Leave, switch tabs or hit the cap and the site is shut until the timer runs out.

One-sec's own research is the reason for the pairing: a pause in front of the app cuts openings by about half, but a "continue anyway" button with no cost behind it is a reminder, not a barrier. And the friction wears off within a couple of weeks. So FocusFrost randomises the intervention, adds a second look after N minutes of scrolling, and keeps the cooldown as the thing that actually costs you.

```
          ┌── breathe · reflect · type a phrase · state your intention ──┐
          ▼                                                              │
 open site ──▶ INTERVENTION ──▶ grace window ──▶ focused visit ──▶ leave/close/switch away
                    │                  │                │                   │
              close = counted    leave = free    hit the cap = close   cooldown starts
                                                                             │
                                                hold 6s to pause ◀── need it for real?
```

---

## The rules, exactly

### The intervention screen (on by default)

A tracked URL never loads straight away. The tab is redirected to a full-page gate that is part of the extension, not a popup:

| Intervention | What it asks you to do |
| --- | --- |
| **Deep breath** | Follow a paced breath for at least a configurable 3–60 seconds. |
| **4-7-8 breathing** | In for 4, hold for 7, out for 8 — repeated. Slower, and harder to rush. |
| **Reflect** | Three quick questions — why you are here, whether you need it or want it, how long you plan to stay — then a line of your own words. |
| **Type a phrase** | Retype a randomly chosen sentence — the friction one-sec uses to make the pause unavoidable. |
| **State your intention** | One line: what you came for. It is logged, and that log is the most interesting page in the settings. |

Underneath every intervention is an **"or do this instead"** line you write yourself (defaults to something better than scrolling), and the **close the tab** button is the visually primary choice. Continuing is possible — that is the point; the friction should be honest, not a maze.

### The doomscroll brake

Optionally, the gate comes back **mid-visit** after N seconds of focused scrolling (off by default; set it in the Friction section in 30-second steps). Finish it and you stay; close it and the visit ends and the cooldown starts. This is the part a single-entry pause cannot do.

### Breathing out of a cooldown

When a site is locked, the cooling-down page offers a **breathing exercise** instead of a wall. Finish the cycle (a breath in, a hold, a breath out — repeated to your configured minimum) and the site opens for a short window.

It is not free. **Finishing the breath spends one of the day's pauses**, from the same rationed ledger as the hold-to-pause button: same daily cap, same minimum gap. If you are out of pauses, the page says so plainly rather than offering a ritual that cannot open anything. The 6-second hold button stays alongside it, so there are two ways through and both cost the same thing.

That is deliberate. A cooldown you can always breathe your way past is not a cooldown — it is a speed bump with a nice animation. Breathe, and it costs you a pause you cannot spend again today.

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

### Focus hours (hard blocks, independent of cooldowns)

Windows you define per weekday — *Deep work, 09:00–12:00, Mon–Fri* — block every tracked site outright, with no grace window and no intervention. Windows may cross midnight (23:00–06:00 works), and they are checked on navigation *and* against visits that are already running, so starting work does not require closing anything yourself. A pause can override focus hours, but only if you allow it per window.

### Pause productivity extensions (hold to confirm)

When you genuinely need the site — a tutorial, a link from a colleague, an actual task — the pause is there, deliberately inconvenient:

1. **Choose a length** from your configured presets (`5 / 15 / 30` minutes by default).
2. **Press and hold** the button for a configurable duration (`6 s` by default). Release early and nothing happens.
3. The pause unlocks every tracked site for exactly that long, then re-arms itself automatically.

The same gesture guards every destructive action: clearing all locks on the dashboard is a hold too, not a click. It lives in one place (`shared/hold.js`), so the popup, the cooling-down page and the dashboard cannot drift apart.

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
4. The settings page opens on first install. Add the sites that eat your day, then pick the intervention you want between you and them.

Works on Chrome 110+ and any Chromium browser with MV3 (`edge://extensions`, `brave://extensions`, …). The settings page also works as a plain web page in any modern browser when served by the sandbox below.

## Try it without installing

A live sandbox runs the **real** `background.js`, the real engine and the real pages against a fake browser, so you can watch the rules play out:

```bash
node demo/server.js          # http://localhost:4173
```

Inside the sandbox you get a fake browser with tabs you can open, leave, return to and close, the **real intervention gate and blocked page** rendered in the viewport, a time-travel control (so you never wait ten real minutes for a cooldown), a live view of the service worker's state, the actual toolbar popup embedded alongside, and a *Settings page →* link to the real settings app. See [`demo/README.md`](demo/README.md).

---

## Using it

| Surface | What it does |
| --- | --- |
| **Popup** (toolbar) | Live state — grace, focus countdown, cooldown, pause — plus the hold-to-pause button and per-site status. |
| **On-page chip** | A small frosty pill bottom-right with the current clock. Click – to collapse it to a dot; it stays collapsed (remembered per site, across reloads) until you click it. |
| **Blocked page** | The cooling-down wall: live countdown, the breathing exercise, and the hold-to-pause panel. |
| **Settings (full page)** | The dedicated settings web app — see below. |
| **Dashboard** | Today's metrics, per-site focus time, live engine state, hold-to-confirm "clear all locks", and a rules sandbox. |

### The settings page

Settings are not crammed into the popup. The popup shows state and links out; **Settings** opens its own full-page app (`extension/options/options.html`) with a sidebar and nine sections:

| Section | What lives there |
| --- | --- |
| **Overview** | The three layers of the design, live, with today's numbers. |
| **Sites** | Which domains are tracked, with per-site cooldown / grace / cap. |
| **Friction** | Intervention type, duration, "do this instead", required intention, the doomscroll brake. |
| **Guardrails** | Close on blur, one tab only, the on-page chip, notifications. |
| **Focus hours** | Weekday windows that block outright. |
| **Pause** | Hold duration, allowed lengths, pauses per day, minimum gap. |
| **Intentions** | The log: what you said you came for, and what you walked away from. |
| **Pages** | Previews of the intervention screen, blocked page and on-page chip. |
| **Advanced** | Export / import JSON, presets (gentle / strict / lockdown), factory reset. |

Everything autosaves 260 ms after you stop typing or dragging — there is no Save button to forget — and the sidebar status is live, so you can watch it change.

### Settings that matter

- **Cooldown** — how long a broken visit costs you. 10 seconds to 24 hours.
- **Grace window** — free time at the start of a visit. `0` means leaving immediately locks the site.
- **Focus cap** — how much focused time one visit may use.
- **Close on blur / one tab only** — the two enforcement behaviours. Both on by default.
- **Hold duration** — 3–10 seconds.
- **Pauses per day / minimum gap** — set `0` per day to disable pausing entirely.
- **Intervention type and length** — including turning the gate off entirely for a pure-cooldown setup.
- **Re-intervention** — how many minutes of focused scrolling earn a second look.
- **Breathing on the cooldown page** — on by default; the window it buys is configurable, and strict pause mode rounds it to an allowed length.

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
    hold.js              press-and-hold gesture, shared by every page
  intervention/          the full-page gate: breathe, reflect, type, intend
  popup/                 live state + hold-to-pause
  options/               the dedicated settings app (app-core/sections/app + CSS)
  blocked/               the cooling-down page
  dashboard/             metrics + rules sandbox, including the gate
demo/                    the fake-browser harness (not shipped)
tests/                   engine + worker tests
```

The design rule: **`engine.js` never touches a `chrome.*` API.** It takes a state object and a settings object and returns a decision (`allow`, `intervene`, `block`, `close`). That means the whole ruleset — interventions, focus hours, grace, caps, cooldowns, pause rationing, day rollover — is unit tested, and the service worker is only plumbing: read state, call the engine, apply the result.

State lives in `chrome.storage.local`; settings are mirrored to `chrome.storage.sync`. Nothing leaves your browser: no accounts, no analytics, no network requests (the only external fetches are favicons on your own settings page).

### Tests

```bash
node --test tests/*.test.js      # 122 tests, no dependencies
```

- `tests/engine.test.js` — the policy in isolation: grace edge cases, cap enforcement, cooldown arithmetic, pause rationing, clamping, corrupt-state repair.
- `tests/intervention.test.js` — the gate: intervention vs. cooldown precedence, intentions and walk-aways, the log cap, the doomscroll brake, focus hours (including overnight windows, day lists and pauses), config clamping.
- `tests/worker.test.js` — the **real** `background.js` booted in a VM against a fake `chrome` API: navigations, second tabs, tab closes, window focus loss, content-script ports, settings round-trips, and the gate end to end (one pass per tab, no redirect loop, walk-aways, focus hours).
- `tests/hold.test.js` — the press-and-hold gesture: full duration required, every release path aborts, a click never completes, and each page actually uses the shared controller.
- `tests/release.test.js` — the version staying in sync across files, Chrome-rejected version formats, and the packaged zip (valid archive, manifest at the root, reproducible bytes, refuses to build a broken tree).

### Permissions, and why

| Permission | Reason |
| --- | --- |
| `storage` | settings + state |
| `tabs` | detect activation, close tabs, read the active URL |
| `webNavigation` | catch a navigation to a tracked site *before* it renders |
| `alarms` | keep the pause clock and cooldowns ticking while the worker sleeps |
| `notifications` | tell you why the tab closed |
| `http://*/*`, `https://*/*` | the content script has to run on the sites you choose to track |

No camera, microphone or history permission: the "mirror" style interventions some apps use are deliberately not implemented — everything here happens on one page, with text.

FocusFrost does not read page content. The content script reports one thing per second — "is this tab visible and focused" — plus the hostname.

## Limitations

- Cooldowns are timestamps, not cryptographic seals. Anyone who can open `chrome://extensions` can uninstall the extension; that is deliberate — this is a tool for people who want the friction, not DRM.
- A tracked site opened in a Private window in a different profile is out of scope.
- Tracked sites are matched by domain (subdomains included). Path-level rules are not supported.
- Only the top-level frame is tracked.

## Releases

Versions are tagged `vMAJOR.MINOR.PATCH` and published as a built zip on the
[releases page](https://github.com/mob5824m-wq/FocusFrost/releases). Merging a
version-bump pull request *is* the release: the workflow tags the merge commit,
rebuilds the extension from a clean checkout, verifies the manifest inside the
archive, and attaches `focusfrost-<version>.zip` with a SHA-256 checksum.

```bash
npm run zip              # build dist/focusfrost-<version>.zip yourself
npm run version:check    # assert package.json and manifest.json agree
npm test                 # includes tests for the release tooling
```

See [RELEASING.md](RELEASING.md) for the full process, including why the archive
is reproducible.

## License

MIT — see [LICENSE](LICENSE).
