/* FocusFrost — popup controller */
(function () {
  'use strict';

  const Util = window.FFUtil;
  const Config = window.FFConfig;
  const CIRC = 219.9;

  const $ = (id) => document.getElementById(id);
  const el = {
    master: $('master'),
    settings: $('settings'),
    tagline: $('tagline'),
    heroMeter: $('heroMeter'),
    heroLabel: $('heroLabel'),
    heroClock: $('heroClock'),
    heroSub: $('heroSub'),
    pauseChip: $('pauseChip'),
    usageChip: $('usageChip'),
    presets: $('presets'),
    holdBtn: $('holdBtn'),
    holdFill: $('holdFill'),
    holdLabel: $('holdLabel'),
    holdTip: $('holdTip'),
    resumeBtn: $('resumeBtn'),
    pauseMsg: $('pauseMsg'),
    editSites: $('editSites'),
    siteList: $('siteList'),
    statFocus: $('statFocus'),
    statBlocked: $('statBlocked'),
    dashboard: $('dashboard'),
    statTurnedAway: $('statTurnedAway'),
    toast: $('toast'),
  };

  let status = null;
  let selectedMinutes = null;
  let holding = false;
  let holdStart = 0;
  let holdRaf = null;
  let toastTimer = null;

  function send(message) {
    return chrome.runtime.sendMessage(message).catch((err) => ({ ok: false, error: String(err) }));
  }

  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
  }

  /* ------------------------------------------------------------------ */
  /* data                                                               */
  /* ------------------------------------------------------------------ */

  let retries = 0;

  async function refresh() {
    const res = await send({ type: 'status' });
    if (!res || !res.ok) {
      // The service worker can be asleep on the very first call; give it a moment.
      if (retries++ < 8) {
        setTimeout(refresh, 120);
        return;
      }
      el.heroLabel.textContent = 'Disconnected';
      el.heroSub.textContent = 'Reload the extension to reconnect.';
      return;
    }
    retries = 0;
    status = res;
    if (selectedMinutes === null) selectedMinutes = res.pause.presets[0] || 5;
    render();
  }

  function render() {
    if (!status) return;
    const now = Date.now();
    const pause = status.pause;
    const active = status.sites.filter((s) => s.session);
    const cooling = status.sites.filter((s) => s.cooldownUntil > 0);

    el.master.checked = status.enabled;
    el.tagline.textContent = status.enabled
      ? 'One tab. One task. One clock.'
      : 'Tracking is off. Nothing is being closed.';

    /* ---- hero ---- */
    let label = 'Idle';
    let clockText = '—';
    let sub = 'No tracked site open.';
    let color = '#7fd3ff';
    let progress = 0;

    if (pause.active) {
      label = 'Paused on purpose';
      clockText = Util.clock(pause.remaining / 1000);
      sub = `Tracked sites stay open for ${Util.humanDuration(pause.remaining / 1000)} more.`;
      color = '#7fd3ff';
      progress = pause.remaining / Math.max(1, (pause.minutes || 1) * 60000);
    } else if (active.length) {
      const s = active[0];
      const remaining = s.session.remainingSeconds;
      if (s.session.inGrace) {
        label = `${s.label} — grace window`;
        clockText = Util.clock(s.session.graceRemaining);
        sub = 'Leave now for free. After this, leaving locks it.';
        color = '#ffc46b';
        progress = s.session.graceRemaining / Math.max(1, s.graceSeconds);
      } else {
        label = `Focusing on ${s.label}`;
        clockText = Util.clock(remaining);
        sub = 'Switch away and the tab closes. That is the deal.';
        color = remaining < 30 ? '#ff7b8a' : '#45d6a8';
        progress = remaining / Math.max(1, s.session.capSeconds);
      }
    } else if (cooling.length) {
      const s = cooling.slice().sort((a, b) => a.cooldownRemaining - b.cooldownRemaining)[0];
      label = `${s.label} is cooling down`;
      clockText = Util.clock(s.cooldownRemaining / 1000);
      sub = `${s.cooldownLabel} · back at ${new Date(s.cooldownUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      color = '#9d8cff';
      progress = s.cooldownRemaining / Math.max(1, s.cooldownSeconds * 1000);
    } else if (!status.enabled) {
      label = 'Tracking off';
      clockText = '—';
      sub = 'Turn the switch on to start enforcing.';
      color = '#6b7b9b';
    }

    el.heroLabel.textContent = label;
    el.heroClock.textContent = clockText;
    el.heroSub.textContent = sub;
    el.heroMeter.style.stroke = color;
    el.heroMeter.style.strokeDashoffset = String(CIRC * (1 - Math.min(1, Math.max(0, progress))));
    el.heroClock.style.color = color === '#6b7b9b' ? 'var(--muted)' : 'var(--text)';

    el.pauseChip.textContent = pause.active ? `Paused ${Util.clock(pause.remaining / 1000)}` : 'Not paused';
    el.pauseChip.className = 'badge ' + (pause.active ? 'paused' : 'off');
    el.usageChip.textContent = `${pause.usedToday}/${pause.maxPerDay} pauses today`;
    el.usageChip.className = 'badge ' + (pause.remainingToday === 0 ? 'cooling' : 'off');

    renderPresets(pause);
    renderHold(pause);
    renderSites(active, cooling);

    el.statFocus.textContent = Util.humanDuration(status.stats.focusSeconds);
    el.statBlocked.textContent = String(status.stats.blocked);
    if (el.statTurnedAway) el.statTurnedAway.textContent = String(status.stats.turnedAway || 0);

    if (pause.active) {
      el.resumeBtn.classList.remove('hidden');
      el.pauseMsg.textContent = `Resume early? The pause still counts against today's ${pause.maxPerDay}.`;
    } else {
      el.resumeBtn.classList.add('hidden');
      el.pauseMsg.textContent = pauseMsg(pause);
    }
  }

  function pauseMsg(pause) {
    if (!pause.canStart) {
      if (pause.blockedReason === 'daily-limit') return `You have used all ${pause.maxPerDay} pauses today. Back tomorrow.`;
      if (pause.blockedReason === 'disabled') return 'Pauses are switched off in settings (0 per day).';
      if (pause.blockedReason === 'too-soon') {
        return `Next pause available in ${Util.clock((pause.retryAt - Date.now()) / 1000)} — the gap is ${pause.minGapMinutes} min.`;
      }
      if (pause.blockedReason === 'already-paused') return 'Already paused.';
    }
    return `Hard limit: ${pause.remainingToday} pause${pause.remainingToday === 1 ? '' : 's'} left today, ${pause.minGapMinutes} min apart.`;
  }

  function renderPresets(pause) {
    const wanted = pause.presets.join(',');
    if (el.presets.dataset.signature === wanted) return;
    el.presets.dataset.signature = wanted;
    el.presets.innerHTML = '';
    for (const minutes of pause.presets) {
      const btn = document.createElement('button');
      btn.className = 'preset';
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.dataset.minutes = String(minutes);
      btn.innerHTML = `<b>${minutes}</b><span>min${minutes === 1 ? '' : 's'}</span>`;
      btn.addEventListener('click', () => {
        selectedMinutes = minutes;
        renderPresets({ presets: pause.presets });
        renderHold(status.pause);
      });
      el.presets.appendChild(btn);
    }
  }

  function syncPresetSelection(pause) {
    for (const btn of el.presets.querySelectorAll('.preset')) {
      const on = Number(btn.dataset.minutes) === selectedMinutes;
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
      btn.classList.toggle('on', on);
    }
  }

  function renderHold(pause) {
    syncPresetSelection(pause);
    const canPause = pause.canStart && selectedMinutes && status.enabled;
    el.holdBtn.disabled = !canPause || holding;
    el.holdBtn.classList.toggle('holding', holding);
    const seconds = Math.round(pause.holdMs / 1000);

    if (pause.active) {
      el.holdLabel.innerHTML = `Pause ends in <b class="mono">${Util.clock(pause.remaining / 1000)}</b>`;
      el.holdTip.textContent = '';
      return;
    }
    if (!canPause) {
      el.holdLabel.innerHTML = 'Pause unavailable right now';
      el.holdTip.textContent = '';
      return;
    }
    el.holdLabel.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M9 5h2v14H9zM13 5h2v14h-2z"></path>
      </svg>
      Hold <b>${seconds}s</b> for ${selectedMinutes} min`;
    el.holdTip.textContent = 'hold to confirm';
  }

  function renderSites(active, cooling) {
    el.siteList.innerHTML = '';
    if (!status.sites.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No sites tracked yet. Add the ones that eat your day.';
      el.siteList.appendChild(li);
      return;
    }

    const sorted = status.sites.slice().sort((a, b) => {
      if (!!a.session !== !!b.session) return a.session ? -1 : 1;
      if (!!a.cooldownUntil !== !!b.cooldownUntil) return a.cooldownUntil ? -1 : 1;
      return a.label.localeCompare(b.label);
    });

    for (const site of sorted) {
      const li = document.createElement('li');
      li.className = 'site';
      if (site.session) li.classList.add('active');
      else if (site.cooldownUntil) li.classList.add('cooling');
      if (!site.enabled) li.classList.add('off');

      let clockText = '';
      let clockClass = '';
      if (site.session) {
        const left = site.session.inGrace ? site.session.graceRemaining : site.session.remainingSeconds;
        clockText = Util.clock(left);
        clockClass = 'live';
      } else if (site.cooldownUntil) {
        clockText = Util.clock(site.cooldownRemaining / 1000);
        clockClass = 'cool';
      }

      li.innerHTML = `
        <div class="site-name">
          <div class="favicon"></div>
          <div>
            <div class="site-label">${escapeHtml(site.label)}</div>
            <div class="site-sub">${escapeHtml(site.pattern)} · ${Util.humanDuration(
        site.cooldownSeconds
      )} lock · ${Util.humanDuration(site.graceSeconds)} grace</div>
          </div>
        </div>
        <div class="site-right">
          ${clockText ? `<span class="site-clock ${clockClass}">${clockText}</span>` : ''}
          <span class="badge ${site.session ? 'active' : site.cooldownUntil ? 'cooling' : 'off'}">${
        site.session ? 'open' : site.cooldownUntil ? 'locked' : 'ready'
      }</span>
        </div>
      `;
      // Icon + initial fallback, wired without inline handlers (CSP: script-src 'self').
      Util.favicon(li.querySelector('.favicon'), site.pattern, site.label);
      el.siteList.appendChild(li);
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ------------------------------------------------------------------ */
  /* hold-to-pause                                                      */
  /* ------------------------------------------------------------------ */

  function startHold(e) {
    if (e && e.button !== undefined && e.button !== 0) return;
    if (!status || !status.pause.canStart || holding) return;
    if (!status.enabled) {
      toast('Turn FocusFrost on first');
      return;
    }
    holding = true;
    holdStart = performance.now();
    el.holdBtn.classList.add('holding');
    el.holdFill.style.width = '0%';
    el.holdFill.classList.remove('done');
    const total = status.pause.holdMs;

    const tick = () => {
      if (!holding) return;
      const elapsed = performance.now() - holdStart;
      const pct = Math.min(100, (elapsed / total) * 100);
      el.holdFill.style.width = pct + '%';
      const left = Math.max(0, Math.ceil((total - elapsed) / 1000));
      el.holdLabel.innerHTML = `<b class="mono">${left}s</b> — keep holding…`;
      if (elapsed >= total) {
        completeHold();
        return;
      }
      holdRaf = requestAnimationFrame(tick);
    };
    holdRaf = requestAnimationFrame(tick);
  }

  function cancelHold() {
    if (!holding) return;
    holding = false;
    cancelAnimationFrame(holdRaf);
    holdRaf = null;
    el.holdFill.style.width = '0%';
    el.holdBtn.classList.remove('holding');
    render();
  }

  async function completeHold() {
    holding = false;
    cancelAnimationFrame(holdRaf);
    holdRaf = null;
    el.holdFill.style.width = '100%';
    el.holdFill.classList.add('done');
    el.holdBtn.classList.remove('holding');

    const res = await send({ type: 'startPause', minutes: selectedMinutes });
    if (res && res.ok) {
      const r = res.result || {};
      toast(`Paused for ${r.minutes || selectedMinutes} min — focus mode is off duty`);
      if (navigator.vibrate) navigator.vibrate(18);
    } else {
      toast('Could not pause: ' + ((res && res.result && res.result.reason) || 'not allowed'));
    }
    status = res && res.ok ? res : status;
    setTimeout(() => {
      el.holdFill.style.width = '0%';
      el.holdFill.classList.remove('done');
      refresh();
    }, 700);
    render();
  }

  el.holdBtn.addEventListener('pointerdown', (e) => {
    el.holdBtn.setPointerCapture && el.holdBtn.setPointerCapture(e.pointerId);
    startHold(e);
  });
  for (const evt of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) {
    el.holdBtn.addEventListener(evt, cancelHold);
  }
  el.holdBtn.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault();
      startHold();
    }
  });
  el.holdBtn.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') cancelHold();
  });
  el.holdBtn.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ------------------------------------------------------------------ */
  /* misc controls                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * The settings to save when a control here changes.
   *
   * This used to rebuild the object from the worker's snapshot, which only
   * carries the handful of fields the popup itself renders. Everything else —
   * the schedule, the friction screen, its alternative text, the breath window
   * — went missing, and since the worker takes a save as the whole truth it
   * wrote those defaults back. Flipping one switch in the popup quietly wiped
   * settings you had made on the settings page.
   *
   * The snapshot now carries the full settings object (`status.settings`), so
   * that is the base, and only the field this page actually owns is overridden.
   */
  function settingsFromStatus() {
    if (status.settings && typeof status.settings === 'object') {
      // Only the master switch is edited here; everything else is carried over
      // untouched by Config.mergeEdits().
      return Config.mergeEdits(status.settings, { enabled: el.master.checked });
    }
    // Older worker: rebuild what we can, so the switch still works.
    return {
      enabled: el.master.checked,
      sites: status.sites.map((s) => ({
        id: s.id,
        pattern: s.pattern,
        label: s.label,
        enabled: s.enabled,
        cooldownSeconds: s.cooldownSeconds,
        graceSeconds: s.graceSeconds,
        maxSessionSeconds: s.maxSessionSeconds,
      })),
      defaults: status.defaults,
      pause: {
        holdMs: status.pause.holdMs,
        presets: status.pause.presets,
        maxPerDay: status.pause.maxPerDay,
        minGapMinutes: status.pause.minGapMinutes,
        strict: status.pause.strict,
      },
      behavior: status.behavior,
    };
  }

  el.master.addEventListener('change', async () => {
    const res = await send({ type: 'saveSettings', settings: settingsFromStatus() });
    if (res && res.ok) {
      status = res;
      toast(el.master.checked ? 'Tracking on' : 'Tracking off — nothing will be closed');
      render();
    } else {
      el.master.checked = !el.master.checked;
      toast('Could not save');
    }
  });

  el.resumeBtn.addEventListener('click', async () => {
    const res = await send({ type: 'stopPause' });
    toast('Tracking resumed');
    if (res && res.ok) status = res;
    render();
  });

  // Settings are a full page of their own; the popup only links to them.
  const openSettings = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
    window.close();
  };
  el.settings.addEventListener('click', openSettings);
  el.editSites.addEventListener('click', openSettings);
  el.dashboard.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
    window.close();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });

  /* live ticking between refreshes */
  setInterval(() => {
    if (!status) return;
    const now = Date.now();
    if (status.pause.active) {
      status.pause.remaining = Math.max(0, status.pause.until - now);
      if (status.pause.remaining === 0) return refresh();
    }
    for (const site of status.sites) {
      if (site.session) {
        site.session.remainingSeconds = Math.max(0, site.session.remainingSeconds - 0.5);
        if (site.session.inGrace) site.session.graceRemaining = Math.max(0, site.session.graceRemaining - 0.5);
      }
      if (site.cooldownUntil) {
        site.cooldownRemaining = Math.max(0, site.cooldownUntil - now);
        if (site.cooldownRemaining === 0) return refresh();
      }
    }
    render();
  }, 500);

  refresh();
})();
