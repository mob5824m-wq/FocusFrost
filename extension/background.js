/**
 * FocusFrost — background service worker (MV3).
 *
 * Responsibilities
 *  1. Load settings + state, keep them in memory, persist on change.
 *  2. Intercept navigations to tracked sites and redirect locked ones.
 *  3. Watch tab/window focus and close tracked tabs the moment focus is lost
 *     after the grace window.
 *  4. Run the paused-mode ("Pause productivity extensions") clock.
 *  5. Answer popup / options / blocked-page / content-script messages.
 */
importScripts('shared/util.js', 'shared/config.js', 'shared/engine.js');

// importScripts() attaches the UMD builds to the worker global.
const Util = self.FFUtil;
const Config = self.FFConfig;
const Engine = self.FFEngine;

const CFG_KEY = 'ff_settings';
const STATE_KEY = 'ff_state';
const BLOCKED_PAGE = 'blocked/blocked.html';
const TICK_ALARM = 'ff-tick';

let cfg = Config.defaultSettings();
let state = Engine.emptyState(Date.now());

/** tabId -> Port from a content script */
const ports = new Map();
/** crude de-dupe so one navigation is not counted as five blocks */
const recentBlocks = new Map();

let persistTimer = null;
let chain = Promise.resolve();

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

const ready = (async function boot() {
  const local = await chrome.storage.local.get([CFG_KEY, STATE_KEY]);
  let storedCfg = local[CFG_KEY];
  if (!storedCfg) {
    // Settings may also live in sync storage (synced between machines).
    try {
      const synced = await chrome.storage.sync.get(CFG_KEY);
      if (synced && synced[CFG_KEY]) storedCfg = synced[CFG_KEY];
    } catch (_) {
      /* sync unavailable — local only */
    }
  }
  cfg = Config.normalizeSettings(storedCfg);
  state = Engine.normalizeState(local[STATE_KEY], Date.now());
  Engine.rollDay(state, Date.now());
  Engine.expirePause(state, Date.now());
  await ensureAlarms();
  updateBadge();
})();

/** Serialise every state mutation: storage writes are async and interleave. */
function serial(fn) {
  const next = chain.then(fn, fn);
  // Never let one bad event kill the queue — but do not hide it either.
  chain = next.catch((err) => {
    console.error('[FocusFrost] event handler failed:', err);
  });
  return next;
}

function persistNow() {
  clearTimeout(persistTimer);
  persistTimer = null;
  const snapshot = JSON.parse(JSON.stringify({ [STATE_KEY]: state }));
  return chrome.storage.local.set(snapshot).catch(() => {});
}

function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 250);
}

async function saveSettings() {
  await chrome.storage.local.set({ [CFG_KEY]: cfg });
  try {
    await chrome.storage.sync.set({ [CFG_KEY]: cfg });
  } catch (_) {
    /* ignore: local copy is authoritative */
  }
}

async function ensureAlarms() {
  const existing = await chrome.alarms.get(TICK_ALARM);
  if (!existing) chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function siteState(pattern) {
  return Engine.getSiteState(state, pattern, Date.now());
}

function trackedPatternForUrl(url) {
  let host;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    host = u.hostname;
  } catch (_) {
    return null;
  }
  const site = Engine.findSite(cfg, host);
  return site && site.enabled ? site : null;
}

function isOurPage(url) {
  return typeof url === 'string' && url.startsWith(chrome.runtime.getURL(''));
}

function blockedUrl(decision) {
  const params = new URLSearchParams();
  params.set('site', decision.site || '');
  params.set('reason', decision.reason || 'cooldown');
  if (decision.until) params.set('until', String(decision.until));
  if (decision.otherTabId) params.set('otherTab', String(decision.otherTabId));
  return chrome.runtime.getURL(`${BLOCKED_PAGE}?${params.toString()}`);
}

function blockKey(tabId, decision, now) {
  return `${tabId}:${decision.site}:${decision.reason}:${Math.floor(now / 1500)}`;
}

function markBlocked(tabId, decision, now) {
  const key = blockKey(tabId, decision, now);
  if (recentBlocks.has(key)) return false;
  recentBlocks.set(key, now);
  if (recentBlocks.size > 200) {
    for (const [k, t] of recentBlocks) if (now - t > 60000) recentBlocks.delete(k);
  }
  return true;
}

