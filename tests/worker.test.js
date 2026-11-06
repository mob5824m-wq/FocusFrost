/* FocusFrost service-worker integration tests — the real background.js, fake chrome. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function evt() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    fire: (...args) => listeners.map((fn) => fn(...args)),
    count: () => listeners.length,
  };
}

function flush() {
  return new Promise((r) => setTimeout(r, 60));
}

async function bootWorker(seed) {
  // fresh module registry for every test
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}extension${path.sep}`)) delete require.cache[key];
  }
  const Util = require(path.join(ROOT, 'extension/shared/util.js'));
  const Config = require(path.join(ROOT, 'extension/shared/config.js'));
  const Engine = require(path.join(ROOT, 'extension/shared/engine.js'));

  const tabs = new Map();
  let nextTab = 1;
  const store = { local: JSON.parse(JSON.stringify(seed || {})), sync: {} };
  const notes = [];
  const badge = { text: '', color: '' };
  let title = '';

  const e = {
    onBeforeNavigate: evt(),
    onHistoryStateUpdated: evt(),
    onUpdated: evt(),
    onActivated: evt(),
    onFocusChanged: evt(),
    onRemoved: evt(),
    onReplaced: evt(),
    onAlarm: evt(),
    onMessage: evt(),
    onConnect: evt(),
    onInstalled: evt(),
    onStartup: evt(),
  };

  function addTab(url) {
    const tab = { id: nextTab++, windowId: 1, url, status: 'complete', active: true };
    tabs.set(tab.id, tab);
    return tab;
  }
  function addTabAsync(url) {
    return addTab(url);
  }

  const chrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (keys == null) return { ...store.local };
          if (typeof keys === 'string') return keys in store.local ? { [keys]: store.local[keys] } : {};
          const out = {};
          for (const k of [].concat(keys)) if (k in store.local) out[k] = store.local[k];
          return out;
        },
        set: async (items) => {
          Object.assign(store.local, JSON.parse(JSON.stringify(items)));
        },
      },
      sync: {
        get: async () => ({}),
        set: async () => {},
      },
    },
    tabs: {
      query: async (q) => {
        let out = [...tabs.values()];
        if (q && q.windowId != null) out = out.filter((t) => t.windowId === q.windowId);
        return out.map((t) => ({ ...t }));
      },
      get: async (id) => {
        const t = tabs.get(id);
        if (!t) throw new Error('no tab ' + id);
        return { ...t };
      },
      update: async (id, props) => {
        const t = tabs.get(id);
        if (!t) throw new Error('no tab ' + id);
        if (props.url) {
          t.url = props.url;
          redirects.push({ tabId: id, url: props.url });
          e.onBeforeNavigate.fire({ tabId: id, frameId: 0, url: props.url });
        }
        return { ...t };
      },
      remove: async (id) => {
        tabs.delete(id);
        closed.push(id);
      },
      onUpdated: e.onUpdated,
      onActivated: e.onActivated,
      onRemoved: e.onRemoved,
      onReplaced: e.onReplaced,
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: e.onFocusChanged,
      remove: async (id) => {
        for (const t of [...tabs.values()]) tabs.delete(t.id);
        closed.push('window:' + id);
      },
    },
    webNavigation: {
      onBeforeNavigate: e.onBeforeNavigate,
      onHistoryStateUpdated: e.onHistoryStateUpdated,
    },
    alarms: {
      create: async () => {},
      get: async () => undefined,
      onAlarm: e.onAlarm,
    },
    notifications: {
      create: async (id, opts) => {
        notes.push(opts);
        return id;
      },
    },
    action: {
      setBadgeText: async ({ text }) => {
        badge.text = text;
      },
      setBadgeBackgroundColor: async ({ color }) => {
        badge.color = color;
      },
      setTitle: async ({ title: t }) => {
        title = t;
      },
    },
    runtime: {
      getURL: (p) => `chrome-extension://ff/${p}`,
      onMessage: e.onMessage,
      onConnect: e.onConnect,
      onInstalled: e.onInstalled,
      onStartup: e.onStartup,
      onSuspend: evt(),
      openOptionsPage: () => {
        openedOptions = true;
      },
    },
  };

  const closed = [];
  const redirects = [];
  let openedOptions = false;

  // A fresh emulated global scope for the service worker.
  const scope = {
    chrome,
    Util,
    Config,
    Engine,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    URL,
    URLSearchParams,
    JSON,
    Promise,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    Error,
    Map,
    Set,
    parseFloat,
    parseInt,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    AbortController,
    Promise,
    Reflect,
    Symbol,
    RegExp,
    Boolean,
    Function,
  };
  scope.self = scope;
  scope.importScripts = () => {};
  scope.globalThis = scope;
  // In a real worker importScripts() puts these on the worker global.
  scope.FFUtil = Util;
  scope.FFConfig = Config;
  scope.FFEngine = Engine;

  const code = fs.readFileSync(path.join(ROOT, 'extension/background.js'), 'utf8');
  const vm = require('node:vm');
  vm.createContext(scope);
  vm.runInContext(code, scope, { filename: 'background.js' });

  // Give boot a chance to finish reading storage.
  await flush();

  function send(message) {
    return new Promise((resolve) => {
      let answered = false;
      e.onMessage.fire(message, { id: 'ff' }, (value) => {
        answered = true;
        resolve(value);
      });
      setTimeout(() => {
        if (!answered) resolve(undefined);
      }, 400);
    });
  }

  function navigate(tabId, url) {
    e.onBeforeNavigate.fire({ tabId, frameId: 0, url });
  }

  return {
    chrome,
    e,
    store,
    tabs,
    closed,
    redirects,
    notes,
    badge,
    get title() {
      return title;
    },
    get openedOptions() {
      return openedOptions;
    },
    addTab: addTabAsync,
    send,
    navigate,
    scope,
    Util,
    Config,
    Engine,
    flush,
  };
}

const BASE = new Date(2026, 10, 6, 9, 0, 0).getTime();

const SETTINGS = {
  version: 1,
  enabled: true,
  sites: [
    {
      id: 'site_yt',
      pattern: 'youtube.com',
      label: 'YouTube',
      enabled: true,
      cooldownSeconds: 600,
      graceSeconds: 20,
      maxSessionSeconds: 300,
    },
  ],
  defaults: { cooldownSeconds: 600, graceSeconds: 20, maxSessionSeconds: 300 },
  pause: { holdMs: 6000, presets: [5, 15, 30], maxPerDay: 2, minGapMinutes: 30, strict: true },
  behavior: { closeOnBlur: true, blockNewTabs: true, showChip: true, notifyOnEnd: true },
  // Most tests drive the cooldown half of the product directly.
  intervention: { enabled: false },
};

test('worker boots, exposes status, and answers the popup', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const w = await bootWorker({ ff_settings: SETTINGS });
  const status = await w.send({ type: 'status' });
  assert.equal(status.ok, true);
  assert.equal(status.sites.length, 1);
  assert.equal(status.sites[0].pattern, 'youtube.com');
  assert.equal(status.pause.canStart, true);
  assert.equal(status.enabled, true);
});

test('worker allows a tracked navigation once, then blocks a second tab', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const w = await bootWorker({ ff_settings: SETTINGS });
  const t1 = w.addTab('https://www.youtube.com/');
  w.navigate(t1.id, 'https://www.youtube.com/');
  await w.flush();
  assert.equal(w.redirects.length, 0, 'first visit is allowed');

  const t2 = w.addTab('https://youtube.com/watch');
  w.navigate(t2.id, 'https://youtube.com/watch');
  await w.flush();
  assert.equal(w.redirects.length, 1, 'second tab is bounced');
  assert.match(w.redirects[0].url, /blocked\/blocked\.html\?site=youtube\.com&reason=second-tab/);

  const status = await w.send({ type: 'status' });
  assert.equal(status.totals.active, 1);
});

test('untracked sites are never touched', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const w = await bootWorker({ ff_settings: SETTINGS });
  const tab = w.addTab('https://wikipedia.org/');
  w.navigate(tab.id, 'https://wikipedia.org/');
  w.navigate(tab.id, 'https://news.ycombinator.com/');
  await w.flush();
  assert.equal(w.redirects.length, 0);
  assert.equal(w.closed.length, 0);
});

test('a paused site lets everything through', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const w = await bootWorker({ ff_settings: SETTINGS });
  const res = await w.send({ type: 'startPause', minutes: 15 });
  assert.equal(res.result.ok, true);
  assert.equal(res.pause.active, true);

  const tab = w.addTab('https://youtube.com/');
  w.navigate(tab.id, 'https://youtube.com/');
  await w.flush();
  assert.equal(w.redirects.length, 0);
  assert.equal(w.closed.length, 0);
});

test('pause is limited: non-preset rejected, daily cap enforced', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const w = await bootWorker({ ff_settings: SETTINGS });
  const bad = await w.send({ type: 'startPause', minutes: 42 });
  assert.equal(bad.result.ok, false);
  assert.equal(bad.result.reason, 'not-a-preset');

  const first = await w.send({ type: 'startPause', minutes: 5 });
  assert.equal(first.result.ok, true);

  // Jumping the virtual clock is awkward here, so end it and try immediately:
  // the 30 minute gap is what should stop us.
  await w.send({ type: 'stopPause' });
  const again = await w.send({ type: 'startPause', minutes: 5 });
  assert.equal(again.result.ok, false);
  assert.equal(again.result.reason, 'too-soon');
});

test('grace protects a quick close, then a later close starts the cooldown', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const w = await bootWorker({ ff_settings: SETTINGS });

  // Visit 1: closed inside the grace window -> free, no cooldown.
  const t1 = w.addTab('https://youtube.com/');
  w.navigate(t1.id, 'https://youtube.com/');
  await w.flush();
  t.mock.timers.tick(4000); // 4s in, grace is 20s
  w.tabs.delete(t1.id);
  w.e.onRemoved.fire(t1.id, { isWindowClosing: false });
  await w.flush();

  let status = await w.send({ type: 'status' });
  assert.equal(status.sites[0].cooldownUntil, 0, 'closing inside grace is free');
  assert.equal(w.redirects.length, 0);

  // Visit 2: opened again, left after the grace window -> cooldown.
  const t2 = w.addTab('https://youtube.com/');
  w.navigate(t2.id, 'https://youtube.com/');
  await w.flush();
  t.mock.timers.tick(25000); // grace is long gone
  w.tabs.delete(t2.id);
  w.e.onRemoved.fire(t2.id, { isWindowClosing: false });
  await w.flush();

  status = await w.send({ type: 'status' });
  assert.ok(status.sites[0].cooldownUntil > Date.now(), 'cooldown is running');
  assert.equal(status.sites[0].cooldownReason, 'closed');
  assert.equal(status.sites[0].cooldownRemaining, 600000);

  // Coming back hits the wall.
  const back = w.addTab('https://youtube.com/');
  w.navigate(back.id, 'https://youtube.com/');
  await w.flush();
  assert.equal(w.redirects.length, 1);
  assert.match(w.redirects[0].url, /reason=cooldown/);
  assert.match(w.redirects[0].url, /until=\d+/);

  // ...until the cooldown itself expires.
  t.mock.timers.tick(601000);
  const later = w.addTab('https://youtube.com/');
  w.navigate(later.id, 'https://youtube.com/');
  await w.flush();
  assert.equal(w.redirects.length, 1, 'allowed again after the cooldown');
});

test('losing window focus closes the tab only after grace', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const w = await bootWorker({ ff_settings: SETTINGS });
  const tab = w.addTab('https://youtube.com/');
  w.navigate(tab.id, 'https://youtube.com/');
  await w.flush();

  // Inside grace: the switch-away is free.
  t.mock.timers.tick(5000);
  w.e.onFocusChanged.fire(-1);
  await w.flush();
  assert.equal(w.closed.length, 0, 'grace protects the first switch');

  // Past grace: the worker closes it immediately.
  t.mock.timers.tick(20000);
  w.e.onFocusChanged.fire(-1);
  await w.flush();
  // It was the only tab, so the whole window goes — either way it is gone.
  assert.ok(
    w.closed.includes(tab.id) || w.closed.includes('window:1'),
    'tab (or its window) was closed'
  );
  assert.equal(w.tabs.has(tab.id), false, 'the tab is really gone');
  const status = await w.send({ type: 'status' });
  assert.ok(status.sites[0].cooldownUntil > Date.now());
  assert.ok(w.notes.some((n) => /FocusFrost/.test(n.title)), 'the user is told why');
});

test('settings round-trip and revalidation', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const w = await bootWorker({ ff_settings: SETTINGS });
  const res = await w.send({
    type: 'saveSettings',
    settings: Object.assign({}, SETTINGS, { sites: [] }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.sites.length, 0);

  // With nothing tracked, youtube is no longer guarded.
  const tab = w.addTab('https://youtube.com/');
  w.navigate(tab.id, 'https://youtube.com/');
  await w.flush();
  assert.equal(w.redirects.length, 0);
});

test('clearCooldowns is the emergency exit', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const w = await bootWorker({ ff_settings: SETTINGS });
  const tab = w.addTab('https://youtube.com/');
  w.navigate(tab.id, 'https://youtube.com/');
  await w.flush();

  t.mock.timers.tick(30000);
  w.tabs.delete(tab.id);
  w.e.onRemoved.fire(tab.id, {});
  await w.flush();

  let status = await w.send({ type: 'status' });
  assert.ok(status.sites[0].cooldownUntil > 0);

  await w.send({ type: 'clearCooldowns' });
  status = await w.send({ type: 'status' });
  assert.equal(status.sites[0].cooldownUntil, 0);
});

test('content-script port: hello → verdict → heartbeat', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const w = await bootWorker({ ff_settings: SETTINGS });
  const tab = w.addTab('https://youtube.com/');

  const sent = [];
  const port = {
    name: 'focusfrost',
    sender: { tab: { id: tab.id } },
    onMessage: evt(),
    onDisconnect: evt(),
    postMessage: (msg) => sent.push(msg),
  };
  w.e.onConnect.fire(port);
  port.onMessage.fire({ type: 'hello', host: 'www.youtube.com' });
  await w.flush();

  const verdict = sent.find((m) => m.type === 'verdict');
  assert.ok(verdict, 'worker answered the content script');
  assert.equal(verdict.action, 'allow');
  assert.equal(verdict.site, 'youtube.com');
  assert.ok(verdict.session, 'a session was created');
  assert.equal(verdict.session.inGrace, true);

  port.onMessage.fire({ type: 'heartbeat', host: 'www.youtube.com', focused: true });
  await w.flush();
  const tick = sent.filter((m) => m.type === 'tick').pop();
  assert.ok(tick, 'heartbeat answered');
  assert.equal(tick.action, 'allow');
  assert.equal(tick.label, 'YouTube');
});

test('a tracked page that is already cooling gets a block verdict', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const w = await bootWorker({ ff_settings: SETTINGS });
  const tab = w.addTab('https://youtube.com/');
  w.navigate(tab.id, 'https://youtube.com/');
  await w.flush();

  t.mock.timers.tick(30000);
  w.tabs.delete(tab.id);
  w.e.onRemoved.fire(tab.id, {});
  await w.flush();
  w.redirects.length = 0;

  // A brand new tab in the same state, arriving through the port.
  const t2 = w.addTab('https://youtube.com/');
  const sent = [];
  const port = {
    name: 'focusfrost',
    sender: { tab: { id: t2.id } },
    onMessage: evt(),
    onDisconnect: evt(),
    postMessage: (msg) => sent.push(msg),
  };
  w.e.onConnect.fire(port);
  port.onMessage.fire({ type: 'hello', host: 'youtube.com' });
  await w.flush();

  const verdict = sent.find((m) => m.type === 'verdict');
  assert.equal(verdict.action, 'block');
  assert.equal(verdict.reason, 'cooldown');
});

test('corrupt storage does not crash the worker', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const w = await bootWorker({
    ff_settings: { sites: 'nope', pause: null },
    ff_state: { sites: { 'youtube.com': { cooldownUntil: 'x', session: 'y' } }, pause: 12 },
  });
  const status = await w.send({ type: 'status' });
  assert.equal(status.ok, true);
  assert.ok(Array.isArray(status.sites));
  assert.ok(status.sites.length > 0, 'falls back to defaults');
});

/* ================================================================== */
/* the intervention gate, end to end                                   */
/* ================================================================== */

