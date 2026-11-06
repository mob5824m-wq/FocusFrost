/**
 * FocusFrost — content script.
 *
 * Lives on tracked sites. It
 *   - reports focus state once a second (the service worker owns the policy),
 *   - renders the floating "mode chip" with the focus / grace / pause timers,
 *   - never makes a blocking decision on its own; the worker can close the tab.
 */
(async function focusfrostContent() {
  'use strict';

  const host = location.hostname;
  const origin = location.origin;
  // Frames only report; the top frame renders and acts. The attribute check
  // exists so the ruleset can be previewed in a framed sandbox.
  const isTop = window.top === window || document.documentElement.dataset.ffTop === 'true';

  let port = null;
  let dead = false;
  let siteCfg = null;
  let behavior = { showChip: true };
  let session = null;
  let pause = null;
  let graceRemaining = 0;
  let inGrace = false;
  let paused = false;
  let lastPayload = null;
  let chip = null;
  // A site you have switched off is still tracked; the chip says so instead of
  // implying FocusFrost is watching a site it will never enforce on.
  let standDown = false;
  // Collapsing the chip is the user's decision, so it has to outlive the next
  // tick — and a service-worker restart, which tears this script down and runs
  // it again. Kept per site, so YouTube and Reddit remember separately.
  const COLLAPSE_KEY = 'ff_chip_collapsed';
  let collapsed = false;
  let collapseKnown = false;

  /**
   * Read the remembered collapsed state once. Storage is async, so anything
   * rendered before it lands has to be corrected afterwards.
   */
  function loadCollapsed() {
    if (collapseKnown) return Promise.resolve();
    collapseKnown = true;
    try {
      const res = chrome.storage.local.get(COLLAPSE_KEY);
      if (!res || typeof res.then !== 'function') return Promise.resolve();
      return res
        .then((all) => {
          const map = (all && all[COLLAPSE_KEY]) || {};
          collapsed = map[host] === true;
          applyCollapsed();
        })
        .catch(() => {});
    } catch (_) {
      return Promise.resolve();
    }
  }

  function rememberCollapsed(value) {
    try {
      const res = chrome.storage.local.get(COLLAPSE_KEY);
      if (!res || typeof res.then !== 'function') return;
      res
        .then((all) => {
          const map = Object.assign({}, (all && all[COLLAPSE_KEY]) || {});
          if (value) map[host] = true;
          else delete map[host];
          return chrome.storage.local.set({ [COLLAPSE_KEY]: map });
        })
        .catch(() => {});
    } catch (_) {
      /* storage is a nicety here; the chip still works this session */
    }
  }

  function applyCollapsed() {
    if (!chip || !chip.node) return;
    chip.collapsed = collapsed;
    chip.node.classList.toggle('min', collapsed);
    // A collapsed chip is a dot: say what it is when you hover it.
    chip.node.title = collapsed ? 'FocusFrost — click to expand' : '';
  }

  function connect() {
    if (dead) return;
    try {
      port = chrome.runtime.connect({ name: 'focusfrost' });
    } catch (_) {
      return; // extension was reloaded / removed
    }
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      // Service worker went to sleep. Reconnect on the next beat.
      setTimeout(connect, 1200);
    });
    safePost({ type: 'hello', host, href: location.href });
  }

  function safePost(msg) {
    if (!port) return;
    try {
      port.postMessage(msg);
    } catch (_) {
      port = null;
    }
  }

  function onMessage(msg) {
    if (!msg || !msg.type) return;

    if (msg.type === 'verdict') {
      if (msg.action === 'block') {
        dead = true;
        return; // the worker is redirecting the tab
      }
      siteCfg = msg.siteCfg || siteCfg;
      behavior = Object.assign({ showChip: true }, msg.behavior || behavior);
      standDown = msg.reason === 'disabled';
      session = msg.session || null;
      pause = msg.pause || pause;
      // Only an explicit "switched off" hides the chip. An untracked verdict
      // carries no `enabled` field at all and must keep drawing it: that is
      // how you can tell FocusFrost is running on a site it does not police.
      // Reading the missing field as "off" made the chip vanish on those pages.
      if (msg.enabled === false) {
        teardown();
        return;
      }
      render();
      return;
    }

    if (msg.type === 'tick') {
      session = msg.session || session;
      inGrace = !!msg.inGrace;
      graceRemaining = msg.graceRemaining || 0;
      paused = !!msg.paused;
      pause = msg.pause || pause;
      render();
      return;
    }

    if (msg.type === 'pause') {
      pause = msg.pause || pause;
      render();
      return;
    }

    if (msg.type === 'closed' || msg.type === 'blocked') {
      // The worker is closing us or moving us to a gate/blocked page.
      dead = true;
      teardown();
    }
  }

  /* ---------------- focus reporting ---------------- */

  function isFocused() {
    return document.visibilityState === 'visible' && document.hasFocus();
  }

  let lastBeat = 0;
  function beat(force) {
    const now = Date.now();
    if (!force && now - lastBeat < 1000) return;
    lastBeat = now;
    if (!port) connect();
    else safePost({ type: 'heartbeat', host, focused: isFocused() });
  }

  // Anything that looks like leaving is reported immediately so the worker can
  // react without waiting for the next beat.
  function hurry() {
    beat(false);
  }

  document.addEventListener('visibilitychange', hurry, true);
  window.addEventListener('blur', hurry, true);
  window.addEventListener('focus', () => beat(false), true);
  window.addEventListener('pagehide', () => {
    safePost({ type: 'bye', host });
  });
  window.addEventListener('beforeunload', () => {
    safePost({ type: 'bye', host });
  });

  setInterval(() => beat(false), 1000);

  /* ---------------- chip UI ---------------- */

  const SHADOW_CSS = `
    :host { all: initial; }
    .chip {
      position: fixed;
      z-index: 2147483647;
      right: 16px;
      bottom: 16px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px 8px 8px;
      border-radius: 999px;
      background: rgba(8, 12, 24, 0.86);
      border: 1px solid rgba(150, 190, 255, 0.22);
      box-shadow: 0 14px 40px -14px rgba(0, 0, 0, 0.9), inset 0 1px 0 rgba(255, 255, 255, 0.06);
      backdrop-filter: blur(16px) saturate(1.2);
      color: #eaf1ff;
      font: 600 12.5px/1.2 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      letter-spacing: 0.01em;
      cursor: default;
      user-select: none;
      transition: opacity 0.25s ease, transform 0.25s ease;
      transform-origin: bottom right;
      max-width: min(420px, calc(100vw - 32px));
    }
    .chip.min { padding: 0; cursor: pointer; }
    .chip.min .body { display: none; }
    .ring { flex: none; transform: rotate(-90deg); }
    .ring circle { fill: none; stroke-linecap: round; }
    .ring .track { stroke: rgba(150, 190, 255, 0.16); }
    .ring .meter { transition: stroke-dashoffset 0.5s linear, stroke 0.4s ease; }
    .ring text {
      transform: rotate(90deg);
      transform-origin: center;
      font: 700 10px ui-monospace, 'SF Mono', Menlo, monospace;
      fill: #eaf1ff;
      text-anchor: middle;
      dominant-baseline: central;
      letter-spacing: -0.02em;
    }
    .body { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .stack { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .title {
      font-size: 12px; font-weight: 700; letter-spacing: 0.02em;
      color: #eaf1ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sub {
      font-size: 11px; font-weight: 500; color: #93a3c4; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
    .act {
      all: unset;
      cursor: pointer;
      font: 600 11px ui-sans-serif, system-ui, sans-serif;
      color: #93a3c4;
      padding: 4px 8px;
      border-radius: 999px;
      border: 1px solid rgba(150, 190, 255, 0.18);
      transition: color 0.15s, border-color 0.15s, background 0.15s;
      white-space: nowrap;
    }
    .act:hover { color: #eaf1ff; border-color: rgba(150, 190, 255, 0.4); background: rgba(140, 180, 255, 0.12); }
    .chip.urgent { animation: ffpulse 1.1s ease-in-out infinite; }
    @keyframes ffpulse {
      0%, 100% { box-shadow: 0 14px 40px -14px rgba(0,0,0,.9), 0 0 0 0 rgba(255,196,107,.0); }
      50% { box-shadow: 0 14px 40px -14px rgba(0,0,0,.9), 0 0 0 6px rgba(255,196,107,.14); }
    }
  `;

  function buildChip() {
    // Our own host node can be blown away by the page (some sites empty
    // documentElement on client-side navigations). If the chip object still
    // points at a detached node, rebuild rather than quietly doing nothing.
    if (chip && chip.host && chip.host.isConnected === false) {
      chip = null;
      if (chipTicker) clearInterval(chipTicker);
      chipTicker = null;
    }
    if (chip) return;
    const existing = document.getElementById('ff-shadow-host');
    if (existing) existing.remove();
    const hostEl = document.createElement('div');
    hostEl.id = 'ff-shadow-host';
    hostEl.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; right: 0; bottom: 0; width: 0; height: 0;';
    const shadow = hostEl.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;

    const node = document.createElement('div');
    node.className = 'chip';
    node.innerHTML = `
      <svg class="ring" width="34" height="34" viewBox="0 0 34 34">
        <circle class="track" cx="17" cy="17" r="14" stroke-width="3"></circle>
        <circle class="meter" cx="17" cy="17" r="14" stroke-width="3"
          stroke-dasharray="87.96" stroke-dashoffset="87.96"></circle>
        <text x="17" y="17">0:00</text>
      </svg>
      <div class="body">
        <div class="stack">
          <div class="title">FocusFrost</div>
          <div class="sub">Warming up…</div>
        </div>
        <button class="act end" title="End this session now">End</button>
        <button class="act minbtn" title="Collapse to a dot">–</button>
      </div>
    `;

    shadow.append(style, node);
    (document.documentElement || document.body).appendChild(hostEl);

    chip = {
      host: hostEl,
      root: shadow,
      node,
      ring: node.querySelector('.meter'),
      text: node.querySelector('text'),
      title: node.querySelector('.title'),
      sub: node.querySelector('.sub'),
      collapsed: collapsed,
    };

    node.querySelector('.minbtn').addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      collapsed = true;
      collapseKnown = true;
      applyCollapsed();
      rememberCollapsed(true);
    });
    node.addEventListener('click', () => {
      if (!collapsed) return;
      collapsed = false;
      collapseKnown = true;
      applyCollapsed();
      rememberCollapsed(false);
    });
    node.querySelector('.act.end').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await chrome.runtime.sendMessage({ type: 'endSession', site: siteCfg && siteCfg.pattern, tabId: null });
      } catch (_) {}
    });
  }

  let chipTicker = null;

  function teardown() {
    // The document can disappear first (tab closed, or the page got discarded)
    // while a port message is still in flight. Nothing to tear down then.
    const doc = typeof document === 'undefined' ? null : document;
    const el = doc && doc.getElementById('ff-shadow-host');
    if (el) el.remove();
    chip = null;
    if (chipTicker) clearInterval(chipTicker);
    chipTicker = null;
  }

  function render() {
    if (!behavior || behavior.showChip === false) {
      teardown();
      return;
    }
    if (!isTop) return;
    buildChip();
    if (!chip) return;

    const view = computeView();
    const node = chip.node;
    chip.title.textContent = view.title;
    chip.sub.textContent = view.sub;
    chip.text.textContent = view.clock;
    chip.ring.style.stroke = view.color;
    chip.ring.style.strokeDashoffset = String(view.offset);
    node.classList.toggle('urgent', view.urgent);
    node.style.color = view.color;
    applyCollapsed();
    const endBtn = node.querySelector('.act.end');
    if (endBtn) endBtn.style.display = view.showEnd ? '' : 'none';

    if (!chipTicker) chipTicker = setInterval(render, 250);
  }

  /**
   * Work out what the chip should say. Kept dead simple: whichever clock is
   * most urgent (pause, grace, or session) wins.
   */
  function computeView() {
    const now = Date.now();
    const CIRC = 87.96;

    if (paused && pause && pause.remaining > 0) {
      const total = Math.max(1, (pause.minutes || 1) * 60000);
      const left = pause.remaining;
      return {
        title: 'Paused — access granted',
        sub: 'FocusFrost is off duty. It turns back on by itself.',
        clock: clock(left / 1000),
        color: '#7fd3ff',
        offset: CIRC * (1 - left / total),
        urgent: false,
        showEnd: false,
      };
    }

    if (standDown) {
      return {
        title: (siteCfg && (siteCfg.label || siteCfg.pattern)) || 'FocusFrost',
        sub: 'Switched off for this site — nothing will be closed.',
        clock: '–',
        color: '#93a3c4',
        offset: CIRC,
        urgent: false,
        showEnd: false,
      };
    }

    if (!session) {
      return {
        title: siteCfg ? siteCfg.label || 'FocusFrost' : 'FocusFrost',
        sub: 'Watching this tab',
        clock: '•',
        color: '#93a3c4',
        offset: CIRC,
        urgent: false,
        showEnd: false,
      };
    }

    const remaining = session.remainingSeconds != null ? session.remainingSeconds : session.capSeconds;
    const cap = session.capSeconds || 300;
    const grace = inGrace && graceRemaining > 0 ? graceRemaining : 0;

    if (grace > 0) {
      return {
        title: `Grace — ${Math.ceil(grace)}s left`,
        sub: 'You can leave and come back for free. After this, leaving ends the session.',
        clock: clock(grace),
        color: '#ffc46b',
        offset: CIRC * (1 - grace / Math.max(1, (siteCfg && siteCfg.graceSeconds) || grace)),
        urgent: grace <= 5,
        showEnd: true,
      };
    }

    return {
      title: `Focused — ${clock(remaining)} left`,
      sub: 'Stay on this tab. Switching away closes it.',
      clock: clock(remaining),
      color: remaining < 30 ? '#ff7b8a' : '#45d6a8',
      offset: CIRC * (1 - Math.max(0, remaining) / cap),
      urgent: remaining < 30,
      showEnd: true,
    };
  }

  function clock(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  /* ---------------- go ---------------- */

  loadCollapsed();
  connect();
  beat(true);

  // Single-page apps swap the URL without a navigation event. If the user
  // leaves the tracked domain entirely, tell the worker so the visit can end.
  let lastOrigin = origin;
  setInterval(() => {
    if (location.origin !== lastOrigin) {
      lastOrigin = location.origin;
      safePost({ type: 'bye', host: lastOrigin });
    }
  }, 2000);
})();
