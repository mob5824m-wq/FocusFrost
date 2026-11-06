/* FocusFrost — dashboard controller */
(function () {
  'use strict';

  const Util = window.FFUtil;
  const Config = window.FFConfig;
  const Engine = window.FFEngine;
  const Sim = window.FFSimulator;

  const $ = (id) => document.getElementById(id);
  let status = null;
  let sim = null;
  let toastTimer = null;

  function send(message) {
    return chrome.runtime.sendMessage(message).catch(() => ({ ok: false }));
  }

  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ------------------------------------------------------------------ */
  /* live data                                                          */
  /* ------------------------------------------------------------------ */

  async function load() {
    const res = await send({ type: 'status' });
    if (!res || !res.ok) {
      toast('Background worker unreachable — reload the extension');
      return;
    }
    status = res;
    render();
    if (!sim) initSimulator(res);
  }

  function render() {
    if (!status) return;
    const now = Date.now();
    $('todayLabel').textContent = new Date(now).toLocaleDateString([], {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    }) +
      ' · ' +
      (status.enabled ? 'tracking on' : 'tracking off');

    const badge = $('modeBadge');
    if (status.pause.active) {
      badge.textContent = `Paused ${Util.clock(status.pause.remaining / 1000)}`;
      badge.className = 'badge paused';
    } else if (status.totals.active) {
      badge.textContent = `${status.totals.active} site open`;
      badge.className = 'badge active';
    } else if (status.totals.cooling) {
      badge.textContent = `${status.totals.cooling} cooling down`;
      badge.className = 'badge cooling';
    } else {
      badge.textContent = status.enabled ? 'Idle' : 'Off';
      badge.className = 'badge off';
    }

    $('mFocus').textContent = Util.humanDuration(status.stats.focusSeconds);
    $('mBlocked').textContent = String(status.stats.blocked);
    $('mSessions').textContent = String(status.stats.sessions);
    $('mPauses').textContent = `${status.pause.usedToday}/${status.pause.maxPerDay}`;
    $('mPausesSub').textContent = status.pause.active
      ? `active: ${Util.clock(status.pause.remaining / 1000)} left`
      : `${status.pause.remainingToday} left today`;

    renderBars();
    renderTable();
  }

  function renderBars() {
    const bars = $('bars');
    bars.innerHTML = '';
    const sites = status.sites.slice().sort((a, b) => b.focusSecondsToday - a.focusSecondsToday);
    const max = Math.max(1, ...sites.map((s) => s.focusSecondsToday));
    for (const site of sites) {
      const row = document.createElement('div');
      row.className = 'bar-row' + (site.focusSecondsToday ? '' : ' empty');
      row.innerHTML = `
        <span class="bar-name">${escapeHtml(site.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${(site.focusSecondsToday / max) * 100}%"></span></span>
        <span class="bar-value">${site.focusSecondsToday ? Util.humanDuration(site.focusSecondsToday) : '—'}</span>
      `;
      bars.appendChild(row);
    }
    if (!sites.length) bars.innerHTML = '<p class="hint-empty">No tracked sites yet.</p>';
  }

  function renderTable() {
    const table = $('table');
    table.innerHTML = `
      <div class="trow head">
        <span>Site</span>
        <span>State</span>
        <span class="tnum hide-sm">Focus left</span>
        <span class="tnum hide-sm">Cooldown</span>
        <span class="tnum hide-sm">Best today</span>
        <span>Rules</span>
      </div>
    `;
    for (const site of status.sites) {
      const row = document.createElement('div');
      row.className = 'trow';
      let stateText = site.enabled ? 'ready' : 'off';
      if (site.session) stateText = site.session.inGrace ? 'grace' : 'open';
      else if (site.cooldownUntil) stateText = 'locked';
      if (site.session) row.classList.add('active');
      else if (site.cooldownUntil) row.classList.add('cooling');

      row.innerHTML = `
        <span class="tname">${escapeHtml(site.label)}</span>
        <span><span class="badge ${
          site.session ? (site.session.inGrace ? 'grace' : 'active') : site.cooldownUntil ? 'cooling' : 'off'
        }">${stateText}</span></span>
        <span class="tnum hide-sm">${
          site.session ? Util.clock(site.session.remainingSeconds) : '—'
        }</span>
        <span class="tnum hide-sm">${site.cooldownUntil ? Util.clock(site.cooldownRemaining / 1000) : '—'}</span>
        <span class="tnum hide-sm">${site.bestFocusSeconds ? Util.humanDuration(site.bestFocusSeconds) : '—'}</span>
        <span class="tiny dim">${Util.humanDuration(site.cooldownSeconds)} lock · ${Util.humanDuration(
        site.graceSeconds
      )} grace · ${Util.humanDuration(site.maxSessionSeconds)} cap</span>
      `;
      table.appendChild(row);
    }
    if (!status.sites.length) {
      table.innerHTML += '<p class="hint-empty">Nothing tracked yet — add a site in settings.</p>';
    }
  }

  /* ------------------------------------------------------------------ */
  /* sandbox                                                            */
  /* ------------------------------------------------------------------ */

  function initSimulator(res) {
    sim = Sim.createSimulator(Engine, Config, {
      sites: res.sites.map((s) => ({
        id: s.id,
        pattern: s.pattern,
        label: s.label,
        enabled: s.enabled,
        cooldownSeconds: s.cooldownSeconds,
        graceSeconds: s.graceSeconds,
        maxSessionSeconds: s.maxSessionSeconds,
      })),
      pause: res.pause,
      behavior: res.behavior,
    });

    const siteSelect = $('simSite');
    siteSelect.innerHTML = '';
    for (const site of res.sites) {
      const option = document.createElement('option');
      option.value = site.pattern;
      option.textContent = site.label;
      siteSelect.appendChild(option);
    }

    const minutesSelect = $('simMinutes');
    minutesSelect.innerHTML = '';
    for (const minutes of res.pause.presets) {
      const option = document.createElement('option');
      option.value = String(minutes);
      option.textContent = `${minutes} min`;
      minutesSelect.appendChild(option);
    }

    document.querySelectorAll('[data-sim]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.sim;
        const pattern = siteSelect.value;
        if (action === 'open') sim.open(pattern);
        else if (action === 'blur') sim.blur(pattern);
        else if (action === 'return') sim.open(pattern);
        else if (action === 'close') sim.close(pattern);
        else if (action === 'pause') sim.pause(Number(minutesSelect.value));
        else if (action === 'reset') sim.reset();
        else if (action.startsWith('+')) sim.tick(Number(action.slice(1)));
      });
    });

    sim.subscribe((snap) => {
      const host = snap.sites;
      const active = host.filter((s) => s.session);
      const cooling = host.filter((s) => s.cooldownUntil);
      let clockText = '0:00';
      let text = snap.focused ? 'Simulated tab focused' : 'Simulated tab blurred';

      if (snap.pause.active) {
        clockText = Util.clock(snap.pause.remaining / 1000);
        text = `Paused — ${snap.pause.remainingToday} pauses left today`;
      } else if (active.length) {
        const s = active[0].session;
        clockText = Util.clock(s.inGrace ? s.graceRemaining : s.remainingSeconds);
        text = s.inGrace ? `${active[0].label}: grace window` : `${active[0].label}: focused`;
      } else if (cooling.length) {
        clockText = Util.clock(cooling[0].cooldownRemaining / 1000);
        text = `${cooling[0].label}: cooling down`;
      }

      $('simClock').textContent = clockText;
      $('simStatus').textContent = text;

      const logEl = $('simLog');
      logEl.innerHTML = snap.lines
        .map((l) => `<span class="${l.kind}">${escapeHtml(l.stamp)}  ${escapeHtml(l.text)}</span>`)
        .join('\n');
      logEl.scrollTop = logEl.scrollHeight;
    });
  }

  /* ------------------------------------------------------------------ */
  /* wiring                                                             */
  /* ------------------------------------------------------------------ */

  $('settingsBtn').addEventListener('click', () => send({ type: 'openOptions' }));
  $('clearAll').addEventListener('click', async () => {
    if (!confirm('Clear every cooldown and end the current pause?')) return;
    await send({ type: 'clearCooldowns' });
    toast('All locks cleared');
    await load();
  });

  setInterval(async () => {
    const res = await send({ type: 'status' });
    if (res && res.ok) {
      status = res;
      render();
    }
  }, 2000);

  load();
})();