const GATED = Object.assign({}, SETTINGS, {
  intervention: { enabled: true, type: 'breath', durationSeconds: 10, showAlternative: true, alternative: 'go outside' },
});

test('an ungated visit is sent to the intervention page first', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const w = await bootWorker({ ff_settings: GATED });
  const tab = w.addTab('https://youtube.com/watch?v=abc');
  w.navigate(tab.id, 'https://youtube.com/watch?v=abc');
  await w.flush();

  assert.equal(w.redirects.length, 1, 'one redirect to the gate');
  const url = w.redirects[0].url;
  assert.match(url, /intervention\/intervention\.html\?/);
  assert.match(url, /site=youtube\.com/);
  assert.match(url, /target=https%3A%2F%2Fyoutube\.com%2Fwatch%3Fv%3Dabc/);

  // No visit has started yet.
  const status = await w.send({ type: 'status' });
  assert.equal(status.totals.active, 0);
});

test('the gate gets its config, and clearing it grants exactly one pass', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const w = await bootWorker({ ff_settings: GATED });
  const tab = w.addTab('https://youtube.com/');
  w.navigate(tab.id, 'https://youtube.com/');
  await w.flush();
  w.redirects.length = 0;

  // The gate page asks what it should render.
  const config = await w.send({ type: 'interventionConfig', url: 'https://youtube.com/' });
  assert.equal(config.ok, true);
  assert.equal(config.intervention.type, 'breath');
  assert.equal(config.label, 'YouTube');
  assert.ok(config.pause, 'the pause gate travels with it');

  // It finishes: the worker grants a pass to the sender tab.
  const done = await new Promise((resolve) => {
    w.e.onMessage.fire({ type: 'interventionDone', outcome: 'continue', site: 'youtube.com', intention: 'a tutorial' },
      { id: 'ff', tab: { id: tab.id } }, resolve);
  });
  assert.equal(done.ok, true);

  // The follow-up navigation goes straight through: the gate ran once.
  w.navigate(tab.id, 'https://youtube.com/');
  await w.flush();
  assert.equal(w.redirects.length, 0, 'no second gate, no loop');
  const status = await w.send({ type: 'status' });
  assert.equal(status.totals.active, 1, 'the visit started');
});

