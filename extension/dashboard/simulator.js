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
    // The sandbox has no gate page, so it plays the user's part for them.
    let gate = null;
    let lastOutcome = null;
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
        gate,
        log: sites.log || [],
        stats: sites.stats || {},
        lastOutcome,
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
      } else if (d.action === 'intervene') {
        gate = { site: site.pattern, label: site.label, mode: d.reintervention ? 'again' : 'enter', type: simCfg.intervention.type };
        log(`FRICTION on ${site.label} — ${d.reintervention ? 'doomscroll brake' : 'gate'} (${gate.type}) · the tab waits`, 'warn');
      } else if (d.reason === 'paused') {
        log(`opened ${site.label} (paused mode — rules are off)`, 'ok');
      } else if (d.resumed) {
        log(`back on ${site.label} — same visit, grace ends in ${Math.max(0, Math.ceil((d.session.graceEndsAt - clock) / 1000))}s`, 'ok');
      } else {
        log(`opened ${site.label} — grace window starts (${site.graceSeconds}s)`, 'ok');
      }
      emit();
    }

    /**
     * The user finishes (or walks away from) the intervention screen.
     * 'continue' re-evaluates the navigation with the gate cleared, exactly as
     * the real gate page does; 'close' is recorded as a walk-away.
     */
    function finishGate(outcome, intention) {
      if (!gate) return log('no intervention is on screen', 'warn');
      const pattern = gate.site;
      const site = Engine.findSite(simCfg, pattern);
      if (site) {
        Engine.recordIntervention(state, simCfg, site, clock, outcome, {
          intention,
          type: gate.type,
          durationSeconds: simCfg.intervention.durationSeconds,
        });
      }
      lastOutcome = { outcome, intention: intention || '', label: site ? site.label : pattern, at: clock };
      gate = null;

      if (outcome === 'close') {
        log(`${site ? site.label : pattern}: walked away — visit recorded, nothing opened`, 'ok');
        emit();
        return lastOutcome;
      }

      log(`${site ? site.label : pattern}: intention recorded — "${intention || 'no words, just a choice'}"`, 'ok');
      const d = Engine.evaluateNavigation(state, simCfg, pattern, tabId, clock, { skipIntervention: true });
      if (d.action === 'allow' || d.action === 'grace') {
        log(`opened ${site.label} — ${d.resumed ? 'same visit resumes' : 'grace window starts (' + site.graceSeconds + 's)'}`, 'ok');
      } else if (d.action === 'block') {
        log(`BLOCKED ${site.label} — ${d.reason}`, 'bad');
      }
      emit();
      return lastOutcome;
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
          } else if (d.action === 'intervene') {
            gate = { site: site.pattern, label: site.label, mode: 'again', type: simCfg.intervention.type };
            log(`FRICTION again on ${site.label} — ${Math.round(simCfg.intervention.reinterveneSeconds / 60)}m of scrolling is enough`, 'warn');
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

    return { subscribe, open, blur, close, tick, pause, reset, setSite, finishGate, snapshot, log };
  }

  root.FFSimulator = { createSimulator };
})(typeof globalThis !== 'undefined' ? globalThis : this);
