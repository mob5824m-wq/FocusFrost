/* FocusFrost — blocked page */
(function () {
  'use strict';

  const Util = window.FFUtil;
  const CIRC = 603.2;
  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(location.search);
  const site = params.get('site') || 'this site';
  const reason = params.get('reason') || 'cooldown';
  const initialUntil = Number(params.get('until')) || 0;

  let until = initialUntil;
  let cooldownTotal = 0;
  let status = null;
  let selectedMinutes = null;
  let holding = false;
  let holdStart = 0;
  let raf = null;
  let toastTimer = null;

  const el = {
    clock: $('clock'),
    clockLabel: $('clockLabel'),
    ring: $('ring'),
    title: $('title'),
    subtitle: $('subtitle'),
    detail: $('detail'),
    reasonBadge: $('reasonBadge'),
    back: $('backBtn'),
    pause: $('pauseBtn'),
    settings: $('settingsBtn'),
    panel: $('pausePanel'),
    closePanel: $('closePanel'),
    presets: $('presets'),
    hold: $('holdBtn'),
    fill: $('holdFill'),
    holdLabel: $('holdLabel'),
    pauseMsg: $('pauseMsg'),
    stats: $('statsLine'),
    toast: $('toast'),
  };

  const labelFor = {
    'second-tab': 'Already open elsewhere',
    cooldown: 'Cooling down',
    'daily-limit': 'Out of pauses',
  };

  function send(message) {
    return chrome.runtime.sendMessage(message).catch(() => ({ ok: false }));
  }

  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2800);
  }

  function prettySite(str) {
    const base = String(str).split('.').slice(0, -1).join('.') || String(str);
    return base.replace(/(^|\.)([a-z])/g, (m, d, c) => d + c.toUpperCase());
  }

  const siteName = prettySite(site);

  /* ---------------- the "second tab" state is different ---------------- */
  if (reason === 'second-tab') {
    document.body.classList.add('second-tab');
    el.title.textContent = `${siteName} is already open.`;
    el.subtitle.textContent = 'One visit, one tab. Go back to the tab you already have.';
    el.detail.textContent = 'FocusFrost only lets a tracked site live in a single tab, so you cannot fan out.';
    el.reasonBadge.textContent = labelFor['second-tab'];
    el.clock.style.fontSize = '28px';
    el.clock.textContent = '1 tab';
    el.clockLabel.textContent = 'is all you get';
    el.ring.style.strokeDashoffset = String(CIRC * 0.35);
    el.ring.style.stroke = 'var(--amber)';
    el.reasonBadge.className = 'badge grace';
    el.pause.textContent = 'Pause anyway';
    el.back.textContent = 'Go to that tab';
    el.back.addEventListener('click', async () => {
      const otherTab = Number(params.get('otherTab')) || null;
      if (otherTab) {
        try {
          await chrome.tabs.update(otherTab, { active: true });
          window.close();
          return;
        } catch (_) {}
      }
      history.length > 1 ? history.back() : (location.href = 'chrome://newtab');
    });
  }

  /* ---------------- status + cooldown clock ---------------- */

  async function refresh() {
    const res = await send({ type: 'status' });
    if (!res || !res.ok) {
      el.detail.textContent = 'FocusFrost could not be reached. Reload the extension in chrome://extensions.';
      return;
    }
    status = res;
    if (selectedMinutes === null) selectedMinutes = res.pause.presets[0] || 5;

    const match = res.sites.find((s) => s.pattern === site);
    if (match && match.cooldownUntil) {
      until = match.cooldownUntil;
      cooldownTotal = (match.cooldownSeconds || 600) * 1000;
    } else if (match && !match.cooldownUntil && reason !== 'second-tab') {
      // The lockout was lifted (pause started, settings changed, cooldown ended).
      unlocked(match);
      return;
    } else if (res.pause.active && reason !== 'second-tab') {
      unlocked(match);
      return;
    }

    if (!cooldownTotal) cooldownTotal = Math.max(1000, until - Date.now());

    el.reasonBadge.textContent = labelFor[reason] || 'Cooling down';
    el.reasonBadge.className = 'badge ' + (reason === 'second-tab' ? 'grace' : 'cooling');
    el.reasonBadge.textContent = (match && match.cooldownLabel) || labelFor[reason] || 'Cooling down';

    if (reason === 'second-tab') return;

    el.title.textContent = `${siteName} is cooling down.`;
    el.subtitle.textContent = 'The clock started when you left. It is not going to shorten itself.';
    const endsAt = new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    el.detail.textContent = `You can come back at ${endsAt}. Until then, everything else on the internet still works.`;

    el.stats.textContent = `${res.stats.blocked} distraction${res.stats.blocked === 1 ? '' : 's'} blocked today · ${Util.humanDuration(
      res.stats.focusSeconds
    )} focused · ${res.pause.remainingToday} pause${res.pause.remainingToday === 1 ? '' : 's'} left`;

    renderPauseUi();
    tick();
  }

  function unlocked(match) {
    el.title.textContent = `You are free to go.`;
    el.subtitle.textContent = `${siteName} is unlocked. This page will take you there now.`;
    el.detail.textContent = 'Stay focused. One tab, one task.';
    el.reasonBadge.textContent = 'Unlocked';
    el.reasonBadge.className = 'badge active';
    el.clock.textContent = '0:00';
    el.ring.style.strokeDashoffset = '0';
    el.ring.style.stroke = 'var(--mint)';
    el.back.classList.add('hidden');
    el.pause.classList.add('hidden');
    setTimeout(() => {
      location.replace(`https://${(match && match.pattern) || site}`);
    }, 900);
  }

  function tick() {
    const now = Date.now();
    const left = Math.max(0, until - now);
    el.clock.textContent = Util.clock(left / 1000);
    const progress = cooldownTotal ? left / cooldownTotal : 0;
    el.ring.style.strokeDashoffset = String(CIRC * (1 - Math.min(1, Math.max(0, progress))));
    el.ring.style.stroke = left < 60000 ? 'var(--amber)' : 'var(--violet)';
    el.clockLabel.textContent = left < 60000 ? 'almost there' : 'until you can go back';

    if (left <= 0) {
      clearInterval(timer);
      refresh();
    }
  }

  const timer = setInterval(tick, 1000);

  /* ---------------- pause panel ---------------- */

  el.pause.addEventListener('click', () => {
    el.panel.classList.toggle('hidden');
    if (!el.panel.classList.contains('hidden')) renderPauseUi();
  });
  el.closePanel.addEventListener('click', () => el.panel.classList.add('hidden'));

  function renderPauseUi() {
    if (!status) return;
    const pause = status.pause;
    const presetsSig = pause.presets.join(',');
    if (el.presets.dataset.sig !== presetsSig || el.presets.childElementCount === 0) {
      el.presets.dataset.sig = presetsSig;
      el.presets.innerHTML = '';
      for (const minutes of pause.presets) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'preset';
        b.setAttribute('role', 'radio');
        b.dataset.minutes = String(minutes);
        b.innerHTML = `<b>${minutes}</b><span>min${minutes === 1 ? '' : 's'}</span>`;
        b.addEventListener('click', () => {
          selectedMinutes = minutes;
          syncPresets();
          renderPauseUi();
        });
        el.presets.appendChild(b);
      }
    }
    syncPresets();

    const canPause = pause.canStart;
    el.hold.disabled = !canPause || holding;
    const seconds = Math.round(pause.holdMs / 1000);
    if (canPause) {
      el.holdLabel.textContent = `Hold ${seconds}s to unlock ${selectedMinutes} min`;
      const gate = pause.remainingToday;
      el.pauseMsg.textContent = `${gate} pause${gate === 1 ? '' : 's'} left today · at least ${pause.minGapMinutes} min between pauses.`;
    } else {
      el.holdLabel.textContent = 'Pause unavailable';
      el.holdLabel.style.fontSize = '12px';
      if (pause.blockedReason === 'daily-limit') {
        el.pauseMsg.textContent = `You have used all ${pause.maxPerDay} pauses today. This is the part that makes it work.`;
      } else if (pause.blockedReason === 'too-soon') {
        el.pauseMsg.textContent = `Next pause unlocked in ${Util.clock((pause.retryAt - Date.now()) / 1000)}.`;
      } else if (pause.blockedReason === 'disabled') {
        el.pauseMsg.textContent = 'Pauses are disabled in settings.';
      } else {
        el.pauseMsg.textContent = 'Already paused.';
      }
    }
  }

  function syncPresets() {
    for (const b of el.presets.querySelectorAll('.preset')) {
      b.setAttribute('aria-checked', Number(b.dataset.minutes) === selectedMinutes ? 'true' : 'false');
    }
  }

  /* ---------------- hold to pause ---------------- */

  function startHold(e) {
    if (e && e.button !== undefined && e.button !== 0) return;
    if (!status || !status.pause.canStart || holding) return;
    holding = true;
    holdStart = performance.now();
    el.hold.classList.add('holding');
    el.fill.style.width = '0%';
    el.fill.classList.remove('done');
    const total = status.pause.holdMs;

    const step = () => {
      if (!holding) return;
      const elapsed = performance.now() - holdStart;
      el.fill.style.width = Math.min(100, (elapsed / total) * 100) + '%';
      const left = Math.max(0, Math.ceil((total - elapsed) / 1000));
      el.holdLabel.textContent = `${left}s — keep holding`;
      if (elapsed >= total) return finishHold();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  function cancelHold() {
    if (!holding) return;
    holding = false;
    cancelAnimationFrame(raf);
    el.fill.style.width = '0%';
    el.hold.classList.remove('holding');
    renderPauseUi();
    el.holdLabel.style.fontSize = '';
  }

  async function finishHold() {
    holding = false;
    cancelAnimationFrame(raf);
    el.fill.style.width = '100%';
    el.fill.classList.add('done');
    el.hold.classList.remove('holding');
    el.holdLabel.textContent = 'Unlocking…';
    const res = await send({ type: 'startPause', minutes: selectedMinutes });
    if (res && res.ok) {
      toast(`Paused for ${selectedMinutes} min. The shield is off.`);
      setTimeout(() => location.replace(`https://${site}`), 600);
    } else {
      toast('Pause refused — the limit is the point.');
      el.fill.style.width = '0%';
      el.fill.classList.remove('done');
      refresh();
    }
  }

  el.hold.addEventListener('pointerdown', (e) => {
    el.hold.setPointerCapture && el.hold.setPointerCapture(e.pointerId);
    startHold(e);
  });
  for (const evt of ['pointerup', 'pointerleave', 'pointercancel']) el.hold.addEventListener(evt, cancelHold);
  el.hold.addEventListener('contextmenu', (e) => e.preventDefault());

  el.back.addEventListener('click', () => {
    if (history.length > 1) history.back();
    else location.href = 'chrome://newtab';
  });
  el.settings.addEventListener('click', () => send({ type: 'openOptions' }));

  refresh();
  // Keep the pause limits honest while the page sits open.
  setInterval(() => {
    if (status) renderPauseUi();
  }, 5000);
})();
