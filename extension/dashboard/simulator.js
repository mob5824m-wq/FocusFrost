/**
 * FocusFrost — the sandbox.
 *
 * A throwaway copy of the real engine driven by a fake clock so you can watch
 * the rules play out without waiting ten minutes. It shares engine.js with the
 * service worker, so what you see here is exactly what will happen for real.
 */
(function (root) {
  'use strict';

  function createSimulator(Engine, Config, cfg) {
    let simCfg = Config.normalizeSettings(JSON.parse(JSON.stringify(cfg)));
    let state = Engine.emptyState(Date.now());
    let clock = Date.now();
    let tabId = 901;
    let focused = true;
    let lines = [];
    const listeners = [];

    function log(text, kind) {
      const stamp = new Date(clock).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      lines.push({ stamp, text, kind: kind || '' });
      if (lines.length > 120) lines = lines.slice(-120);
      emit();
    }

    function emit() {
      for (const fn of listeners) fn(snapshot());
    }

    function subscribe(fn) {
      listeners.push(fn);
      fn(snapshot());
    }

    function snapshot() {
      const sites = Engine.snapshot(state, simCfg, clock);
      return {
        clock,
        focused,
        cfg: simCfg,
        lines: lines.slice(),
        sites: sites.sites,
        pause: sites.pause,
        totals: sites.totals,
      };
    }

    function setSite(pattern) {
      if (Engine.findSite(simCfg, pattern)) return;
      log(`now tracking ${pattern}`, 'warn');
    }

    function open(pattern) {
      const site = Engine.findSite(simCfg, pattern);
      if (!site) return log('stop trying to open a site that is not tracked', 'warn');
      focused = true;
      const d = Engine.evaluateNavigation(state, simCfg, site.pattern, tabId, clock);
      if (d.action === 'block') {
        log(`BLOCKED ${site.label} — ${d.reason}${d.until ? ', ' + Math.ceil((d.until - clock) / 1000) + 's left' : ''}`, 'bad');
      } else if (d.reason === 'paused') {
        log(`opened ${site.label} (paused mode — rules are off)`, 'ok');
      } else if (d.resumed) {
        log(`back on ${site.label} — same visit, grace ends in ${Math.max(0, Math.ceil((d.session.graceEndsAt - clock) / 1000))}s`, 'ok');
      } else {
        log(`opened ${site.label} — grace window starts (${site.graceSeconds}s)`, 'ok');
      }
      emit();
    }

    function blur(pattern) {
      const site = Engine.findSite(simCfg, pattern);
      if (!site) return;
      focused = false;
      const d = Engine.recordLeave(state, simCfg, site.pattern, clock, Engine.REASONS.BLUR);
      if (d.action === 'close') {
        log(`LEFT ${site.label} after grace → closed, locked ${Math.round(d.cooldownSeconds / 60)}m`, 'bad');
      } else if (d.reason === 'grace') {
        log(`left during grace — free, ${Math.ceil(d.graceRemaining)}s of the window left`, 'warn');
      } else {
        log('left — nothing to enforce', '');
      }
      emit();
    }

    function close(pattern) {
      const site = Engine.findSite(simCfg, pattern);
      if (!site) return;
      const d = Engine.recordTabClosed(state, simCfg, site.pattern, clock);
      if (d.action === 'close') log(`closed ${site.label} → locked ${Math.round(d.cooldownSeconds / 60)}m`, 'bad');
      else if (d.reason === 'grace-closed') log('closed inside grace — free pass', 'warn');
      else log('closed — no active visit', '');
      emit();
    }

    function tick(seconds) {
      const step = 1;
      for (let i = 0; i < seconds; i += step) {
        clock += step * 1000;
        for (const site of simCfg.sites) {
          const st = state.sites[site.pattern];
          if (!st || !st.session) continue;
          const d = Engine.heartbeat(state, simCfg, site.pattern, tabId, clock, focused);
          if (d.action === 'close') {
            log(`FOCUS CAP on ${site.label} → tab closed, locked ${Math.round((d.cooldownSeconds || 0) / 60)}m`, 'bad');
          }
        }
        Engine.expirePause(state, clock);
      }
      log(`time passes: ${seconds}s${focused ? ' (still focused)' : ' (not focused)'}`, '');
    }

    function pause(minutes) {
      const res = Engine.startPause(state, simCfg, minutes, clock);
      if (res.ok) log(`PAUSE ${res.minutes}m started — ${res.remainingToday} left today`, 'ok');
      else log(`pause refused: ${res.reason}`, 'bad');
      emit();
    }

    function reset() {
      state = Engine.emptyState(clock);
      focused = true;
      lines = [];
      log('sandbox reset');
      emit();
    }

    return { subscribe, open, blur, close, tick, pause, reset, setSite, snapshot, log };
  }

  root.FFSimulator = { createSimulator };
})(typeof globalThis !== 'undefined' ? globalThis : this);
