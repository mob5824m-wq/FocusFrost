/**
 * FocusFrost settings — core plumbing.
 *
 * Working copy of the settings object + autosave + tiny DOM helpers. Sections
 * (app-sections.js) are pure render functions over `App.settings`.
 */
(function () {
  'use strict';

  const Util = window.FFUtil;
  const Config = window.FFConfig;

  const App = {
    settings: null,
    status: null,
    section: 'overview',
    dirty: false,
    errors: [],
  };

  /* ------------------------------------------------------------------ */
  /* messaging                                                          */
  /* ------------------------------------------------------------------ */

  App.send = function send(message) {
    return chrome.runtime.sendMessage(message).catch((err) => ({ ok: false, error: String(err) }));
  };

  /* ------------------------------------------------------------------ */
  /* load + save                                                        */
  /* ------------------------------------------------------------------ */

  function settingsFromStatus(res) {
    return Config.normalizeSettings({
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
      schedule: res.schedule ? { enabled: res.schedule.enabled, pausable: res.schedule.pausable, blocks: res.schedule.blocks } : undefined,
      behavior: res.behavior,
    });
  }

  App.load = async function load() {
    const res = await App.send({ type: 'status' });
    if (!res || !res.ok) {
      App.errors.push('Could not reach the background worker.');
      document.body.insertAdjacentHTML(
        'afterbegin',
        '<div class="toast show" style="position:static;margin:14px;transform:none">Background worker unreachable — reload the extension.</div>'
      );
      return false;
    }
    App.status = res;
    // Only take the stored settings if we are not mid-edit.
    if (!App.dirty || !App.settings) App.settings = settingsFromStatus(res);
    return true;
  };

  let saveTimer = null;
  let saveInFlight = null;
  let savePending = false;

  /** Called by sections after any mutation. Debounced. */
  App.touch = function touch(immediate) {
    App.dirty = true;
    const btn = document.getElementById('saveBtn');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Saving…';
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => App.save(), immediate ? 0 : 260);
  };

  App.save = function save() {
    if (saveInFlight) {
      // An edit landed while a write was in flight: queue one more so nothing
      // is silently dropped.
      savePending = true;
      return saveInFlight;
    }
    saveInFlight = (async () => {
      const payload = JSON.parse(JSON.stringify(App.settings));
      const res = await App.send({ type: 'saveSettings', settings: payload });
      saveInFlight = null;
      const btn = document.getElementById('saveBtn');
      if (res && res.ok) {
        App.status = res;
        // A newer edit may have landed while this write was in flight; in that
        // case we are still dirty and must not show "Saved".
        App.dirty = savePending ? true : false;
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Saved';
        }
        if (savePending) {
          savePending = false;
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => App.save(), 0);
        } else if (typeof App.render === 'function') {
          // Reflect anything derived from what was just saved.
          App.render();
        }
        return res;
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Retry save';
      }
      App.toast('Save failed — check the extension');
      return res;
    })();
    return saveInFlight;
  };

  /** Force a save then re-read (used by destructive actions). */
  App.saveNow = async function saveNow() {
    const res = await App.save();
    App.dirty = false;
    await App.load();
    App.render();
    return res;
  };

  /* ------------------------------------------------------------------ */
  /* tiny DOM helpers                                                   */
  /* ------------------------------------------------------------------ */

  App.el = function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        const value = attrs[key];
        if (value == null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else node.setAttribute(key, value === true ? '' : value);
      }
    }
    for (const child of [].concat(children || [])) {
      if (child == null) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  };

  App.escape = function escape(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };

  let toastTimer = null;
  App.toast = function toast(text) {
    const node = document.getElementById('toast');
    if (!node) return;
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 2400);
  };

  App.clock = Util.clock;
  App.human = Util.humanDuration;

  /** A labelled range slider that writes through to `obj[key]`. */
  App.slider = function slider(opts) {
    const { label, value, min, max, step, format, hint, onChange } = opts;
    const out = App.el('span', { class: 'val', text: format(value) });
    const input = App.el('input', {
      type: 'range',
      min: String(min),
      max: String(max),
      step: String(step || 1),
      value: String(value),
      oninput: (e) => {
        const next = Number(e.target.value);
        out.textContent = format(next);
        onChange(next);
      },
    });
    return App.el('div', { class: 'slider' }, [
      App.el('div', { class: 'sl-top' }, [App.el('label', { text: label }), out]),
      input,
      hint ? App.el('p', { class: 'hint', text: hint }) : null,
    ]);
  };

  App.switchRow = function switchRow(opts) {
    const input = App.el('input', {
      type: 'checkbox',
      checked: !!opts.value,
      onchange: (e) => opts.onChange(e.target.checked),
    });
    return App.el('div', { class: 'row-card' }, [
      App.el('div', { class: 'rc-text' }, [
        App.el('h3', { text: opts.title }),
        App.el('p', { class: opts.hintWarn ? 'warn' : '', text: opts.hint }),
      ]),
      App.el('label', { class: 'switch' }, [input, App.el('span')]),
    ]);
  };

  App.segmented = function segmented(opts) {
    const wrap = App.el('div', { class: 'seg' });
    for (const option of opts.options) {
      wrap.appendChild(
        App.el('button', {
          type: 'button',
          class: opts.value === option.value ? 'on' : '',
          text: option.label,
          onclick: () => {
            for (const b of wrap.children) b.classList.toggle('on', b === wrap.children[opts.options.indexOf(option)]);
            opts.onChange(option.value);
          },
        })
      );
    }
    return wrap;
  };

  window.FFApp = App;
})();
