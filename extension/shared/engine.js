/**
 * FocusFrost — the policy engine.
 *
 * Pure, side-effect free functions that take a state object and return a
 * decision. No chrome.* APIs in here, which means the whole ruleset can be
 * unit tested in Node (see tests/engine.test.js).
 *
 * Vocabulary
 * ----------
 * session   One continuous "visit" to a tracked site. It ends when you leave
 *           after the grace window, when you hit the focus cap, or when the
 *           tab closes.
 * grace     Seconds after a visit begins during which leaving is free. Come
 *           back inside the window and nothing happens; come back after it and
 *           you are locked out for the site's cooldown.
 * cooldown  The lockout. A hard timestamp (`cooldownUntil`) that survives
 *           browser restarts.
 * pause     The deliberate "I actually need this" override. Time-boxed and
 *           rate limited.
 */
(function (root, factory) {
  const api = factory(
    root.FFUtil || (typeof require === 'function' ? require('./util.js') : null),
    root.FFConfig || (typeof require === 'function' ? require('./config.js') : null)
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FFEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Util, Config) {
  'use strict';

  const REASONS = {
    UNTRACKED: 'untracked',
    DISABLED: 'disabled',
    PAUSED: 'paused',
    COOLDOWN: 'cooldown',
    SESSION_ACTIVE: 'session-active',
    SECOND_TAB: 'second-tab',
    LIMIT: 'limit',
    LEFT: 'left',
    CLOSED: 'closed',
    BLUR: 'blur',
    MANUAL: 'manual',
  };

  const COOLDOWN_LABEL = {
    [REASONS.BLUR]: 'You switched away',
    [REASONS.CLOSED]: 'You closed the tab',
    [REASONS.LEFT]: 'You left the site',
    [REASONS.LIMIT]: 'Focus session finished',
    [REASONS.MANUAL]: 'Ended by you',
  };

  function blankSite(now) {
    return {
      session: null,
      cooldownUntil: 0,
      cooldownReason: null,
      lastLeaveAt: 0,
      focusSeconds: 0,
      bestFocusSeconds: 0,
      trips: 0,
      blocked: 0,
      lastVisitAt: 0,
      day: Util.dayKey(now),
    };
  }

  function emptyState(now) {
    const t = Number(now) || Date.now();
    return {
      version: 1,
      sites: {},
      pause: {
        until: 0,
        startedAt: 0,
        minutes: 0,
        day: Util.dayKey(t),
        usedToday: 0,
        lastPauseAt: 0,
        total: 0,
      },
      stats: { day: Util.dayKey(t), blocked: 0, sessions: 0, focusSeconds: 0 },
    };
  }

  /** Coerce anything that came out of storage into a valid state object. */
  function normalizeState(raw, now) {
    const fresh = emptyState(now);
    if (!raw || typeof raw !== 'object') return fresh;
    const state = {
      version: 1,
      sites: {},
      pause: Object.assign(fresh.pause, raw.pause || {}),
      stats: Object.assign(fresh.stats, raw.stats || {}),
    };
    state.pause.until = Math.max(0, Number(state.pause.until) || 0);
    state.pause.startedAt = Math.max(0, Number(state.pause.startedAt) || 0);
    state.pause.minutes = Math.max(0, Number(state.pause.minutes) || 0);
    state.pause.usedToday = Math.max(0, Number(state.pause.usedToday) || 0);
    state.pause.lastPauseAt = Math.max(0, Number(state.pause.lastPauseAt) || 0);
    state.pause.total = Math.max(0, Number(state.pause.total) || 0);
    state.stats.blocked = Math.max(0, Number(state.stats.blocked) || 0);
    state.stats.sessions = Math.max(0, Number(state.stats.sessions) || 0);
    state.stats.focusSeconds = Math.max(0, Number(state.stats.focusSeconds) || 0);

    const sites = raw.sites && typeof raw.sites === 'object' ? raw.sites : {};
    for (const key of Object.keys(sites)) {
      const pattern = Util.normalizeSite(key);
      if (!pattern) continue;
      const src = sites[key] || {};
      const site = blankSite(now);
      site.cooldownUntil = Math.max(0, Number(src.cooldownUntil) || 0);
      site.cooldownReason = src.cooldownReason || null;
      site.lastLeaveAt = Math.max(0, Number(src.lastLeaveAt) || 0);
      site.focusSeconds = Math.max(0, Number(src.focusSeconds) || 0);
      site.bestFocusSeconds = Math.max(0, Number(src.bestFocusSeconds) || 0);
      site.trips = Math.max(0, Number(src.trips) || 0);
      site.blocked = Math.max(0, Number(src.blocked) || 0);
      site.lastVisitAt = Math.max(0, Number(src.lastVisitAt) || 0);
      site.day = src.day || Util.dayKey(now);
      if (src.session && typeof src.session === 'object') {
        site.session = {
          tabId: Number(src.session.tabId) || -1,
          windowId: Number(src.session.windowId) || -1,
          startedAt: Number(src.session.startedAt) || 0,
          graceEndsAt: Number(src.session.graceEndsAt) || 0,
          focusedSeconds: Math.max(0, Number(src.session.focusedSeconds) || 0),
          lastTickAt: Number(src.session.lastTickAt) || 0,
          capSeconds: Number(src.session.capSeconds) || 0,
        };
      }
      state.sites[pattern] = site;
    }
    return state;
  }

  /** Roll the daily counters over at local midnight. */
  function rollDay(state, now) {
    const today = Util.dayKey(now);
    if (state.pause.day !== today) {
      state.pause.day = today;
      state.pause.usedToday = 0;
    }
    if (state.stats.day !== today) {
      state.stats.day = today;
      state.stats.blocked = 0;
      state.stats.sessions = 0;
      state.stats.focusSeconds = 0;
    }
    for (const key of Object.keys(state.sites)) {
      if (state.sites[key].day !== today) {
        state.sites[key].day = today;
        state.sites[key].focusSeconds = 0;
        state.sites[key].trips = 0;
      }
    }
    return state;
  }

  function getSiteState(state, pattern, now) {
    const key = Util.normalizeSite(pattern);
    if (!key) return null;
    if (!state.sites[key]) state.sites[key] = blankSite(now);
    return state.sites[key];
  }

  /** Is `hostname` covered by a tracked site pattern? Most specific wins. */
  function findSite(cfg, hostname) {
    const host = Util.normalizeSite(hostname);
    if (!host) return null;
    let best = null;
    for (const site of cfg.sites) {
      if (host === site.pattern || host.endsWith('.' + site.pattern)) {
        if (!best || site.pattern.length > best.pattern.length) best = site;
      }
    }
    return best;
  }

  function graceEndsAt(session, site) {
    return session.startedAt + (Number(site.graceSeconds) || 0) * 1000;
  }

  function pauseActive(state, now) {
    return state.pause.until > now;
  }

  function pauseRemaining(state, now) {
    return Math.max(0, state.pause.until - now);
  }

  /**
   * Can a new focus pause start right now?
   * Returns { ok, reason, retryAt, remainingToday }
   */
  function canStartPause(state, cfg, now) {
    rollDay(state, now);
    const pause = state.pause;
    const limit = cfg.pause.maxPerDay;
    if (pauseActive(state, now)) {
      return { ok: false, reason: 'already-paused', retryAt: pause.until, remainingToday: Math.max(0, limit - pause.usedToday) };
    }
    const gapMs = (Number(cfg.pause.minGapMinutes) || 0) * 60000;
    if (gapMs > 0 && pause.lastPauseAt && now < pause.lastPauseAt + gapMs) {
      return { ok: false, reason: 'too-soon', retryAt: pause.lastPauseAt + gapMs, remainingToday: Math.max(0, limit - pause.usedToday) };
    }
    if (limit <= 0) {
      return { ok: false, reason: 'disabled', retryAt: 0, remainingToday: 0 };
    }
    if (pause.usedToday >= limit) {
      return { ok: false, reason: 'daily-limit', retryAt: 0, remainingToday: 0 };
    }
    return { ok: true, reason: 'ok', retryAt: 0, remainingToday: limit - pause.usedToday };
  }

  /**
   * Start a focus pause. In strict mode only the configured presets are
   * accepted and the duration is hard-capped, so you cannot "just" buy an hour.
   */
  function startPause(state, cfg, minutes, now) {
    rollDay(state, now);
    const gate = canStartPause(state, cfg, now);
    if (!gate.ok) return { ok: false, ...gate };

    const presets = cfg.pause.presets;
    let chosen = Math.round(Number(minutes) || 0);
    if (cfg.pause.strict) {
      if (!presets.includes(chosen)) {
        return { ok: false, reason: 'not-a-preset', retryAt: 0, remainingToday: gate.remainingToday };
      }
    }
    chosen = Util.clamp(chosen, 1, Math.max(...presets, 30));

    state.pause.until = now + chosen * 60000;
    state.pause.startedAt = now;
    state.pause.minutes = chosen;
    state.pause.lastPauseAt = now;
    state.pause.usedToday += 1;
    state.pause.total += 1;

    // A pause buys access now, so live lockouts are lifted. The countdown that
    // was running does not come back afterwards — that is the cost of a pause.
    for (const key of Object.keys(state.sites)) {
      const site = state.sites[key];
      site.cooldownUntil = 0;
      site.cooldownReason = null;
      site.session = null;
    }
    return {
      ok: true,
      until: state.pause.until,
      minutes: chosen,
      remainingToday: gate.remainingToday - 1,
    };
  }

  function stopPause(state, now) {
    const wasActive = pauseActive(state, now);
    state.pause.until = 0;
    // Sessions opened during the pause become real sessions starting now, so
    // you get a fresh grace window instead of being kicked mid-sentence.
    for (const key of Object.keys(state.sites)) {
      state.sites[key].session = null;
    }
    return { ok: true, wasActive };
  }

  /** End any live pause because it expired; returns true when it just did. */
  function expirePause(state, now) {
    if (state.pause.until && state.pause.until <= now) {
      state.pause.until = 0;
      for (const key of Object.keys(state.sites)) state.sites[key].session = null;
      return true;
    }
    return false;
  }

  /**
   * Decide what to do when a tab is (or was) heading to `pattern`.
   * Returns one of:
   *   { action:'allow',  ... }  let it load
   *   { action:'block',  ... }  send the tab to the blocked page
   */
  function evaluateNavigation(state, cfg, pattern, tabId, now) {
    rollDay(state, now);
    expirePause(state, now);

    if (!cfg.enabled) return { action: 'allow', reason: REASONS.DISABLED };

    const site = findSite(cfg, pattern);
    if (!site) return { action: 'allow', reason: REASONS.UNTRACKED };
    if (!site.enabled) return { action: 'allow', reason: REASONS.DISABLED };

    const st = getSiteState(state, site.pattern, now);

    if (pauseActive(state, now)) {
      st.lastVisitAt = now;
      return { action: 'allow', reason: REASONS.PAUSED, pauseUntil: state.pause.until, site: site.pattern };
    }

    if (st.cooldownUntil > now) {
      st.blocked += 1;
      state.stats.blocked += 1;
      return {
        action: 'block',
        reason: REASONS.COOLDOWN,
        site: site.pattern,
        label: site.label,
        until: st.cooldownUntil,
        cooldownReason: st.cooldownReason,
        cooldownLabel: COOLDOWN_LABEL[st.cooldownReason] || 'Cooling down',
        cooldownSeconds: site.cooldownSeconds,
      };
    }

    // Same tab coming back: keep the visit and its clock.
    if (st.session && st.session.tabId === tabId) {
      st.lastVisitAt = now;
      st.session.lastTickAt = now;
      return {
        action: 'allow',
        reason: REASONS.SESSION_ACTIVE,
        site: site.pattern,
        label: site.label,
        resumed: true,
        session: publicSession(st.session, site, now),
      };
    }

    // Another tab already has the site open: one visit, one tab.
    if (st.session && st.session.tabId !== tabId && cfg.behavior.blockNewTabs) {
      st.blocked += 1;
      state.stats.blocked += 1;
      return {
        action: 'block',
        reason: REASONS.SECOND_TAB,
        site: site.pattern,
        label: site.label,
        until: 0,
        cooldownReason: REASONS.SECOND_TAB,
        cooldownLabel: 'Already open in another tab',
        otherTabId: st.session.tabId,
      };
    }

    // Fresh visit.
    const session = {
      tabId,
      windowId: -1,
      startedAt: now,
      graceEndsAt: now + (site.graceSeconds || 0) * 1000,
      focusedSeconds: 0,
      lastTickAt: now,
      capSeconds: site.maxSessionSeconds,
    };
    st.session = session;
    st.lastVisitAt = now;
    state.stats.sessions += 1;
    return {
      action: 'allow',
      reason: 'started',
      site: site.pattern,
      label: site.label,
      session: publicSession(session, site, now),
    };
  }

  function publicSession(session, site, now) {
    const cap = session.capSeconds || site.maxSessionSeconds;
    return {
      startedAt: session.startedAt,
      graceEndsAt: session.graceEndsAt,
      capSeconds: cap,
      focusedSeconds: Math.round(session.focusedSeconds * 10) / 10,
      remainingSeconds: Math.max(0, cap - session.focusedSeconds),
      inGrace: now < session.graceEndsAt,
      graceRemaining: Math.max(0, (session.graceEndsAt - now) / 1000),
    };
  }

  /**
   * Periodic tick from the page (roughly once a second).
   * `focused` is true only when the tab is visible AND the window has focus.
   *
   * Returns { action:'allow'|'close'|'block'|'reload', ... }
   */
  function heartbeat(state, cfg, pattern, tabId, now, focused) {
    rollDay(state, now);
    expirePause(state, now);

    const site = findSite(cfg, pattern);
    if (!site || !site.enabled || !cfg.enabled) return { action: 'allow', reason: REASONS.UNTRACKED };
    const st = getSiteState(state, site.pattern, now);

    if (pauseActive(state, now)) {
      st.lastVisitAt = now;
      return {
        action: 'allow',
        reason: REASONS.PAUSED,
        paused: true,
        pauseUntil: state.pause.until,
        pauseRemaining: pauseRemaining(state, now),
      };
    }

    if (st.cooldownUntil > now) {
      return {
        action: 'block',
        reason: REASONS.COOLDOWN,
        site: site.pattern,
        label: site.label,
        until: st.cooldownUntil,
        cooldownReason: st.cooldownReason,
        cooldownLabel: COOLDOWN_LABEL[st.cooldownReason] || 'Cooling down',
      };
    }

    const session = st.session;
    if (!session || session.tabId !== tabId) {
      // Page reloaded or was restored: re-run the navigation rules.
      return evaluateNavigation(state, cfg, site.pattern, tabId, now);
    }

    const dt = Math.min(Math.max(0, now - (session.lastTickAt || now)), 3000) / 1000;
    session.lastTickAt = now;
    st.lastVisitAt = now;

    if (focused) {
      session.focusedSeconds += dt;
      st.focusSeconds += dt;
      state.stats.focusSeconds += dt;
      const cap = session.capSeconds || site.maxSessionSeconds;
      if (session.focusedSeconds >= cap) {
        const result = endVisit(state, cfg, site, now, REASONS.LIMIT);
        return {
          action: 'close',
          reason: REASONS.LIMIT,
          site: site.pattern,
          label: site.label,
          cooldownUntil: result.cooldownUntil,
          cooldownSeconds: result.cooldownSeconds,
          message: `You hit your ${Util.humanDuration(cap)} focus cap on ${site.label}.`,
        };
      }
    } else if (cfg.behavior.closeOnBlur && st.session) {
      // Lost focus: allowed only while inside the grace window.
      if (now >= graceEndsAt(session, site)) {
        const result = endVisit(state, cfg, site, now, REASONS.BLUR);
        return {
          action: 'close',
          reason: REASONS.BLUR,
          site: site.pattern,
          label: site.label,
          cooldownUntil: result.cooldownUntil,
          cooldownSeconds: result.cooldownSeconds,
          message: `You left ${site.label} after the grace window.`,
        };
      }
    }

    return {
      action: 'allow',
      reason: 'tick',
      site: site.pattern,
      label: site.label,
      session: publicSession(session, site, now),
      inGrace: now < graceEndsAt(session, site),
      graceRemaining: Math.max(0, (graceEndsAt(session, site) - now) / 1000),
    };
  }

  /**
   * End the current visit and start the cooldown.
   * When the leave happened inside the grace window the visit simply ends with
   * no cooldown at all — that is the whole point of grace.
   */
  function endVisit(state, cfg, site, now, reason) {
    const st = getSiteState(state, site.pattern, now);
    const session = st.session;
    if (!session) return { cooldownUntil: 0, cooldownSeconds: 0, graceUsed: true };

    const inGrace = now < graceEndsAt(session, site);
    st.bestFocusSeconds = Math.max(st.bestFocusSeconds, Math.round(session.focusedSeconds));
    st.session = null;
    st.lastLeaveAt = now;
    st.trips += 1;

    if (inGrace && reason !== REASONS.LIMIT) {
      return { cooldownUntil: 0, cooldownSeconds: 0, graceUsed: true };
    }

    const cooldown = Util.clamp(site.cooldownSeconds, 10, 86400);
    st.cooldownUntil = now + cooldown * 1000;
    st.cooldownReason = reason;
    return { cooldownUntil: st.cooldownUntil, cooldownSeconds: cooldown, graceUsed: false };
  }

  /**
   * The tab/window lost focus (detected by the service worker, which is more
   * reliable than a content script that might be throttled).
   */
  function recordLeave(state, cfg, pattern, now, reason, tabGone) {
    rollDay(state, now);
    if (!cfg.enabled || pauseActive(state, now)) return { action: 'allow', reason: REASONS.PAUSED };
    if (!cfg.behavior.closeOnBlur) return { action: 'allow', reason: 'blur-ignored' };
    const site = findSite(cfg, pattern);
    if (!site || !site.enabled) return { action: 'allow', reason: REASONS.UNTRACKED };
    const st = getSiteState(state, site.pattern, now);
    if (!st.session) return { action: 'allow', reason: 'no-session' };
    if (now < graceEndsAt(st.session, site)) {
      if (tabGone) {
        // The tab is gone, so the visit is over — but leaving inside grace is
        // free, so no cooldown. Clearing the session matters, otherwise a
        // restored tab would look like a "second tab" and get blocked.
        st.bestFocusSeconds = Math.max(st.bestFocusSeconds, Math.round(st.session.focusedSeconds));
        st.session = null;
        st.lastLeaveAt = now;
        st.trips += 1;
        return { action: 'allow', reason: 'grace-closed', cooldownUntil: 0, cooldownSeconds: 0 };
      }
      // Still inside grace — a free bounce. Keep the visit alive so the user
      // can come straight back without resetting the grace clock.
      st.session.lastTickAt = now;
      return { action: 'allow', reason: 'grace', graceRemaining: (graceEndsAt(st.session, site) - now) / 1000 };
    }
    const result = endVisit(state, cfg, site, now, reason || REASONS.BLUR);
    return {
      action: 'close',
      reason: reason || REASONS.BLUR,
      site: site.pattern,
      label: site.label,
      cooldownUntil: result.cooldownUntil,
      cooldownSeconds: result.cooldownSeconds,
    };
  }

  /** Tab was closed outright. */
  function recordTabClosed(state, cfg, pattern, now) {
    return recordLeave(state, cfg, pattern, now, REASONS.CLOSED, true);
  }

  /** Voluntary "End session now" from the chip or the popup. */
  function endSessionManually(state, cfg, pattern, now) {
    const site = findSite(cfg, pattern);
    if (!site) return { ok: false, reason: REASONS.UNTRACKED };
    const st = getSiteState(state, site.pattern, now);
    if (!st.session) return { ok: false, reason: 'no-session' };
    if (pauseActive(state, now)) {
      st.session = null;
      return { ok: true, cooldownUntil: 0, cooldownSeconds: 0 };
    }
    const result = endVisit(state, cfg, site, now, REASONS.MANUAL);
    return { ok: true, ...result };
  }

  /** Sites whose cooldown expired since the last tick — used for notifications. */
  function collectExpiredCooldowns(state, now) {
    const out = [];
    for (const key of Object.keys(state.sites)) {
      const st = state.sites[key];
      if (st.cooldownUntil && st.cooldownUntil <= now) {
        out.push({ site: key, cooldownUntil: st.cooldownUntil });
        st.cooldownUntil = 0;
        st.cooldownReason = null;
      }
    }
    return out;
  }

  /**
   * Every tracked site gets a snapshot for the popup / dashboard / chip.
   */
  function snapshot(state, cfg, now) {
    rollDay(state, now);
    const sites = cfg.sites.map((site) => {
      const st = getSiteState(state, site.pattern, now);
      const cooling = st.cooldownUntil > now;
      return {
        id: site.id,
        pattern: site.pattern,
        label: site.label,
        enabled: site.enabled,
        cooldownSeconds: site.cooldownSeconds,
        graceSeconds: site.graceSeconds,
        maxSessionSeconds: site.maxSessionSeconds,
        cooldownUntil: cooling ? st.cooldownUntil : 0,
        cooldownRemaining: cooling ? st.cooldownUntil - now : 0,
        cooldownReason: cooling ? st.cooldownReason : null,
        cooldownLabel: cooling ? COOLDOWN_LABEL[st.cooldownReason] || 'Cooling down' : '',
        session: st.session
          ? Object.assign(publicSession(st.session, site, now), { tabId: st.session.tabId })
          : null,
        focusSecondsToday: Math.round(st.focusSeconds),
        bestFocusSeconds: st.bestFocusSeconds,
        trips: st.trips,
        blocked: st.blocked,
      };
    });
    const gate = canStartPause(state, cfg, now);
    return {
      now,
      enabled: cfg.enabled,
      sites,
      pause: {
        active: pauseActive(state, now),
        until: state.pause.until,
        remaining: pauseRemaining(state, now),
        minutes: state.pause.minutes,
        usedToday: state.pause.usedToday,
        maxPerDay: cfg.pause.maxPerDay,
        minGapMinutes: cfg.pause.minGapMinutes,
        presets: cfg.pause.presets,
        holdMs: cfg.pause.holdMs,
        strict: cfg.pause.strict,
        canStart: gate.ok,
        blockedReason: gate.reason,
        retryAt: gate.retryAt,
        remainingToday: gate.remainingToday,
      },
      stats: {
        day: state.stats.day,
        blocked: state.stats.blocked,
        sessions: state.stats.sessions,
        focusSeconds: Math.round(state.stats.focusSeconds),
        pauses: state.pause.total,
      },
      totals: sites.reduce(
        (acc, s) => {
          if (s.cooldownUntil) acc.cooling += 1;
          if (s.session) acc.active += 1;
          return acc;
        },
        { cooling: 0, active: 0 }
      ),
    };
  }

  return {
    REASONS,
    COOLDOWN_LABEL,
    emptyState,
    normalizeState,
    rollDay,
    getSiteState,
    findSite,
    graceEndsAt,
    pauseActive,
    pauseRemaining,
    canStartPause,
    startPause,
    stopPause,
    expirePause,
    evaluateNavigation,
    heartbeat,
    endVisit,
    recordLeave,
    recordTabClosed,
    endSessionManually,
    collectExpiredCooldowns,
    snapshot,
    publicSession,
  };
});
