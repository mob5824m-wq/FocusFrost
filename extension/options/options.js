/* FocusFrost — settings page */
(function () {
  'use strict';

  const Util = window.FFUtil;
  const Config = window.FFConfig;
  const $ = (id) => document.getElementById(id);

  let settings = null;
  let status = null;
  let saveTimer = null;
  let toastTimer = null;

  const el = {
    master: $('master'),
    masterLabel: $('masterLabel'),
    addInput: $('addInput'),
    addBtn: $('addBtn'),
    suggestions: $('suggestions'),
    sitesList: $('sitesList'),
    applyAll: $('applyAll'),
    closeOnBlur: $('closeOnBlur'),
    blockNewTabs: $('blockNewTabs'),
    showChip: $('showChip'),
    notifyOnEnd: $('notifyOnEnd'),
    defCooldown: $('defCooldown'),
    defGrace: $('defGrace'),
    defCap: $('defCap'),
    holdMs: $('holdMs'),
    holdMsOut: $('holdMsOut'),
    presetChips: $('presetChips'),
    newPreset: $('newPreset'),
    addPreset: $('addPreset'),
    maxPerDay: $('maxPerDay'),
    minGap: $('minGap'),
    strict: $('strict'),
    pauseUsage: $('pauseUsage'),
    resumeNow: $('resumeNow'),
    todayStats: $('todayStats'),
    clearCooldowns: $('clearCooldowns'),
    resetStats: $('resetStats'),
    exportBtn: $('exportBtn'),
    importBtn: $('importBtn'),
    importFile: $('importFile'),
    savebar: document.querySelector('.savebar'),
    toast: $('toast'),
  };

  function send(message) {
    return chrome.runtime.sendMessage(message).catch((err) => ({ ok: false, error: String(err) }));
  }

  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2400);
  }

  /* ------------------------------------------------------------------ */
  /* tabs                                                               */
  /* ------------------------------------------------------------------ */

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t === tab));
      document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === 'pane-' + tab.dataset.tab));
      location.hash = tab.dataset.tab;
    });
  });
  if (location.hash.length > 1) {
    const wanted = location.hash.slice(1);
    const tab = document.querySelector(`.tab[data-tab="${wanted}"]`);
    if (tab) tab.click();
  }

  /* ------------------------------------------------------------------ */
  /* load + save                                                        */
  /* ------------------------------------------------------------------ */

  async function load() {
    const res = await send({ type: 'status' });
    if (!res || !res.ok) {
      toast('Could not reach the background worker — reload the extension');
      return;
    }
    status = res;
    settings = buildSettingsFromStatus(res);
    renderAll();
  }

  function buildSettingsFromStatus(res) {
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
      pause: {
        holdMs: res.pause.holdMs,
        presets: res.pause.presets,
        maxPerDay: res.pause.maxPerDay,
        minGapMinutes: res.pause.minGapMinutes,
        strict: res.pause.strict,
      },
      behavior: res.behavior || Config.defaultSettings().behavior,
    });
  }

  function scheduleSave(immediate) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, immediate ? 0 : 220);
  }

  async function persist() {
    if (!settings) return;
    const res = await send({ type: 'saveSettings', settings });
    if (res && res.ok) {
      status = res;
      el.savebar.classList.add('show');
      setTimeout(() => el.savebar.classList.remove('show'), 1400);
      renderUsage(res);
    } else {
      toast('Save failed');
    }
  }

  /* ------------------------------------------------------------------ */
  /* render                                                             */
  /* ------------------------------------------------------------------ */

  function renderAll() {
    el.master.checked = settings.enabled;
    el.masterLabel.textContent = settings.enabled ? 'Tracking on' : 'Tracking off';

    el.closeOnBlur.checked = settings.behavior.closeOnBlur;
    el.blockNewTabs.checked = settings.behavior.blockNewTabs;
    el.showChip.checked = settings.behavior.showChip;
    el.notifyOnEnd.checked = settings.behavior.notifyOnEnd;

    el.defCooldown.value = Math.round(settings.defaults.cooldownSeconds / 60);
    el.defGrace.value = settings.defaults.graceSeconds;
    el.defCap.value = Math.round(settings.defaults.maxSessionSeconds / 60);

    el.holdMs.value = settings.pause.holdMs / 1000;
    el.holdMsOut.textContent = (settings.pause.holdMs / 1000).toFixed(1) + 's';
    el.maxPerDay.value = settings.pause.maxPerDay;
    el.minGap.value = settings.pause.minGapMinutes;
    el.strict.checked = settings.pause.strict;

    renderSites();
    renderSuggestions();
    renderPresets();
    if (status) renderUsage(status);
  }

  function siteSummaryChips(site) {
    const state = status && status.sites.find((s) => s.pattern === site.pattern);
    let live = '';
    if (state && state.session) live = '<span class="badge active">open</span>';
    else if (state && state.cooldownUntil) live = `<span class="badge cooling">${Util.clock(state.cooldownRemaining / 1000)}</span>`;
    return `
      ${live}
      <span class="badge off">${Util.humanDuration(site.cooldownSeconds)} lock</span>
      <span class="badge off">${Util.humanDuration(site.graceSeconds)} grace</span>
      <span class="badge off">${Util.humanDuration(site.maxSessionSeconds)} cap</span>
    `;
  }

  function renderSites() {
    el.sitesList.innerHTML = '';
    if (!settings.sites.length) {
      el.sitesList.innerHTML = '<div class="card center muted small">No sites yet. Add one above — the classic five are one click away.</div>';
      return;
    }

    for (const site of settings.sites) {
      const state = status && status.sites.find((s) => s.pattern === site.pattern);
      const card = document.createElement('div');
      card.className = 'site-card' + (site.enabled ? '' : ' off');
      if (state && state.session) card.classList.add('open');
      else if (state && state.cooldownUntil) card.classList.add('cooling');
      card.dataset.pattern = site.pattern;

      const initial = (site.label || site.pattern).slice(0, 1).toUpperCase();
      const faviconUrl = `https://icons.duckduckgo.com/ip3/${encodeURIComponent(site.pattern)}.ico`;

      card.innerHTML = `
        <div class="site-head">
          <div class="favicon">
            <img src="${faviconUrl}" alt="" loading="lazy"
              onerror="this.remove();this.parentNode.textContent='${initial}'" />
          </div>
          <div>
            <div class="site-name">${escapeHtml(site.label)}</div>
            <div class="site-host">${escapeHtml(site.pattern)}</div>
          </div>
          <div class="site-summary">${siteSummaryChips(site)}</div>
          <label class="switch" title="Enforce this site">
            <input type="checkbox" class="site-enabled" ${site.enabled ? 'checked' : ''} />
            <span></span>
          </label>
        </div>
        <div class="site-body">
          <div class="slider-row">
            <div class="spread">
              <label>Cooldown after you leave</label>
              <span class="val sl-cooldown">${Util.humanDuration(site.cooldownSeconds)}</span>
            </div>
            <input type="range" class="r-cooldown" min="1" max="120" step="1" value="${Math.min(120, Math.round(site.cooldownSeconds / 60))}" />
            <p class="hint">How long the site stays locked once a visit ends badly.</p>
          </div>
          <div class="slider-row">
            <div class="spread">
              <label>Grace window</label>
              <span class="val sl-grace">${site.graceSeconds}s</span>
            </div>
            <input type="range" class="r-grace" min="0" max="120" step="1" value="${Math.min(120, site.graceSeconds)}" />
            <p class="hint">Free time at the start where leaving costs nothing. 0 = instant lock on leaving.</p>
          </div>
          <div class="slider-row">
            <div class="spread">
              <label>Focus cap</label>
              <span class="val sl-cap">${Util.humanDuration(site.maxSessionSeconds)}</span>
            </div>
            <input type="range" class="r-cap" min="1" max="60" step="1" value="${Math.min(60, Math.round(site.maxSessionSeconds / 60))}" />
            <p class="hint">Focused time before the tab closes itself, even if you are being good.</p>
          </div>
          <div class="spread">
            <button class="btn btn-sm btn-ghost expand">Edit</button>
            <div class="row">
              ${state && (state.cooldownUntil || state.session) ? '<button class="btn btn-sm btn-ghost clear-one">Clear lock</button>' : ''}
              <button class="btn btn-sm btn-danger remove">Remove</button>
            </div>
          </div>
        </div>
      `;

      // interactions
      const head = card.querySelector('.site-head');
      head.addEventListener('click', (e) => {
        if (e.target.closest('.switch')) return;
        card.classList.toggle('expanded');
        card.querySelector('.expand').textContent = card.classList.contains('expanded') ? 'Done' : 'Edit';
      });
      card.querySelector('.expand').addEventListener('click', () => {
        card.classList.toggle('expanded');
        card.querySelector('.expand').textContent = card.classList.contains('expanded') ? 'Done' : 'Edit';
      });

      card.querySelector('.site-enabled').addEventListener('change', (e) => {
        site.enabled = e.target.checked;
        card.classList.toggle('off', !site.enabled);
        scheduleSave(true);
      });

      const wire = (selector, key, fmt, toValue, after) => {
        const input = card.querySelector(selector);
        input.addEventListener('input', () => {
          const value = toValue(Number(input.value));
          site[key] = value;
          card.querySelector(after).textContent = fmt(value);
          scheduleSave();
        });
      };
      wire('.r-cooldown', 'cooldownSeconds', (v) => Util.humanDuration(v), (v) => v * 60, '.sl-cooldown');
      wire('.r-grace', 'graceSeconds', (v) => v + 's', (v) => v, '.sl-grace');
      wire('.r-cap', 'maxSessionSeconds', (v) => Util.humanDuration(v), (v) => v * 60, '.sl-cap');

      card.querySelector('.remove').addEventListener('click', () => {
        settings.sites = settings.sites.filter((s) => s.pattern !== site.pattern);
        renderSites();
        renderSuggestions();
        scheduleSave(true);
      });

      const clearOne = card.querySelector('.clear-one');
      if (clearOne) {
        clearOne.addEventListener('click', async (e) => {
          e.stopPropagation();
          await send({ type: 'clearSite', pattern: site.pattern });
          toast(`${site.label} lock cleared`);
          await load();
        });
      }

      el.sitesList.appendChild(card);
    }
  }

  function renderSuggestions() {
    const existing = new Set(settings.sites.map((s) => s.pattern));
    const remaining = Config.PRESET_SITES.filter((p) => !existing.has(p)).slice(0, 8);
    el.suggestions.innerHTML = '';
    for (const pattern of remaining) {
      const btn = document.createElement('button');
      btn.className = 'suggestion';
      btn.type = 'button';
      btn.textContent = '+ ' + pattern;
      btn.addEventListener('click', () => addSite(pattern));
      el.suggestions.appendChild(btn);
    }
  }

  function renderPresets() {
    el.presetChips.innerHTML = '';
    for (const minutes of settings.pause.presets) {
      const chip = document.createElement('span');
      chip.className = 'chip-preset';
      chip.innerHTML = `${minutes} min <button title="Remove">✕</button>`;
      chip.querySelector('button').addEventListener('click', () => {
        if (settings.pause.presets.length <= 1) {
          toast('Keep at least one option');
          return;
        }
        settings.pause.presets = settings.pause.presets.filter((m) => m !== minutes);
        renderPresets();
        scheduleSave(true);
      });
      el.presetChips.appendChild(chip);
    }
  }

  function renderUsage(res) {
    const pause = res.pause;
    el.pauseUsage.textContent = pause.active
      ? `Paused for ${Util.clock(pause.remaining / 1000)} more. ${pause.remainingToday} of ${pause.maxPerDay} pauses left.`
      : `${pause.usedToday} of ${pause.maxPerDay} pauses used · ${pause.remainingToday} left.`;
    el.resumeNow.disabled = !pause.active;

    el.todayStats.innerHTML = '';
    const cells = [
      { value: Util.humanDuration(res.stats.focusSeconds), label: 'focused today' },
      { value: String(res.stats.blocked), label: 'blocks today' },
      { value: String(res.stats.sessions), label: 'visits started' },
      { value: `${pause.usedToday}/${pause.maxPerDay}`, label: 'pauses used' },
    ];
    for (const cell of cells) {
      const div = document.createElement('div');
      div.className = 'stat-cell';
      div.innerHTML = `<b>${escapeHtml(cell.value)}</b><span>${escapeHtml(cell.label)}</span>`;
      el.todayStats.appendChild(div);
    }
  }

  /* ------------------------------------------------------------------ */
  /* add / remove sites                                                  */
  /* ------------------------------------------------------------------ */

  function addSite(raw) {
    const pattern = Util.normalizeSite(raw);
    if (!pattern) {
      toast('That does not look like a domain');
      return;
    }
    if (settings.sites.some((s) => s.pattern === pattern)) {
      toast('Already tracked');
      return;
    }
    const defaults = settings.defaults;
    settings.sites.push({
      id: 'site_' + Math.random().toString(36).slice(2, 9),
      pattern,
      label: Util.siteLabel(pattern),
      enabled: true,
      cooldownSeconds: defaults.cooldownSeconds,
      graceSeconds: defaults.graceSeconds,
      maxSessionSeconds: defaults.maxSessionSeconds,
    });
    el.addInput.value = '';
    renderSites();
    renderSuggestions();
    scheduleSave(true);
  }

  el.addBtn.addEventListener('click', () => addSite(el.addInput.value));
  el.addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addSite(el.addInput.value);
  });

  el.applyAll.addEventListener('click', () => {
    const first = settings.sites[0];
    if (!first) return;
    for (const site of settings.sites) {
      site.cooldownSeconds = first.cooldownSeconds;
      site.graceSeconds = first.graceSeconds;
      site.maxSessionSeconds = first.maxSessionSeconds;
    }
    renderSites();
    scheduleSave(true);
    toast('Applied to every site');
  });

  /* ------------------------------------------------------------------ */
  /* simple bindings                                                    */
  /* ------------------------------------------------------------------ */

  el.master.addEventListener('change', () => {
    settings.enabled = el.master.checked;
    el.masterLabel.textContent = settings.enabled ? 'Tracking on' : 'Tracking off';
    scheduleSave(true);
  });

  for (const [input, key] of [
    [el.closeOnBlur, 'closeOnBlur'],
    [el.blockNewTabs, 'blockNewTabs'],
    [el.showChip, 'showChip'],
    [el.notifyOnEnd, 'notifyOnEnd'],
  ]) {
    input.addEventListener('change', () => {
      settings.behavior[key] = input.checked;
      scheduleSave(true);
    });
  }

  const bindDefault = (input, key, transform, format) => {
    input.addEventListener('change', () => {
      const raw = Number(input.value) || 0;
      settings.defaults[key] = transform(raw);
      if (format) input.value = format(settings.defaults[key]);
      scheduleSave(true);
    });
  };
  bindDefault(el.defCooldown, 'cooldownSeconds', (v) => Math.max(10, Math.round(v * 60)), (v) => Math.round(v / 60));
  bindDefault(el.defGrace, 'graceSeconds', (v) => Math.max(0, Math.round(v)), (v) => v);
  bindDefault(el.defCap, 'maxSessionSeconds', (v) => Math.max(30, Math.round(v * 60)), (v) => Math.round(v / 60));

  el.holdMs.addEventListener('input', () => {
    settings.pause.holdMs = Math.round(Number(el.holdMs.value) * 1000);
    el.holdMsOut.textContent = (settings.pause.holdMs / 1000).toFixed(1) + 's';
    scheduleSave();
  });

  el.maxPerDay.addEventListener('change', () => {
    settings.pause.maxPerDay = Util.clamp(Number(el.maxPerDay.value) || 0, 0, 10);
    el.maxPerDay.value = settings.pause.maxPerDay;
    scheduleSave(true);
  });

  el.minGap.addEventListener('change', () => {
    settings.pause.minGapMinutes = Util.clamp(Number(el.minGap.value) || 0, 0, 480);
    el.minGap.value = settings.pause.minGapMinutes;
    scheduleSave(true);
  });

  el.strict.addEventListener('change', () => {
    settings.pause.strict = el.strict.checked;
    scheduleSave(true);
  });

  el.addPreset.addEventListener('click', () => {
    const minutes = Util.clamp(Number(el.newPreset.value) || 0, 1, 30);
    if (!minutes) return;
    if (settings.pause.presets.length >= 4) {
      toast('Four presets is the maximum');
      return;
    }
    if (settings.pause.presets.includes(minutes)) {
      toast('Already there');
      return;
    }
    settings.pause.presets = settings.pause.presets.concat(minutes).sort((a, b) => a - b);
    el.newPreset.value = '';
    renderPresets();
    scheduleSave(true);
  });

  el.resumeNow.addEventListener('click', async () => {
    const res = await send({ type: 'stopPause' });
    if (res && res.ok) {
      toast('Tracking resumed');
      await load();
    }
  });

  el.clearCooldowns.addEventListener('click', async () => {
    if (!confirm('Clear every cooldown and end the current pause?')) return;
    await send({ type: 'clearCooldowns' });
    toast('All locks cleared');
    await load();
  });

  el.resetStats.addEventListener('click', async () => {
    if (!confirm('Reset all statistics?')) return;
    await send({ type: 'resetStats' });
    toast('Statistics reset');
    await load();
  });

  el.exportBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'focusfrost-settings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });

  el.importBtn.addEventListener('click', () => el.importFile.click());
  el.importFile.addEventListener('change', async () => {
    const file = el.importFile.files && el.importFile.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      settings = Config.normalizeSettings(JSON.parse(text));
      renderAll();
      scheduleSave(true);
      toast('Settings imported');
    } catch (_) {
      toast('That file is not valid FocusFrost settings');
    }
    el.importFile.value = '';
  });

  /* live refreshes so locks and timers stay current */
  setInterval(async () => {
    const res = await send({ type: 'status' });
    if (res && res.ok) {
      status = res;
      renderUsage(res);
    }
  }, 2000);

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  load();
})();
