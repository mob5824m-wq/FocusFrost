/**
 * FocusFrost demo harness.
 *
 * This is NOT part of the extension. It is injected by demo/server.js into the
 * real extension pages so they can run in a normal tab: it fakes just enough of
 * the `chrome.*` API for `background.js` to boot unchanged, and gives the
 * sandbox page a virtual browser (tabs, navigation, focus loss) to drive.
 *
 * Because it loads the real background.js, the real engine.js and the real
 * pages, what you click here is the production ruleset — not a mock of it.
 */
(function () {
  'use strict';

  if (window.__FF_PREVIEW__) return;
  window.__FF_PREVIEW__ = true;
  window.__FF_DEMO = true;

  const EXT_ID = 'focusfrost-demo';
  const LOG_LIMIT = 200;

  /* ------------------------------------------------------------------ */
  /* which frame are we?                                                */
  /* ------------------------------------------------------------------ */

  const isTop = (() => {
    try {
      return window.top === window;
    } catch (_) {
      return false;
    }
  })();

  // The sandbox page owns a single shared "worker" instance, so the popup
  // iframe, the site iframe and the blocked page all talk to the same state.
  function top() {
    try {
      return window.top;
    } catch (_) {
      return window;
    }
  }

  function randomId() {
    return 'ff_' + Math.random().toString(36).slice(2, 10);
  }

  /* ================================================================== */
  /* TOP WINDOW: the simulated browser + chrome API                     */
  /* ================================================================== */

  function createKernel() {
    // A virtual clock: the sandbox can jump time forward so you do not have to
    // sit through a ten minute cooldown. Everything that reads Date.now() —
    // including the real background.js — sees the jump.
    const realNow = Date.now.bind(Date);
    let clockOffset = 0;
    Date.now = () => realNow() + clockOffset;

    const events = {};
    function evt(name) {
      if (!events[name]) {
        const listeners = [];
        events[name] = {
          addListener: (fn) => listeners.push(fn),
          removeListener: (fn) => {
            const i = listeners.indexOf(fn);
            if (i >= 0) listeners.splice(i, 1);
          },
          hasListener: (fn) => listeners.includes(fn),
          _fire: (...args) => listeners.slice().forEach((fn) => {
            try {
              const out = fn(...args);
              if (out && typeof out.catch === 'function') out.catch((err) => console.warn('[demo] async listener', err));
            } catch (err) {
              console.warn('[demo] listener error', err);
            }
          }),
          _count: () => listeners.length,
        };
      }
      return events[name];
    }

    const store = { local: {}, sync: {} };
    const tabs = new Map();
    let nextTabId = 1;
    let nextWindowId = 1;
    const windowId = nextWindowId++;
    let notifications = [];
    const log = [];

    function pushLog(text) {
      log.push({ at: Date.now(), text: String(text) });
      if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
      evt('demo:log')._fire(log[log.length - 1]);
    }

    function emitTabs() {
      evt('demo:tabs')._fire(list());
    }

    function list() {
      return Array.from(tabs.values()).map((t) => ({ ...t }));
    }

    function mkTab(url, active) {
      const tab = {
        id: nextTabId++,
        index: tabs.size,
        windowId,
        url: url || 'about:newtab',
        title: url || 'New tab',
        active: !!active,
        status: 'complete',
        _everLoaded: false,
      };
      tabs.set(tab.id, tab);
      return tab;
    }

    /* ---------------- tab mutations (used by the sandbox UI) -------- */

    function openTab(url) {
      for (const t of tabs.values()) t.active = false;
      const tab = mkTab(url, true);
      emitTabs();
      pushLog(`browser: new tab #${tab.id} → ${url}`);
      navigateTab(tab.id, url);
      return tab.id;
    }

    function removeTabQuiet(tabId) {
      if (!tabs.has(tabId)) return false;
      tabs.delete(tabId);
      emitTabs();
      return true;
    }

    function activateTab(tabId) {
      if (!tabs.has(tabId)) return;
      for (const t of tabs.values()) t.active = t.id === tabId;
      emitTabs();
      evt('tabs:onActivated')._fire({ tabId, windowId });
    }

    function closeTab(tabId) {
      if (!tabs.has(tabId)) return;
      tabs.delete(tabId);
      emitTabs();
      evt('tabs:onRemoved')._fire(tabId, { isWindowClosing: false });
      pushLog(`browser: tab #${tabId} closed`);
    }

    function navigateTab(tabId, url) {
      const tab = tabs.get(tabId);
      if (!tab) return;
      if (tab.url !== url) tab.url = url;
      tab.title = url;
      emitTabs();
      evt('webNavigation:onBeforeNavigate')._fire({ tabId, frameId: 0, url, timeStamp: Date.now() });
      evt('tabs:onUpdated')._fire(tabId, { status: 'loading', url }, { ...tab });
      setTimeout(() => {
        if (!tabs.has(tabId)) return;
        const t = tabs.get(tabId);
        t.status = 'complete';
        evt('tabs:onUpdated')._fire(tabId, { status: 'complete' }, { ...t });
        emitTabs();
      }, 30);
    }

    /** The user alt-tabbed out of the browser entirely. */
    function loseWindowFocus() {
      evt('windows:onFocusChanged')._fire(-1);
      pushLog('browser: window lost focus');
    }

    function focusWindow() {
      evt('windows:onFocusChanged')._fire(windowId);
      pushLog('browser: window focused');
    }

    /* ---------------- the fake chrome ---------------- */

    function promiseOf(value) {
      return Promise.resolve(value);
    }

    function storageArea(name) {
      return {
        get(keys) {
          const area = store[name];
          if (keys == null) return promiseOf({ ...area });
          if (typeof keys === 'string') return promiseOf(keys in area ? { [keys]: area[keys] } : {});
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) if (k in area) out[k] = area[k];
            return promiseOf(out);
          }
          const out = {};
          for (const k of Object.keys(keys)) out[k] = k in area ? area[k] : keys[k];
          return promiseOf(out);
        },
        set(items) {
          Object.assign(store[name], JSON.parse(JSON.stringify(items)));
          evt('demo:storage')._fire(name, items);
          return promiseOf();
        },
        remove(keys) {
          for (const k of [].concat(keys)) delete store[name][k];
          return promiseOf();
        },
        clear() {
          store[name] = {};
          return promiseOf();
        },
      };
    }

    const chromeMock = {
      __demo: {
        store,
        log,
        list,
        openTab,
        activateTab,
        closeTab,
        navigateTab,
        loseWindowFocus,
        focusWindow,
        windowId,
        onTabs: (fn) => evt('demo:tabs').addListener(fn),
        onLog: (fn) => evt('demo:log').addListener(fn),
        onView: (fn) => evt('demo:view').addListener(fn),
        getLog: () => log.slice(),
        notifications: () => notifications.slice(),
        resetStorage: () => {
          store.local = {};
          store.sync = {};
          notifications = [];
        },
        advance: (seconds) => {
          clockOffset += Math.max(0, Number(seconds) || 0) * 1000;
          evt('alarms:onAlarm')._fire({ name: 'ff-tick', scheduledTime: Date.now() });
          pushLog(`clock: +${seconds}s`);
          evt('demo:advance')._fire(seconds);
        },
        onAdvance: (fn) => evt('demo:advance').addListener(fn),
        clockOffset: () => clockOffset,
      },

      runtime: {
        id: EXT_ID,
        lastError: null,
        getURL: (path) => `chrome-extension://${EXT_ID}/${String(path).replace(/^\//, '')}`,
        getManifest: () => ({ version: '1.0.0', name: 'FocusFrost' }),
        openOptionsPage: () => {
          pushLog('openOptionsPage() → /options/options.html');
          evt('demo:open-page')._fire('options/options.html');
        },
        onMessage: evt('runtime:onMessage'),
        onConnect: evt('runtime:onConnect'),
        onInstalled: evt('runtime:onInstalled'),
        onStartup: evt('runtime:onStartup'),
        onSuspend: evt('runtime:onSuspend'),
        sendMessage(message) {
          // Pages usually boot before the worker finishes reading storage, so
          // queue the message until the worker is actually listening.
          return new Promise((resolve) => {
            const deliver = (attempt) => {
              if (!window.__FF_BOOTED__ || !evt('runtime:onMessage')._count()) {
                if (attempt > 400) return resolve({ ok: false, error: 'worker not ready' });
                return setTimeout(() => deliver(attempt + 1), 25);
              }
              let settled = false;
              evt('runtime:onMessage')._fire(
                message,
                { id: EXT_ID, url: (document.baseURI || 'http://localhost/') },
                (value) => {
                  if (settled) return;
                  settled = true;
                  resolve(value);
                }
              );
              setTimeout(() => {
                if (!settled) {
                  settled = true;
                  resolve({ ok: false, error: 'no reply' });
                }
              }, 3000);
            };
            deliver(0);
          });
        },
        connect(info) {
          return makePort(info && info.name);
        },
      },

      storage: { local: storageArea('local'), sync: storageArea('sync'), onChanged: evt('storage:onChanged') },

      tabs: {
        query: (query) => {
          const q = query || {};
          let out = list();
          if (q.windowId != null) out = out.filter((t) => t.windowId === q.windowId);
          if (q.active != null) out = out.filter((t) => !!t.active === !!q.active);
          return promiseOf(out);
        },
        get: (tabId) => {
          const t = tabs.get(tabId);
          return t ? promiseOf({ ...t }) : Promise.reject(new Error('No tab with id: ' + tabId));
        },
        create: (props) => {
          const id = openTab(props && props.url);
          return promiseOf({ ...tabs.get(id) });
        },
        update: (tabId, props) => {
          const tab = tabs.get(tabId);
          if (!tab) return Promise.reject(new Error('No tab with id: ' + tabId));
          if (props && props.url) {
            const url = props.url;
            pushLog(`worker: tabs.update(#${tabId}) → ${shortUrl(url)}`);
            // Blocking = the tab is redirected to the extension's page. Show it.
            evt('demo:view')._fire(tabId, url);
            tab.url = url;
            tab.title = url;
            emitTabs();
          }
          if (props && props.active) activateTab(tabId);
          return promiseOf({ ...tab });
        },
        remove: (tabId) => {
          closeTab(tabId);
          return promiseOf();
        },
        onUpdated: evt('tabs:onUpdated'),
        onActivated: evt('tabs:onActivated'),
        onRemoved: evt('tabs:onRemoved'),
        onReplaced: evt('tabs:onReplaced'),
        onCreated: evt('tabs:onCreated'),
      },

      windows: {
        WINDOW_ID_NONE: -1,
        WINDOW_ID_CURRENT: -2,
        onFocusChanged: evt('windows:onFocusChanged'),
        remove: (id) => {
          pushLog(`worker: windows.remove(${id})`);
          for (const t of list()) closeTab(t.id);
          return promiseOf();
        },
        getCurrent: () => promiseOf({ id: windowId }),
      },

      webNavigation: {
        onBeforeNavigate: evt('webNavigation:onBeforeNavigate'),
        onCommitted: evt('webNavigation:onCommitted'),
        onCompleted: evt('webNavigation:onCompleted'),
        onHistoryStateUpdated: evt('webNavigation:onHistoryStateUpdated'),
      },

      alarms: {
        create: (name, info) => {
          if (typeof name === 'object') name = 'default';
          evt('alarms:created')._fire(name, info);
          return promiseOf();
        },
        get: () => Promise.resolve(undefined),
        getAll: () => promiseOf([]),
        clear: () => promiseOf(true),
        onAlarm: evt('alarms:onAlarm'),
      },

      notifications: {
        create: (id, options) => {
          notifications.push({ id, ...options, at: Date.now() });
          pushLog(`notification: ${options.title} — ${options.message}`);
          evt('demo:notification')._fire(options);
          return promiseOf(id);
        },
        clear: () => promiseOf(true),
        onClicked: evt('notifications:onClicked'),
      },

      action: {
        setBadgeText: ({ text }) => {
          evt('demo:badge')._fire({ text });
          return promiseOf();
        },
        setBadgeBackgroundColor: ({ color }) => {
          evt('demo:badge')._fire({ color });
          return promiseOf();
        },
        setTitle: ({ title }) => {
          evt('demo:title')._fire({ title });
          return promiseOf();
        },
        onClicked: evt('action:onClicked'),
      },

      permissions: { request: () => promiseOf(true) },
    };

    /* ---------------- ports (content scripts) ---------------- */

    function makePort(name, tabId) {
      const messageListeners = [];
      const disconnectListeners = [];
      const port = {
        name: name || 'focusfrost',
        sender: tabId != null ? { id: EXT_ID, tab: { id: tabId, windowId } } : { id: EXT_ID },
        onMessage: { addListener: (fn) => messageListeners.push(fn) },
        onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
        postMessage(message) {
          setTimeout(() => {
            messageListeners.slice().forEach((fn) => {
              try {
                fn(JSON.parse(JSON.stringify(message)), port);
              } catch (err) {
                console.warn('[demo] port listener error', err);
              }
            });
          }, 0);
        },
        disconnect() {
          disconnectListeners.splice(0).forEach((fn) => fn(port));
        },
      };
      evt('runtime:onConnect')._fire(port);
      return port;
    }

    return { chromeMock, makePort, pushLog, tabs, store, removeTabQuiet };
  }

  function shortUrl(url) {
    if (!url) return '(empty)';
    return String(url).replace(`chrome-extension://${EXT_ID}/`, 'ext:').replace(/^https?:\/\//, '').slice(0, 80);
  }

  /* ================================================================== */
  /* boot the real worker with the fake chrome                          */
  /* ================================================================== */

  async function loadSharedScripts() {
    const files = ['shared/util.js', 'shared/config.js', 'shared/engine.js'];
    for (const file of files) {
      // Pages often already include util/config; only load what is missing.
      if (file === 'shared/util.js' && window.FFUtil) continue;
      if (file === 'shared/config.js' && window.FFConfig) continue;
      if (file === 'shared/engine.js' && window.FFEngine) continue;
      const res = await fetch(new URL('/' + file, location.origin).toString());
      if (!res.ok) throw new Error('cannot load ' + file);
      const code = await res.text();
      // eslint-disable-next-line no-new-func
      new Function(code)();
    }
  }

  async function bootWorker(kernel) {
    await loadSharedScripts();
    const res = await fetch(new URL('/background.js', location.origin).toString());
    if (!res.ok) throw new Error('cannot load background.js');
    const code = await res.text();

    // Give the worker everything a service worker global normally has.
    const scope = window;
    scope.importScripts = function () {
      /* shared scripts are already loaded above */
    };
    try {
      // eslint-disable-next-line no-new-func
      new Function(code).call(scope);
    } catch (err) {
      console.error('[demo] worker failed to boot', err);
      kernel.pushLog('WORKER ERROR: ' + err.message);
      throw err;
    }
    kernel.pushLog('worker: background.js booted in the sandbox');
  }

  /* ================================================================== */
  /* CHILD FRAMES: proxy everything to the top window's kernel          */
  /* ================================================================== */

  function proxiedChrome(bridge) {
    const chromeMock = {
      runtime: {
        id: EXT_ID,
        lastError: null,
        getURL: (p) => `chrome-extension://${EXT_ID}/${String(p).replace(/^\//, '')}`,
        getManifest: () => ({ version: '1.0.0' }),
        openOptionsPage: () => bridge.openOptions(),
        sendMessage: (message) => bridge.sendMessage(message),
        onMessage: { addListener() {} },
        onConnect: { addListener() {} },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        connect: (info) => {
          const tabId = window.__FF_TAB_ID || null;
          return bridge.connect((info && info.name) || 'focusfrost', tabId);
        },
      },
      storage: {
        local: {
          get: (keys) => bridge.storageGet('local', keys),
          set: (items) => bridge.storageSet('local', items),
          remove: () => Promise.resolve(),
        },
        sync: {
          get: (keys) => bridge.storageGet('sync', keys),
          set: (items) => bridge.storageSet('sync', items),
        },
        onChanged: { addListener() {} },
      },
      tabs: {
        query: () => bridge.tabsQuery(),
        get: (id) => bridge.tabsGet(id),
        update: (id, props) => bridge.tabsUpdate(id, props),
        remove: (id) => bridge.tabsRemove(id),
        create: (props) => bridge.tabsCreate(props),
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} },
        onRemoved: { addListener() {} },
        onReplaced: { addListener() {} },
      },
      windows: {
        WINDOW_ID_NONE: -1,
        onFocusChanged: { addListener() {} },
        remove: (id) => bridge.windowsRemove(id),
      },
      webNavigation: {
        onBeforeNavigate: { addListener() {} },
        onHistoryStateUpdated: { addListener() {} },
      },
      alarms: { create() {}, get: () => Promise.resolve(undefined), onAlarm: { addListener() {} } },
      notifications: { create: () => Promise.resolve('demo'), onClicked: { addListener() {} } },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {}, onClicked: { addListener() {} } },
    };
    return chromeMock;
  }

  /* ------------------------------------------------------------------ */
  /* install                                                            */
  /* ------------------------------------------------------------------ */

  if (isTop) {
    const kernel = createKernel();
    window.chrome = kernel.chromeMock;
    window.__FF_KERNEL__ = kernel;
    window.__FF_READY__ = bootWorker(kernel).then(() => {
      window.__FF_BOOTED__ = true;
      return true;
    }).catch((err) => {
      console.error(err);
      const el = document.getElementById('bootError');
      if (el) {
        el.textContent = 'Sandbox failed to boot: ' + err.message;
        el.classList.remove('hidden');
      }
    });
    // The sandbox UI loads after this script and calls back in.
    window.__FF_BRIDGE__ = null;
  } else {
    const parentTop = top();

    // The iframe is parsed before the sandbox UI script runs, so the API may
    // not exist yet. Wait for it instead of failing once and giving up.
    let apiPromise = null;
    function sandboxApi() {
      if (!apiPromise) {
        apiPromise = new Promise((resolve) => {
          let tries = 0;
          const tick = () => {
            try {
              const api = parentTop.__FF_SANDBOX__;
              if (api) return resolve(api);
            } catch (_) {
              /* still cross-origin-ish, keep trying */
            }
            if (++tries > 240) return resolve(null);
            setTimeout(tick, 25);
          };
          tick();
        });
      }
      return apiPromise;
    }

    const bridge = {
      async sendMessage(message) {
        const api = await sandboxApi();
        if (!api) return { ok: false, error: 'sandbox not connected' };
        return api.sendMessage(message);
      },
      connect(name, tabId) {
        const silent = { name, postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect() {} };
        sandboxApi().then((api) => {
          if (!api) return;
          const real = api.connect(name, tabId);
          silent.postMessage = (msg) => real.postMessage(msg);
          if (real.onMessage && real.onMessage.addListener) real.onMessage.addListener(() => {});
          silent.__real = real;
        });
        return silent;
      },
      storageGet: async (area, keys) => ((await sandboxApi()) || {}).storageGet ? (await sandboxApi()).storageGet(area, keys) : {},
      storageSet: async (area, items) => {
        const api = await sandboxApi();
        return api ? api.storageSet(area, items) : undefined;
      },
      tabsQuery: async (q) => {
        const api = await sandboxApi();
        return api ? api.tabsQuery(q) : [];
      },
      tabsGet: async (id) => {
        const api = await sandboxApi();
        if (!api) throw new Error('sandbox not connected');
        return api.tabsGet(id);
      },
      tabsUpdate: async (id, props) => {
        const api = await sandboxApi();
        return api ? api.tabsUpdate(id, props) : undefined;
      },
      tabsRemove: async (id) => {
        const api = await sandboxApi();
        return api ? api.tabsRemove(id) : undefined;
      },
      tabsCreate: async (props) => {
        const api = await sandboxApi();
        return api ? api.tabsCreate(props) : undefined;
      },
      windowsRemove: async (id) => {
        const api = await sandboxApi();
        return api ? api.windowsRemove(id) : undefined;
      },
      openOptions: async () => {
        const api = await sandboxApi();
        return api ? api.openOptions() : undefined;
      },
    };
    window.chrome = proxiedChrome(bridge);
  }
})();