function patternForTab(tabId) {
  for (const key of Object.keys(state.sites)) {
    const st = state.sites[key];
    if (st.session && st.session.tabId === tabId) return key;
  }
  return null;
}

async function safeTabGet(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (_) {
    return null;
  }
}

function notify(title, message) {
  if (!cfg.behavior.notifyOnEnd) return;
  try {
    chrome.notifications.create(`ff_${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      priority: 1,
    });
  } catch (_) {
    /* notifications are a nicety, never let them break the flow */
  }
}

/* ------------------------------------------------------------------ */
/* outbound: push state to content scripts                            */
/* ------------------------------------------------------------------ */

function pushToTab(tabId, payload) {
  const port = ports.get(tabId);
  if (!port) return;
  try {
    port.postMessage(payload);
  } catch (_) {
    ports.delete(tabId);
  }
}

function broadcast(payload) {
  for (const [tabId, port] of ports) {
    try {
      port.postMessage(payload);
    } catch (_) {
      ports.delete(tabId);
    }
  }
}

function broadcastStatus() {
  const snap = Engine.snapshot(state, cfg, Date.now());
  for (const port of ports.values()) {
    try {
      port.postMessage({ type: 'pause', pause: snap.pause, enabled: snap.enabled });
    } catch (_) {
      /* closed */
    }
  }
}

/* ------------------------------------------------------------------ */
/* badge                                                               */
/* ------------------------------------------------------------------ */

async function updateBadge() {
  const now = Date.now();
  const snap = Engine.snapshot(state, cfg, now);
  let text = '';
  let color = '#5aa9f7';
  if (!cfg.enabled) {
    text = '';
  } else if (snap.pause.active) {
    text = 'II';
    color = '#3fb894';
  } else if (snap.totals.cooling > 0) {
    text = String(Math.min(99, snap.totals.active + snap.totals.cooling));
    color = '#7c6cf0';
  } else if (snap.totals.active > 0) {
    text = '1';
    color = '#3fb894';
  }
  await chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
  await chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setTitle({
    title: cfg.enabled
      ? `FocusFrost — ${snap.totals.active} focused, ${snap.totals.cooling} cooling down`
      : 'FocusFrost — paused (tracking off)',
  });
}

/* ------------------------------------------------------------------ */
/* core actions                                                        */
/* ------------------------------------------------------------------ */

/** Apply a policy decision to a real tab. */
async function actOnTab(tabId, decision, opts) {
  const options = opts || {};
  const now = Date.now();
  if (!decision) return;

  if (decision.action === 'block') {
    if (!markBlocked(tabId, decision, now)) return;
    try {
      await chrome.tabs.update(tabId, { url: blockedUrl(decision) });
    } catch (err) {
      // The tab may have gone away mid-redirect; anything else is worth knowing.
      console.warn('[FocusFrost] could not redirect tab', tabId, err);
    }
    updateBadge();
    return;
  }

  if (decision.action === 'close') {
    const tab = await safeTabGet(tabId);
    if (!tab) return;
    if (!options.silent) {
      const why =
        decision.reason === Engine.REASONS.LIMIT
          ? `session cap reached on ${decision.label}`
          : decision.reason === Engine.REASONS.CLOSED
          ? `${decision.label} closed`
          : `you left ${decision.label}`;
      if (decision.cooldownSeconds) {
        notify('FocusFrost closed the tab', `Cooling down for ${Util.humanDuration(decision.cooldownSeconds)} — ${why}.`);
      }
    }
    // Close the tab. If it was the last tab in the window, close the window.
    const siblings = await chrome.tabs.query({ windowId: tab.windowId }).catch(() => []);
    if (siblings.length <= 1) {
      await chrome.windows.remove(tab.windowId).catch(() => chrome.tabs.remove(tab.id).catch(() => {}));
    } else {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
    updateBadge();
  }
}

/** Evaluate a navigation for a tab and act on the verdict. */
async function guardNavigation(tabId, url) {
  if (!url || isOurPage(url)) return;
  const now = Date.now();
  if (trackedPatternForUrl(url) === null) {
    // Leaving a tracked site via URL change: is the tab still on another
    // tracked site? If not, that counts as leaving after all.
    const openPattern = patternForTab(tabId);
    if (openPattern) {
      const decision = Engine.recordLeave(state, cfg, openPattern, now, Engine.REASONS.LEFT);
      if (decision.action === 'close') {
        // We are mid-navigation to somewhere else; do not close, just cool down.
        persistSoon();
        updateBadge();
      }
      persistSoon();
    }
    return;
  }
  const site = trackedPatternForUrl(url);
  const decision = Engine.evaluateNavigation(state, cfg, site.pattern, tabId, now);
  persistSoon();
  if (decision.action === 'block') await actOnTab(tabId, decision);
  else updateBadge();
}

/* ------------------------------------------------------------------ */
/* navigation listeners                                                */
/* ------------------------------------------------------------------ */

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  ready.then(() => serial(() => guardNavigation(details.tabId, details.url)));
});

chrome.webNavigation.onHistoryStateUpdated?.addListener((details) => {
  if (details.frameId !== 0) return;
  ready.then(() => serial(() => guardNavigation(details.tabId, details.url)));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  const url = changeInfo.url || tab.url;
  ready.then(() => serial(() => guardNavigation(tabId, url)));
});

/* ------------------------------------------------------------------ */
/* focus / lifecycle listeners                                         */
/* ------------------------------------------------------------------ */

let lastActiveTabId = null;

chrome.tabs.onActivated.addListener((info) => {
  ready.then(() =>
    serial(async () => {
      const prev = lastActiveTabId;
      lastActiveTabId = info.tabId;
      if (prev !== null && prev !== info.tabId) {
        const pattern = patternForTab(prev);
        if (pattern) {
          const decision = Engine.recordLeave(state, cfg, pattern, Date.now(), Engine.REASONS.BLUR);
          persistSoon();
          await actOnTab(prev, decision);
        }
      }
      updateBadge();
    })
  );
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) return;
  ready.then(() =>
    serial(async () => {
      // You alt-tabbed to another app (or another virtual desktop): every
      // tracked tab that is past its grace window gets closed right now.
      const victims = [];
      for (const key of Object.keys(state.sites)) {
        const st = state.sites[key];
        if (!st.session) continue;
        const tabId = st.session.tabId;
        const decision = Engine.recordLeave(state, cfg, key, Date.now(), Engine.REASONS.BLUR);
        if (decision.action === 'close') victims.push({ tabId, decision });
      }
      for (const victim of victims) {
        await actOnTab(victim.tabId, victim.decision, { silent: false });
      }
      persistNow();
      updateBadge();
    })
  );
});

chrome.tabs.onRemoved.addListener((tabId) => {
  ready.then(() =>
    serial(() => {
      ports.delete(tabId);
      const pattern = patternForTab(tabId);
      if (pattern) {
        const decision = Engine.recordTabClosed(state, cfg, pattern, Date.now());
        if (decision.action === 'close') {
          notify('FocusFrost', `${decision.label} is cooling down for ${Util.humanDuration(decision.cooldownSeconds)}.`);
        }
      }
      persistSoon();
      updateBadge();
    })
  );
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  ready.then(() =>
    serial(() => {
      ports.delete(removedTabId);
      for (const key of Object.keys(state.sites)) {
        const st = state.sites[key];
        if (st.session && st.session.tabId === removedTabId) st.session.tabId = addedTabId;
      }
      persistSoon();
    })
  );
});

/* ------------------------------------------------------------------ */
/* content script ports                                                */
/* ------------------------------------------------------------------ */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'focusfrost') return;
  const senderTab = port.sender && port.sender.tab;
  const tabId = senderTab ? senderTab.id : null;
  if (tabId === null) return;

  let pattern = null;

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    ready.then(() =>
      serial(async () => {
        if (msg.type === 'hello') {
          const now = Date.now();
          const site = Engine.findSite(cfg, msg.host || '');
          if (!site || !site.enabled || !cfg.enabled) {
            port.postMessage({ type: 'verdict', action: 'allow', reason: 'untracked' });
            return;
          }
          pattern = site.pattern;
          const decision = Engine.evaluateNavigation(state, cfg, site.pattern, tabId, now);
          persistSoon();
          if (decision.action === 'block') {
            port.postMessage({ type: 'verdict', action: 'block', reason: decision.reason, until: decision.until });
            await actOnTab(tabId, decision);
            return;
          }
          ports.set(tabId, port);
          const st = state.sites[site.pattern];
          const snap = Engine.snapshot(state, cfg, now);
          port.postMessage({
            type: 'verdict',
            action: 'allow',
            site: site.pattern,
            label: site.label,
            siteCfg: site,
            session: st.session ? Object.assign(Engine.publicSession(st.session, site, now), { tabId: st.session.tabId }) : null,
            pause: snap.pause,
            behavior: cfg.behavior,
            enabled: cfg.enabled,
          });
          updateBadge();
          return;
        }

        if (msg.type === 'heartbeat') {
          const now = Date.now();
          const site = Engine.findSite(cfg, msg.host || '');
          if (!site) {
            port.postMessage({ type: 'verdict', action: 'allow', reason: 'untracked' });
            return;
          }
          pattern = site.pattern;
          const decision = Engine.heartbeat(state, cfg, site.pattern, tabId, now, !!msg.focused);
          persistSoon();
          if (decision.action === 'close') {
            port.postMessage({ type: 'closed', reason: decision.reason, message: decision.message });
            await actOnTab(tabId, decision);
            return;
          }
          if (decision.action === 'block') {
            port.postMessage({ type: 'blocked', reason: decision.reason, until: decision.until });
            await actOnTab(tabId, decision);
            return;
          }
          port.postMessage({
            type: 'tick',
            action: decision.action,
            session: decision.session || null,
            inGrace: !!decision.inGrace,
            graceRemaining: decision.graceRemaining || 0,
            paused: !!decision.paused,
            pause: Engine.snapshot(state, cfg, now).pause,
            site: site.pattern,
            label: site.label,
          });
          return;
        }

        if (msg.type === 'bye') {
          // A navigation away or a close: the tab may still exist. Decide by URL.
          const tab = await safeTabGet(tabId);
          if (!tab) {
            const p = patternForTab(tabId);
            if (p) Engine.recordTabClosed(state, cfg, p, Date.now());
          } else {
            const site = trackedPatternForUrl(tab.url || '');
            if (!site) {
              const p = patternForTab(tabId);
              if (p) {
                const decision = Engine.recordLeave(state, cfg, p, Date.now(), Engine.REASONS.LEFT);
                if (decision.action === 'close') updateBadge();
              }
            }
          }
          persistSoon();
          updateBadge();
        }
      })
    );
  });

  port.onDisconnect.addListener(() => {
    if (ports.get(tabId) === port) ports.delete(tabId);
  });
});

/* ------------------------------------------------------------------ */
/* runtime messages (popup, options, blocked page)                     */
/* ------------------------------------------------------------------ */

function statusPayload() {
  const snap = Engine.snapshot(state, cfg, Date.now());
  return { ok: true, settings: cfg, behavior: cfg.behavior, defaults: cfg.defaults, ...snap };
}

const handlers = {
  async status() {
    return statusPayload();
  },

  async saveSettings(message) {
    cfg = Config.normalizeSettings(message.settings);
    await saveSettings();
    Engine.rollDay(state, Date.now());
    await revalidateOpenTabs();
    broadcastStatus();
    return statusPayload();
  },

  async startPause(message) {
    const res = Engine.startPause(state, cfg, message.minutes, Date.now());
    if (res.ok) {
      await persistNow();
      notify('FocusFrost paused', `Tracked sites are open for ${res.minutes} minutes.`);
      await revalidateOpenTabs();
      broadcastStatus();
    }
    return { ...statusPayload(), result: res };
  },

  async stopPause() {
    const res = Engine.stopPause(state, Date.now());
    await persistNow();
    await revalidateOpenTabs();
    broadcastStatus();
    return { ...statusPayload(), result: res };
  },

  async endSession(message) {
    const pattern = message.site;
    const res = Engine.endSessionManually(state, cfg, pattern, Date.now());
    if (res.ok) {
      const st = siteState(pattern);
      const tabId = message.tabId || (st.session ? st.session.tabId : null);
      if (tabId) await actOnTab(tabId, { action: 'close', reason: Engine.REASONS.MANUAL, cooldownSeconds: res.cooldownSeconds, label: pattern });
      await persistNow();
    }
    updateBadge();
    return { ...statusPayload(), result: res };
  },

  async clearSite(message) {
    const site = Engine.findSite(cfg, message.pattern || '');
    if (!site) return { ...statusPayload(), result: { ok: false, reason: 'untracked' } };
    const st = Engine.getSiteState(state, site.pattern, Date.now());
    st.cooldownUntil = 0;
    st.cooldownReason = null;
    st.session = null;
    await persistNow();
    updateBadge();
    return { ...statusPayload(), result: { ok: true } };
  },

  async clearCooldowns() {
    for (const key of Object.keys(state.sites)) {
      state.sites[key].cooldownUntil = 0;
      state.sites[key].cooldownReason = null;
      state.sites[key].session = null;
    }
    state.pause.until = 0;
    await persistNow();
    updateBadge();
    return statusPayload();
  },

  async resetStats() {
    state.stats = { day: Util.dayKey(Date.now()), blocked: 0, sessions: 0, focusSeconds: 0 };
    for (const key of Object.keys(state.sites)) {
      const st = state.sites[key];
      st.bestFocusSeconds = 0;
      st.focusSeconds = 0;
      st.blocked = 0;
      st.trips = 0;
    }
    await persistNow();
    return statusPayload();
  },

  /** Used by blocked.html to re-check itself (and self-heal stale blocks). */
  async evaluate(message) {
    const now = Date.now();
    const site = Engine.findSite(cfg, message.host || '');
    if (!site) return { action: 'allow', reason: 'untracked' };
    const decision = Engine.evaluateNavigation(state, cfg, site.pattern, message.tabId || -1, now);
    persistSoon();
    const snap = Engine.snapshot(state, cfg, now);
    return { ...decision, pause: snap.pause, settings: cfg, siteCfg: site };
  },

  async openOptions() {
    chrome.runtime.openOptionsPage();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = message && handlers[message.type];
  if (!handler) {
    sendResponse({ ok: false, error: `unknown message: ${message && message.type}` });
    return false;
  }
  ready
    .then(() => serial(() => handler(message, sender)))
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // keep the channel open for the async reply
});

/** Settings may have unlocked sites: refresh every open tracked tab. */
async function revalidateOpenTabs() {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const now = Date.now();
  for (const tab of tabs) {
    if (!tab.url || isOurPage(tab.url)) continue;
    const site = trackedPatternForUrl(tab.url);
    if (!site) continue;
    const decision = Engine.evaluateNavigation(state, cfg, site.pattern, tab.id, now);
    if (decision.action === 'block') await actOnTab(tab.id, decision);
  }
  persistSoon();
  updateBadge();
}

/* ------------------------------------------------------------------ */
/* alarms & service worker lifecycle                                   */
/* ------------------------------------------------------------------ */

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TICK_ALARM) return;
  ready.then(() =>
    serial(async () => {
      const now = Date.now();
      const expiredPause = Engine.expirePause(state, now);
      const cooled = Engine.collectExpiredCooldowns(state, now);
      Engine.rollDay(state, now);
      if (cooled.length) {
        for (const item of cooled) {
          const site = Engine.findSite(cfg, item.site);
          if (site) notify('Back in the game', `${site.label} is available again. Stay focused.`);
        }
        await persistNow();
      } else {
        persistSoon();
      }
      if (expiredPause) await revalidateOpenTabs();
      updateBadge();
    })
  );
});

chrome.runtime.onStartup.addListener(() => {
  ready.then(() => serial(() => {
    const now = Date.now();
    Engine.expirePause(state, now);
    // Sessions do not survive a browser restart.
    for (const key of Object.keys(state.sites)) state.sites[key].session = null;
    persistSoon();
    updateBadge();
  }));
});

chrome.runtime.onInstalled.addListener((details) => {
  ready.then(async () => {
    await saveSettings();
    if (details.reason === 'install') {
      chrome.runtime.openOptionsPage();
    }
  });
});

/* Keep the worker's view of focus honest even if a content script is asleep. */
setInterval(() => {
  ready.then(() => {
    const active = ports.size;
    if (active) updateBadge();
  });
}, 30000);
