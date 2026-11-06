/**
 * FocusFrost sandbox UI.
 *
 * Renders a fake browser, wires its controls into the fake chrome kernel that
 * preview.js installed, and connects the content scripts running inside the
 * simulated pages to that same kernel. The popup iframe is bridged too, so all
 * three views share one service worker — just like the real extension.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const kernel = window.__FF_KERNEL__;
  if (!kernel) return;

  const chromeMock = window.chrome;
  const demo = chromeMock.__demo;
  const CFG_KEY = 'ff_settings';

  /** tabId -> fake content-script port */
  const tabPorts = new Map();
  let activeTabId = null;
  let trackedPattern = 'youtube.com';
  let turbo = false;
  let logLines = [];

  /* ------------------------------------------------------------------ */
  /* log                                                                */
  /* ------------------------------------------------------------------ */

  function note(text, kind) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    logLines.push({ time, text, kind: kind || '' });
    if (logLines.length > 160) logLines = logLines.slice(-160);
    renderLog();
  }

  function renderLog() {
    const el = $('log');
    if (!el) return;
    el.innerHTML = logLines
      .slice()
      .reverse()
      .map((l) => `<div class="log-line ${l.kind}"><span class="t">${l.time}</span> ${escapeHtml(l.text)}</div>`)
      .join('');
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ------------------------------------------------------------------ */
  /* bridge for the extension pages living in frames                    */
  /* ------------------------------------------------------------------ */

  window.__FF_SANDBOX__ = {
    sendMessage: (message) => chromeMock.runtime.sendMessage(message),

    /** A page asked to open a long-lived port (content scripts do this). */
    connect(name, tabId) {
      const port = kernel.makePort(name, tabId || null);
      if (tabId != null) tabPorts.set(tabId, port);
      return port;
    },

    storageGet: (area, keys) => chromeMock.storage[area].get(keys),
    storageSet: (area, items) => chromeMock.storage[area].set(items),
    tabsQuery: (q) => chromeMock.tabs.query(q),
    tabsGet: (id) => chromeMock.tabs.get(id),
    tabsUpdate: (id, props) => chromeMock.tabs.update(id, props),
    tabsRemove: (id) => chromeMock.tabs.remove(id),
    tabsCreate: (props) => chromeMock.tabs.create(props),
    windowsRemove: (id) => chromeMock.windows.remove(id),
    openOptions: () => {
      window.open('/extension/options/options.html', '_blank');
      return Promise.resolve();
    },
  };

  /** A simulated page's content script opens its port to the worker. */
  function connectTabFrame(tabId) {
    if (tabPorts.has(tabId)) {
      try {
        tabPorts.get(tabId).disconnect();
      } catch (_) {}
      tabPorts.delete(tabId);
    }
    return window.__FF_SANDBOX__.connect('focusfrost', tabId);
  }

  /* ------------------------------------------------------------------ */
  /* simulated pages                                                    */
  /* ------------------------------------------------------------------ */

  window.__FF_TAB_CHROME__ = function (tabId) {
    // `tabId` identifies which simulated tab this chrome.* belongs to.
    const bridge = {
      connect: (name) => connectTabFrame(tabId),
      sendMessage: (message) => chromeMock.runtime.sendMessage(message),
    };
    return {
      runtime: {
        id: 'focusfrost-demo',
        lastError: null,
        getURL: (p) => `chrome-extension://focusfrost-demo/${String(p).replace(/^\//, '')}`,
        sendMessage: (message) => bridge.sendMessage(message),
        connect: (info) => bridge.connect((info && info.name) || 'focusfrost'),
        onMessage: { addListener() {} },
      },
      storage: {
        local: { get: () => chromeMock.storage.local.get(), set: () => Promise.resolve() },
        sync: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      },
      tabs: { query: () => Promise.resolve([]) },
    };
  };

  /* ------------------------------------------------------------------ */
  /* tabs + view                                                        */
  /* ------------------------------------------------------------------ */

  function labelForTab(url) {
    if (!url) return 'New tab';
    if (url.includes('blocked/blocked.html')) return 'Blocked — FocusFrost';
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (_) {
      return String(url).slice(0, 26);
    }
  }

  function renderTabs(tabs) {
    const strip = $('tabstrip');
    const live = tabs || demo.list();
    strip.innerHTML = '';
    if (!live.length) {
      strip.innerHTML = '<div class="tiny dim" style="padding:6px 8px">no tabs open</div>';
      renderView();
      return;
    }
    for (const tab of live) {
      const el = document.createElement('div');
      el.className = 'faketab' + (tab.id === activeTabId ? ' active' : '');
      el.innerHTML = `<span class="ffav"></span><span class="ftitle">${escapeHtml(labelForTab(tab.url))}</span><span class="fx" title="close tab">×</span>`;
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('fx')) {
          closeTabById(tab.id);
          return;
        }
        activateTabById(tab.id);
      });
      strip.appendChild(el);
    }
    renderView();
  }

  function renderView() {
    const view = $('view');
    const noteEl = $('blockedNote');
    if (activeTabId == null) {
      view.innerHTML = `
        <div class="empty-view">
          <div class="empty-orb"></div>
          <h2>Your fake browser</h2>
          <p class="muted small">Open a tracked site below. If FocusFrost decides you cannot be there, the tab is redirected to its own cooling-down page — exactly like the real thing.</p>
        </div>`;
      noteEl.classList.add('hidden');
      return;
    }
    const tab = demo.list().find((t) => t.id === activeTabId);
    if (!tab) {
      activeTabId = null;
      return renderView();
    }
    const url = tab.url || '';

    if (url.includes('blocked/blocked.html')) {
      const path = url.replace('chrome-extension://focusfrost-demo/', '');
      view.innerHTML = '';
      const frame = document.createElement('iframe');
      frame.dataset.kind = 'blocked';
      frame.dataset.tab = String(tab.id);
      frame.src = `/extension/${path}`;
      view.appendChild(frame);
      noteEl.textContent = 'The real blocked page. Try the hold-to-pause button below, or wait out the clock.';
      noteEl.classList.remove('hidden');
      return;
    }

    if (/^https?:/.test(url)) {
      view.innerHTML = '';
      const frame = document.createElement('iframe');
      const host = new URL(url).hostname.replace(/^www\./, '');
      frame.dataset.kind = 'site';
      frame.dataset.tab = String(tab.id);
      frame.src = `/demo/site.html?host=${encodeURIComponent(host)}&tab=${tab.id}`;
      view.appendChild(frame);
      noteEl.classList.add('hidden');
      return;
    }

    view.innerHTML = `<div class="empty-view"><h2>${escapeHtml(url || 'New tab')}</h2><p class="muted small">Not something the sandbox can draw.</p></div>`;
    noteEl.classList.add('hidden');
  }

  function setFrameFocus(focused) {
    const frame = $('view').querySelector('iframe[data-kind="site"]');
    if (!frame) return;
    try {
      const win = frame.contentWindow;
      win.__FF_DEMO_FOCUS = focused;
      win.document.dispatchEvent(new Event('visibilitychange'));
      win.dispatchEvent(new Event(focused ? 'focus' : 'blur'));
      // Push a heartbeat immediately either way so the worker does not wait.
      if (win.__FF_BEAT_NOW__) win.__FF_BEAT_NOW__();
      else win.document.dispatchEvent(new Event('visibilitychange'));
    } catch (err) {
      /* same-origin in the sandbox, but never let the UI die on it */
    }
  }

  function activateTabById(tabId) {
    const prev = activeTabId;
    activeTabId = tabId;
    if (prev != null && prev !== tabId) {
      setFrameFocus(false);
      note(`switched away from tab #${prev} to tab #${tabId}`, 'warn');
    }
    demo.activateTab(tabId);
    renderView();
  }

  function closeTabById(tabId) {
    demo.closeTab(tabId);
    tabPorts.delete(tabId);
    if (activeTabId === tabId) activeTabId = null;
    note(`tab #${tabId} closed`, 'warn');
    renderTabs();
  }

  function currentTab() {
    return activeTabId == null ? null : demo.list().find((t) => t.id === activeTabId) || null;
  }

  /* ------------------------------------------------------------------ */
  /* buttons                                                            */
  /* ------------------------------------------------------------------ */

  function openSite(host) {
    const id = demo.openTab(`https://${host}/`);
    activeTabId = id;
    note(`opened ${host} in tab #${id}`, '');
    renderTabs();
  }

  function leaveTab() {
    const tab = currentTab();
    if (!tab) return note('open a tab first', 'warn');
    setFrameFocus(false);
    note(`you left tab #${tab.id} (${labelForTab(tab.url)})`, 'warn');
    // The worker gets it from both sides: the page reporting focus loss and the
    // browser reporting that the window lost focus.
    demo.loseWindowFocus();
  }

  function returnToTab() {
    const tab = currentTab();
    if (!tab) return note('open a tab first', 'warn');
    setFrameFocus(true);
    demo.focusWindow();
    note(`back on tab #${tab.id}`, 'ok');
  }

  function timeTravel(seconds) {
    demo.advance(seconds);
    note(`clock advanced by ${seconds}s`, '');
  }

  /* ------------------------------------------------------------------ */
  /* worker state panel                                                 */
  /* ------------------------------------------------------------------ */

  async function refreshState() {
    const res = await chromeMock.runtime.sendMessage({ type: 'status' });
    if (!res || !res.ok) return;

    const pill = $('statusPill');
    if (res.pause.active) {
      pill.textContent = `paused ${clockFmt(res.pause.remaining / 1000)}`;
      pill.className = 'badge paused';
    } else if (!res.enabled) {
      pill.textContent = 'tracking off';
      pill.className = 'badge off';
    } else if (res.totals.active) {
      pill.textContent = 'site open';
      pill.className = 'badge active';
    } else if (res.totals.cooling) {
      pill.textContent = `${res.totals.cooling} cooling down`;
      pill.className = 'badge cooling';
    } else {
      pill.textContent = 'idle';
      pill.className = 'badge off';
    }

    const box = $('siteState');
    box.innerHTML = '';
    for (const site of res.sites) {
      const row = document.createElement('div');
      row.className = 'state-row';
      let clock = '—';
      let state = 'ready';
      if (site.session) {
        row.classList.add('is-active');
        state = site.session.inGrace ? 'grace' : 'focused';
        clock = site.session.inGrace ? `${Math.ceil(site.session.graceRemaining)}s` : clockFmt(site.session.remainingSeconds);
      } else if (site.cooldownUntil) {
        row.classList.add('is-cooling');
        state = 'locked';
        clock = clockFmt(site.cooldownRemaining / 1000);
      }
      row.innerHTML = `<b>${escapeHtml(site.label)}</b><span class="st-clock">${clock}</span><span class="tiny dim">${state}</span>`;
      box.appendChild(row);
    }

    const tracked = res.sites.find((s) => s.pattern === trackedPattern) || res.sites[0];
    if (tracked) {
      trackedPattern = tracked.pattern;
      $('trackedName').textContent = tracked.label;
    }
  }

  function clockFmt(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  /* ------------------------------------------------------------------ */
  /* wiring                                                             */
  /* ------------------------------------------------------------------ */

  function wire() {
    $('openTracked').addEventListener('click', () => openSite(trackedPattern));
    $('openOther').addEventListener('click', () => openSite('wikipedia.org'));
    $('leaveBtn').addEventListener('click', leaveTab);
    $('returnBtn').addEventListener('click', returnToTab);
    $('closeBtn').addEventListener('click', () => {
      const tab = currentTab();
      if (tab) closeTabById(tab.id);
      else note('no tab to close', 'warn');
    });
    $('newTab').addEventListener('click', () => openSite('wikipedia.org'));
    $('helpBtn').addEventListener('click', () => $('helpPanel').classList.toggle('hidden'));
    $('closeHelp').addEventListener('click', () => $('helpPanel').classList.add('hidden'));
    $('clearLog').addEventListener('click', () => {
      logLines = [];
      renderLog();
    });
    $('popupNew').href = '/extension/popup/popup.html';

    document.querySelectorAll('[data-age]').forEach((btn) => {
      btn.addEventListener('click', () => timeTravel(Number(btn.dataset.age)));
    });

    $('turbo').addEventListener('change', (e) => {
      turbo = e.target.checked;
      note(turbo ? 'live clock on — real seconds now count' : 'live clock off', turbo ? 'ok' : '');
    });

    demo.onTabs((tabs) => {
      if (activeTabId == null && tabs.length) {
        const act = tabs.find((t) => t.active);
        activeTabId = act ? act.id : tabs[0].id;
      }
      if (activeTabId != null && !tabs.some((t) => t.id === activeTabId)) {
        activeTabId = tabs.length ? tabs[0].id : null;
      }
      renderTabs(tabs);
    });

    // The worker redirects tabs by calling chrome.tabs.update; let the UI follow.
    demo.onView((tabId, url) => {
      if (url.includes('blocked/blocked.html')) {
        note(`worker redirected tab #${tabId} → cooling-down page`, 'bad');
      }
      renderTabs();
    });

    demo.onLog((entry) => note(entry.text, entry.text.startsWith('notification') ? 'ok' : ''));
    demo.onAdvance(() => {
      renderTabs();
    });

    $('workerState').textContent = 'running';
    $('workerState').className = 'badge active';

    setInterval(refreshState, 600);
    setInterval(() => {
      if (turbo) demo.advance(1);
    }, 1000);
  }

  /* ------------------------------------------------------------------ */
  /* go                                                                 */
  /* ------------------------------------------------------------------ */

  window.addEventListener('load', async () => {
    try {
      await window.__FF_READY__;
    } catch (_) {
      return;
    }
    wire();
    note('sandbox ready — background.js is running against the fake browser', 'worker');

    if (!demo.store.local[CFG_KEY]) {
      demo.store.local[CFG_KEY] = {
        version: 1,
        enabled: true,
        sites: [
          { id: 'site_yt', pattern: 'youtube.com', label: 'YouTube', enabled: true, cooldownSeconds: 600, graceSeconds: 20, maxSessionSeconds: 300 },
          { id: 'site_ig', pattern: 'instagram.com', label: 'Instagram', enabled: true, cooldownSeconds: 900, graceSeconds: 15, maxSessionSeconds: 240 },
          { id: 'site_rd', pattern: 'reddit.com', label: 'Reddit', enabled: true, cooldownSeconds: 600, graceSeconds: 20, maxSessionSeconds: 300 },
        ],
        defaults: { cooldownSeconds: 600, graceSeconds: 20, maxSessionSeconds: 300 },
        pause: { holdMs: 6000, presets: [5, 15, 30], maxPerDay: 2, minGapMinutes: 30, strict: true },
        behavior: { closeOnBlur: true, blockNewTabs: true, showChip: true, notifyOnEnd: true },
      };
      // Re-run boot with the seeded settings by asking the worker to reload.
      await chromeMock.runtime.sendMessage({ type: 'saveSettings', settings: demo.store.local[CFG_KEY] });
      note('seeded demo settings (YouTube / Instagram / Reddit)', 'worker');
    }

    await refreshState();
    renderTabs();
    setTimeout(() => $('helpPanel').classList.remove('hidden'), 800);
  });
})();
