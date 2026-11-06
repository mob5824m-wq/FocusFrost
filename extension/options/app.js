/* FocusFrost settings — shell: navigation, routing, chrome, live refresh. */
(function () {
  'use strict';

  const App = window.FFApp;
  const { SECTIONS, RENDERERS, REFRESHERS, icon } = window.FFSections;

  const navEl = document.getElementById('nav');
  const panesEl = document.getElementById('panes');
  const crumbsEl = document.getElementById('crumbs');
  const masterEl = document.getElementById('master');
  const masterLabelEl = document.getElementById('masterLabel');
  const sideStatusEl = document.getElementById('sideStatus');
  const sideBlockedEl = document.getElementById('sideBlocked');

  /* ------------------------------------------------------------------ */
  /* navigation                                                         */
  /* ------------------------------------------------------------------ */

  function pillsFor(sectionId) {
    const s = App.settings;
    const st = App.status || {};
    if (sectionId === 'sites') return { text: String(s.sites.length), cls: 'off' };
    if (sectionId === 'friction') return s.intervention.enabled ? { text: 'on', cls: '' } : { text: 'off', cls: 'off' };
    if (sectionId === 'schedule') {
      const live = st.schedule || {};
      if (!s.schedule.blocks.length) return { text: 'off', cls: 'off' };
      return live.active ? { text: 'active', cls: '' } : { text: s.schedule.blocks.length + '', cls: 'off' };
    }
    if (sectionId === 'pause') {
      const pause = st.pause || {};
      if (pause.active) return { text: App.clock(pause.remaining / 1000), cls: '' };
      return { text: `${pause.usedToday || 0}/${s.pause.maxPerDay}`, cls: pause.remainingToday === 0 ? 'warn' : 'off' };
    }
    if (sectionId === 'intentions') {
      const stats = st.stats || {};
      return stats.turnedAway ? { text: String(stats.turnedAway), cls: '' } : null;
    }
    return null;
  }

  function buildNav() {
    navEl.innerHTML = '';
    let lastGroup = null;
    for (const section of SECTIONS) {
      if (section.group !== lastGroup) {
        navEl.appendChild(App.el('div', { class: 'nav-group', text: section.group }));
        lastGroup = section.group;
      }
      const pill = App.settings ? pillsFor(section.id) : null;
      const link = App.el(
        'button',
        {
          type: 'button',
          class: 'nav-link' + (App.section === section.id ? ' on' : ''),
          dataset: { section: section.id },
          onclick: () => App.go(section.id),
        },
        [
          App.el('span', { html: icon(section.id) }),
          App.el('span', { text: section.label }),
          pill ? App.el('span', { class: 'pill ' + (pill.cls || ''), text: pill.text }) : null,
        ]
      );
      navEl.appendChild(link);
    }
  }

  App.go = function go(sectionId) {
    if (!RENDERERS[sectionId]) sectionId = 'overview';
    App.section = sectionId;
    location.hash = sectionId;
    renderPane();
    for (const link of navEl.querySelectorAll('.nav-link')) {
      link.classList.toggle('on', link.dataset.section === sectionId);
    }
  };

  function renderPane() {
    panesEl.innerHTML = '';
    const section = SECTIONS.find((s) => s.id === App.section) || SECTIONS[0];
    crumbsEl.innerHTML = `<span>Settings</span><span class="sep">/</span><b>${App.escape(section.label)}</b>`;
    if (!App.settings) return;
    const pane = App.el('section', { class: 'pane on', id: 'pane-' + App.section });
    pane.appendChild(RENDERERS[App.section]());
    panesEl.appendChild(pane);
  }

  /* ------------------------------------------------------------------ */
  /* chrome (sidebar state + master switch)                             */
  /* ------------------------------------------------------------------ */

  App.renderChrome = function renderChrome() {
    const s = App.settings;
    const st = App.status || {};
    if (!s) return;
    masterEl.checked = s.enabled;
    masterLabelEl.textContent = s.enabled ? 'Shield is on' : 'Shield is off';

    const pause = st.pause || {};
    const schedule = st.schedule || {};
    let text = 'idle';
    let cls = 'off';
    if (!s.enabled) {
      text = 'off';
    } else if (pause.active) {
      text = 'paused ' + App.clock(pause.remaining / 1000);
      cls = 'paused';
    } else if (schedule.active) {
      text = 'focus hours';
      cls = 'cooling';
    } else if (st.totals && st.totals.active) {
      text = 'site open';
      cls = 'active';
    } else if (st.totals && st.totals.cooling) {
      text = `${st.totals.cooling} cooling`;
      cls = 'cooling';
    }
    sideStatusEl.textContent = text;
    sideStatusEl.className = 'badge ' + cls;
    sideBlockedEl.textContent = `${(st.stats && st.stats.blocked) || 0} blocked today`;

    // keep the nav pills honest without a full rebuild (that would steal focus)
    for (const link of navEl.querySelectorAll('.nav-link')) {
      const pill = pillsFor(link.dataset.section);
      let node = link.querySelector('.pill');
      if (!pill) {
        if (node) node.remove();
        continue;
      }
      if (!node) {
        node = App.el('span', { class: 'pill ' + (pill.cls || ''), text: pill.text });
        link.appendChild(node);
      } else {
        node.className = 'pill ' + (pill.cls || '');
        node.textContent = pill.text;
      }
    }
  };

  App.render = function render() {
    App.renderChrome();
    renderPane();
  };

  /**
   * Rebuild the current section in place — used when the section itself adds or
   * removes something, never as a side effect of saving.
   */
  App.refreshPane = function refreshPane() {
    const build = REFRESHERS[App.section];
    if (!build) return renderPane();
    const current = document.getElementById('pane-' + App.section);
    if (!current) return renderPane();
    const next = App.el('section', { class: 'pane on', id: 'pane-' + App.section });
    next.appendChild(build());
    // Keep the scroll position: an add/remove should not jump you to the top.
    const scroller = document.getElementById('panes');
    const y = scroller ? scroller.scrollTop : 0;
    current.replaceWith(next);
    if (scroller) scroller.scrollTop = y;
  };

  /* ------------------------------------------------------------------ */
  /* live status poll                                                   */
  /* ------------------------------------------------------------------ */

  /**
 * Refresh from the worker without breaking object identity.
 *
 * Sections capture `App.settings` and its site objects in their event handlers.
 * If a poll swapped in a brand-new object, every handler rendered before the
 * poll would keep mutating the orphaned copy and the edit would vanish. So we
 * merge in place instead.
 */
function mergeSettings(res) {
  const fresh = window.FFConfig.normalizeSettings({
    enabled: res.enabled,
    sites: res.sites.map((s) => ({
      id: s.id,
      pattern: s.pattern,
      label: s.label,
      enabled: s.enabled,
      cooldownSeconds: s.cooldownSeconds,
      graceSeconds: s.graceSeconds,
      maxSessionSeconds: s.maxSessionSeconds,
    })),
    defaults: res.defaults,
    intervention: res.intervention,
    pause: {
      holdMs: res.pause.holdMs,
      presets: res.pause.presets,
      maxPerDay: res.pause.maxPerDay,
      minGapMinutes: res.pause.minGapMinutes,
      strict: res.pause.strict,
    },
    schedule: res.schedule,
    behavior: res.behavior,
  });

  if (!App.settings) {
    App.settings = fresh;
    return;
  }

  const target = App.settings;
  target.version = fresh.version;
  target.enabled = fresh.enabled;

  // Merge *nested objects in place* as well. Handlers capture `s.intervention`,
  // `s.pause`, individual blocks, and so on; replacing those objects would
  // leave every handler pointing at an orphaned copy and edits would vanish.
  const mergeInto = (dst, src) => {
    for (const key of Object.keys(src)) {
      const value = src[key];
      if (value && typeof value === 'object' && !Array.isArray(value) && dst[key] && typeof dst[key] === 'object') {
        mergeInto(dst[key], value);
      } else if (Array.isArray(value)) {
        dst[key] = value;
      } else {
        dst[key] = value;
      }
    }
    // Drop keys that no longer exist in the fresh copy.
    for (const key of Object.keys(dst)) {
      if (!(key in src)) delete dst[key];
    }
  };

  mergeInto(target.intervention, fresh.intervention);
  mergeInto(target.pause, fresh.pause);
  mergeInto(target.behavior, fresh.behavior);
  mergeInto(target.defaults, fresh.defaults);

  target.schedule.enabled = fresh.schedule.enabled;
  target.schedule.pausable = fresh.schedule.pausable;
  // Blocks: keep object identity per id so open editors keep working.
  const blocksById = new Map(target.schedule.blocks.map((b) => [b.id, b]));
  target.schedule.blocks = fresh.schedule.blocks.map((incoming) => {
    const existing = blocksById.get(incoming.id);
    if (!existing) return incoming;
    Object.assign(existing, incoming);
    return existing;
  });

  // Sites: keep existing objects (same identity) and patch their values.
  const byPattern = new Map(target.sites.map((s) => [s.pattern, s]));
  target.sites = fresh.sites.map((incoming) => {
    const existing = byPattern.get(incoming.pattern);
    if (!existing) return incoming;
    Object.assign(existing, incoming);
    return existing;
  });
}

async function poll() {
  const res = await App.send({ type: 'status' });
  if (!res || !res.ok) return;
  App.status = res;
  // Do not stomp on the working copy while the user is editing.
  if (!App.dirty) mergeSettings(res);
  // Only the sidebar nudges. Rebuilding a pane on a timer is how a slider jumps
  // back mid-drag and how a half-typed sentence disappears.
  App.renderChrome();
}

  /* ------------------------------------------------------------------ */
  /* wiring                                                             */
  /* ------------------------------------------------------------------ */

  masterEl.addEventListener('change', () => {
    App.settings.enabled = masterEl.checked;
    masterLabelEl.textContent = masterEl.checked ? 'Shield is on' : 'Shield is off';
    App.touch(true);
    buildNav();
  });

  document.getElementById('dashBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
  });

  document.getElementById('saveBtn').addEventListener('click', () => App.saveNow().then(() => App.toast('Saved')));

  window.addEventListener('hashchange', () => {
    const id = location.hash.slice(1);
    if (id && RENDERERS[id] && id !== App.section) App.go(id);
  });

  /* ------------------------------------------------------------------ */
  /* boot                                                               */
  /* ------------------------------------------------------------------ */

  (async function boot() {
    const ok = await App.load();
    if (!ok) return;
    const wanted = location.hash.slice(1);
    App.section = RENDERERS[wanted] ? wanted : 'overview';
    buildNav();
    App.render();
    setInterval(poll, 1500);
  })();
})();