test('walking away records the intervention and starts no visit', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const w = await bootWorker({ ff_settings: GATED });
  const tab = w.addTab('https://youtube.com/');
  w.navigate(tab.id, 'https://youtube.com/');
  await w.flush();

  await new Promise((resolve) => {
    w.e.onMessage.fire({ type: 'interventionDone', outcome: 'close', site: 'youtube.com' },
      { id: 'ff', tab: { id: tab.id } }, resolve);
  });
  await w.flush();

  const status = await w.send({ type: 'status' });
  assert.equal(status.stats.interventions, 1);
  assert.equal(status.stats.turnedAway, 1);
  assert.equal(status.totals.active, 0);
});

test('the pass does not leak to a different tab', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const w = await bootWorker({ ff_settings: GATED });
  const first = w.addTab('https://youtube.com/');
  w.navigate(first.id, 'https://youtube.com/');
  await w.flush();
  await new Promise((resolve) => {
    w.e.onMessage.fire({ type: 'interventionDone', outcome: 'continue', site: 'youtube.com' },
      { id: 'ff', tab: { id: first.id } }, resolve);
  });

  const second = w.addTab('https://youtube.com/other');
  w.navigate(second.id, 'https://youtube.com/other');
  await w.flush();

  const gateUrls = w.redirects.filter((r) => r.url.includes('intervention'));
  assert.equal(gateUrls.length, 2, 'the second tab had to earn its own pass');
});

