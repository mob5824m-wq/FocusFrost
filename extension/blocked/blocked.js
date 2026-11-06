/* FocusFrost — blocked page */
(function () {
  'use strict';

  const Util = window.FFUtil;
  const CIRC = 603.2;
  const $ = (id) => document.getElementById(id);

  /**
   * Navigate, with one escape hatch: inside the offline sandbox there is no
   * real internet, so the fake browser handles the jump instead.
   */
  function goTo(url, tabId) {
    if (window.__FF_DEMO && window.parent && window.parent.__FF_DEMO_NAV__) {
      return window.parent.__FF_DEMO_NAV__(tabId == null ? null : tabId, url);
    }
    location.replace(url);
  }

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
  let breatheConfig = null; // { enabled, minutes, durationSeconds }
  let breathing = false;
  let breathTimers = [];

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
    breatheBtn: $('breatheBtn'),
    breatheNote: $('breatheNote'),
    breathePanel: $('breathePanel'),
    breatheTitle: $('breatheTitle'),
    breatheLede: $('breatheLede'),
    breatheMsg: $('breatheMsg'),
    closeBreathe: $('closeBreathe'),
    orb: $('orb'),
    phaseLabel: $('phaseLabel'),
    phaseCount: $('phaseCount'),
    breathBar: $('breathBar'),
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

  /**
   * Whether the breathing route should be on this page at all.
   * It is offered only when it can actually succeed: interventions on, the
   * feature enabled, and a pause still available today.
   */
  async function loadBreatheOffer(res) {
    if (reason === 'second-tab' || reason === 'schedule') {
      // Focus hours are not for sale; a second tab is a different problem.
      el.breatheBtn.classList.add('hidden');
      el.breatheNote.classList.add('hidden');
      return;
    }
    const cfgRes = await send({ type: 'blockedConfig', site });
    if (!cfgRes || !cfgRes.ok) return;
    const iv = cfgRes.intervention || {};
    const pause = cfgRes.pause || {};
    const offer = cfgRes.breathe || {};
    breatheConfig = {
      enabled: iv.enabled !== false && iv.breatheToPass !== false,
      // The worker decides the window (strict mode rounds it to a preset).
      minutes: offer.minutes || iv.breatheMinutes || 2,
      durationSeconds: Math.max(4, Math.min(60, Number(iv.durationSeconds) || 10)),
      reason: offer.blockedReason || null,
    };
    const available = breatheConfig.enabled && pause.canStart;
    el.breatheBtn.classList.toggle('hidden', !available);
    el.breatheNote.classList.toggle('hidden', !available);
    if (available) {
      el.breatheBtn.textContent = `Breathe your way in — ${breatheConfig.minutes} min`;
      el.breatheNote.textContent = `Costs one of today's pauses. ${pause.remainingToday} left, ${pause.minGapMinutes} min apart.`;
      // The breath becomes the primary action; the hold is the fallback.
      el.pause.classList.remove('btn-primary');
      el.pause.classList.add('btn-ghost');
    } else if (breatheConfig.enabled && (breatheConfig.reason || pause.blockedReason)) {
      // Never show a ritual that cannot actually open the door.
      const why = breatheConfig.reason || pause.blockedReason;
      el.breatheBtn.classList.add('hidden');
      el.breatheNote.classList.remove('hidden');
      el.breatheNote.textContent =
        why === 'daily-limit'
          ? "Out of pauses today, so the breath would not open anything. That is the deal."
          : why === 'disabled'
          ? 'Pauses are switched off in settings, so breathing will not open this either.'
          : why === 'too-soon'
          ? 'Too soon after your last pause. The gap is part of the design.'
          : 'The shield cannot be paused right now.';
    } else {
      el.breatheBtn.classList.add('hidden');
      el.breatheNote.classList.add('hidden');
    }
  }

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
    // Re-ask every time: a pause taken in another tab, or the daily limit being
    // hit elsewhere, has to be reflected here. Asking once cached "you have
    // pauses left" onto a page that was opened minutes ago.
    await loadBreatheOffer(res);
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
    // The page is opening the site; a stale breath offer would just be noise.
    el.breatheBtn.classList.add('hidden');
    el.breatheNote.classList.add('hidden');
    el.breathePanel.classList.add('hidden');
    el.panel.classList.add('hidden');
    breathing = false;
    clearBreathTimers();
    setTimeout(() => {
      goTo(`https://${(match && match.pattern) || site}`);
    }, 900);
  }

  /* ---------------- breathing exercise ---------------- */

  function clearBreathTimers() {
    for (const t of breathTimers) clearTimeout(t);
    breathTimers = [];
  }

  function breathPhases(total) {
    // One calm cycle is 11s; repeat until the configured minimum is covered.
    const cycle = [
      { name: 'Breathe in', seconds: 4, cls: 'inhale' },
      { name: 'Hold', seconds: 2, cls: 'hold' },
      { name: 'Breathe out', seconds: 5, cls: 'exhale' },
    ];
    const queue = [];
    let sum = 0;
    while (sum < total) {
      for (const phase of cycle) {
        if (sum >= total) break;
        queue.push(phase);
        sum += phase.seconds;
      }
    }
    return queue;
  }

  function openBreathe() {
    if (!breatheConfig || !breatheConfig.enabled) return;
    if (breathing) return;
    el.panel.classList.add('hidden');
    el.breathePanel.classList.remove('hidden');
    el.breatheBtn.classList.add('hidden');
    startBreathing();
  }

  function startBreathing() {
    breathing = true;
    clearBreathTimers();
    const phases = breathPhases(breatheConfig.durationSeconds);
    const totalSeconds = phases.reduce((sum, p) => sum + p.seconds, 0);
    let elapsed = 0;

    el.breatheTitle.textContent = 'Breathe with the ring';
    el.breatheLede.textContent = `In, hold, out. Finish the cycle and ${siteName} opens for ${breatheConfig.minutes} minute${
      breatheConfig.minutes === 1 ? '' : 's'
    } — one of your pauses.`;
    el.breatheMsg.textContent = '';
    el.breathBar.style.width = '0%';

    let index = 0;
    const runPhase = () => {
      if (!breathing) return;
      if (index >= phases.length) return finishBreathing();

      const phase = phases[index++];
      el.orb.className = 'breath-orb ' + phase.cls;
      el.phaseLabel.textContent = phase.name;

      let left = phase.seconds;
      el.phaseCount.textContent = String(left);
      const ticker = setInterval(() => {
        if (!breathing) return clearInterval(ticker);
        left -= 1;
        el.phaseCount.textContent = String(Math.max(0, left));
        elapsed += 1;
        el.breathBar.style.width = Math.min(100, (elapsed / totalSeconds) * 100) + '%';
        if (left <= 0) {
          clearInterval(ticker);
          runPhase();
        }
      }, 1000);
      // Track intervals so closing the panel stops everything.
      breathTimers.push(ticker);
    };
    runPhase();
  }

  async function finishBreathing() {
    breathing = false;
    clearBreathTimers();
    el.orb.className = 'breath-orb done';
    el.phaseLabel.textContent = 'Done';
    el.phaseCount.textContent = '✓';
    el.breathBar.style.width = '100%';
    el.breatheTitle.textContent = 'That was the pause.';
    el.breatheMsg.textContent = 'Unlocking…';

    const res = await send({ type: 'breathePass', site, tabId: Number(params.get('tab')) || null });
    if (res && res.ok) {
      el.breatheLede.textContent = `Open for ${res.minutes} minute${res.minutes === 1 ? '' : 's'} — ${
        res.remainingToday
      } pause${res.remainingToday === 1 ? '' : 's'} left today.`;
      el.breatheMsg.textContent = `Going to ${siteName} now.`;
      toast(`Breathed through it — ${res.minutes} min`);
      const url = res.url || `https://${site}`;
      setTimeout(() => goTo(url, Number(params.get('tab')) || null), 900);
    } else {
      const why =
        res && res.reason === 'daily-limit'
          ? 'You are out of pauses for today.'
          : res && res.reason === 'too-soon'
          ? 'It is too soon after your last pause.'
          : res && res.reason === 'already-paused'
          ? 'Another pause is already running — this page will use that one.'
          : res && res.reason === 'disabled'
          ? 'Pauses are switched off in settings, so there is nothing to spend.'
          : 'The shield could not be paused.';
      el.breatheTitle.textContent = 'The breath was still worth it.';
      el.breatheLede.textContent = why;
      el.breatheMsg.textContent = 'Try the hold-to-pause button, or come back later.';
      toast(why);
      setTimeout(() => closeBreathe(), 1800);
    }
  }

  function closeBreathe() {
    breathing = false;
    clearBreathTimers();
    el.breathePanel.classList.add('hidden');
    el.orb.className = 'breath-orb';
    el.phaseLabel.textContent = 'Ready';
    el.phaseCount.textContent = '—';
    el.breathBar.style.width = '0%';
    refresh();
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

  el.breatheBtn.addEventListener('click', openBreathe);
  el.closeBreathe.addEventListener('click', closeBreathe);

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