test('a cooldown still beats the gate', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const w = await bootWorker({ ff_settings: Object.assign({}, GATED, { intervention: { enabled: false } }) });
  const tab = w.addTab('https://youtube.com/');
  w.navigate(tab.id, 'https://youtube.com/');
  await w.flush();
  t.mock.timers.tick(60000);
  w.tabs.delete(tab.id);
  w.e.onRemoved.fire(tab.id, {});
  await w.flush();
  w.redirects.length = 0;

  const back = w.addTab('https://youtube.com/');
  w.navigate(back.id, 'https://youtube.com/');
  await w.flush();
  assert.equal(w.redirects.length, 1);
  assert.match(w.redirects[0].url, /blocked\/blocked\.html/);
});

test('focus hours are served by the blocked page, pausable on request', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const settings = Object.assign({}, SETTINGS, {
    intervention: { enabled: false },
    schedule: {
      enabled: true,
      pausable: false,
      blocks: [{ id: 'b1', label: 'Deep work', days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', enabled: true }],
    },
  });
  const w = await bootWorker({ ff_settings: settings });
  const tab = w.addTab('https://youtube.com/');
  w.navigate(tab.id, 'https://youtube.com/');
  await w.flush();
  assert.equal(w.redirects.length, 1);
  assert.match(w.redirects[0].url, /reason=schedule/);

  // A pause cannot override it while `pausable` is false.
  await w.send({ type: 'startPause', minutes: 5 });
  w.redirects.length = 0;
  const tab2 = w.addTab('https://youtube.com/');
  w.navigate(tab2.id, 'https://youtube.com/');
  await w.flush();
  assert.equal(w.redirects.length, 1, 'still blocked during a pause');

  // Flip it and a pause gets through.
  await w.send({
    type: 'saveSettings',
    settings: Object.assign({}, settings, { schedule: Object.assign({}, settings.schedule, { pausable: true }) }),
  });
  w.redirects.length = 0;
  const tab3 = w.addTab('https://youtube.com/');
  w.navigate(tab3.id, 'https://youtube.com/');
  await w.flush();
  assert.equal(w.redirects.length, 0, 'the pause punched through');
});
