/**
 * FocusFrost — the policy engine.
 *
 * Pure, side-effect free functions that take a state object and return a
 * decision. No chrome.* APIs in here, which means the whole ruleset can be
 * unit tested in Node (see tests/engine.test.js).
 *
 * Two layers of friction, combined:
 *
 *   1. INTERVENTION (the one sec idea, before the visit)
 *      On the way in you meet a short pause: a breath, a reflection, a typed
 *      phrase. It catches the muscle memory at the exact moment of the reach.
 *
 *   2. CONSEQUENCE (the FocusFrost idea, during and after the visit)
 *      Grace window, focused cap, one tab, then a hard cooldown you cannot
 *      reload your way out of.
 *
 * Vocabulary
 * ----------
 * session   One continuous "visit" to a tracked site. It ends when you leave
 *           after the grace window, when you hit the focus cap, or when the
 *           tab closes.
 * grace     Seconds after a visit begins during which leaving is free.
 * cooldown  The lockout. A hard timestamp (`cooldownUntil`) that survives
 *           browser restarts.
 * pause     The deliberate "I actually need this" override. Time-boxed and
 *           rate limited.
 * block     A scheduled window (e.g. 09:00-17:00 Mon-Fri) where the site is
 *           simply not available.
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
    SCHEDULE: 'schedule',
    INTERVENE: 'intervene',
    REINTERVENE: 'reintervene',
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
    [REASONS.SCHEDULE]: 'Outside your focus hours',
  };

  const INTENTION_MAX = 160;
  const LOG_MAX = 60;

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
      // de-dupe bookkeeping for countBlock(); not shown anywhere
      lastBlockAt: 0,
      lastBlockReason: null,
    };
  }

  function emptyState(now) {
    const t = Number(now) || Date.now();
    return {
      version: 2,
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
      stats: {
        day: Util.dayKey(t),
        blocked: 0,
        sessions: 0,
        focusSeconds: 0,
        interventions: 0,
        turnedAway: 0, // interventions that ended with "close the tab"
        intentions: 0,
      },
      /** Most recent first. Deliberately tiny: a mirror, not surveillance. */
      log: [],
    };
  }

  /** Coerce anything that came out of storage into a valid state object. */
  function normalizeState(raw, now) {
    const fresh = emptyState(now);
    if (!raw || typeof raw !== 'object') return fresh;
    const state = {
      version: 2,
      sites: {},
      pause: Object.assign(fresh.pause, raw.pause || {}),
      stats: Object.assign(fresh.stats, raw.stats || {}),
      log: [],
    };
    const nonNeg = (v, fb) => Math.max(0, Number(v) || fb || 0);
    // The day keys are strings ("2026-11-06"), and rolling them through the
    // numeric coercion turned them into 0. rollDay() then saw "different day"
    // on every single load and wiped the counters every time the worker
    // restarted — losing today's pauses, blocks and intentions.
    state.pause.day = typeof state.pause.day === 'string' && state.pause.day ? state.pause.day : fresh.pause.day;
    state.stats.day = typeof state.stats.day === 'string' && state.stats.day ? state.stats.day : fresh.stats.day;
    state.pause.until = nonNeg(state.pause.until);
    state.pause.startedAt = nonNeg(state.pause.startedAt);
    state.pause.minutes = nonNeg(state.pause.minutes);
    state.pause.usedToday = nonNeg(state.pause.usedToday);
    state.pause.lastPauseAt = nonNeg(state.pause.lastPauseAt);
    state.pause.total = nonNeg(state.pause.total);
    for (const key of Object.keys(fresh.stats)) {
      if (key === 'day') continue; // a date string, handled above
      state.stats[key] = nonNeg(state.stats[key]);
    }

    if (Array.isArray(raw.log)) {
      state.log = raw.log
        .filter((e) => e && typeof e === 'object' && Number(e.at) > 0)
        .slice(0, LOG_MAX)
        .map((e) => ({
          at: Number(e.at) || 0,
          kind: String(e.kind || 'event').slice(0, 24),
          site: e.site ? Util.normalizeSite(e.site) : '',
          text: String(e.text || '').slice(0, INTENTION_MAX),
          seconds: Math.max(0, Number(e.seconds) || 0),
        }));
    }

    const sites = raw.sites && typeof raw.sites === 'object' ? raw.sites : {};
    for (const key of Object.keys(sites)) {
      const pattern = Util.normalizeSite(key);
      if (!pattern) continue;
      const src = sites[key] || {};
      const site = blankSite(now);
      site.cooldownUntil = nonNeg(src.cooldownUntil);
      site.cooldownReason = src.cooldownReason || null;
      site.lastLeaveAt = nonNeg(src.lastLeaveAt);
      site.focusSeconds = nonNeg(src.focusSeconds);
      site.bestFocusSeconds = nonNeg(src.bestFocusSeconds);
      site.trips = nonNeg(src.trips);
      site.blocked = nonNeg(src.blocked);
      site.lastVisitAt = nonNeg(src.lastVisitAt);
      site.day = src.day || Util.dayKey(now);
      site.lastBlockAt = nonNeg(src.lastBlockAt);
      site.lastBlockReason = src.lastBlockReason || null;
      if (src.session && typeof src.session === 'object') {
        site.session = {
          tabId: Number(src.session.tabId) || -1,
          windowId: Number(src.session.windowId) || -1,
          startedAt: Number(src.session.startedAt) || 0,
          graceEndsAt: Number(src.session.graceEndsAt) || 0,
          focusedSeconds: nonNeg(src.session.focusedSeconds),
          lastTickAt: Number(src.session.lastTickAt) || 0,
          capSeconds: Number(src.session.capSeconds) || 0,
          nextInterventionAt: nonNeg(src.session.nextInterventionAt),
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
      state.stats.interventions = 0;
      state.stats.turnedAway = 0;
      state.stats.intentions = 0;
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

  /** How long one blocked page is treated as "the same block" for counting. */
  const BLOCK_COUNT_WINDOW = 60 * 1000;

  /**
   * Count a blocked navigation, once.
   *
   * A single locked navigation reaches the engine several times: Chrome fires
   * webNavigation.onBeforeNavigate and tabs.onUpdated for it, and re-evaluates
   * again when the tab lands on our own blocked page's URL. All of those are the
   * same block, so the counter only moves when the last count is older than
   * BLOCK_COUNT_WINDOW (or the reason changed — schedule, cooldown and
   * second-tab are genuinely different things).
   */
  function countBlock(st, state, pattern, reason, now) {
    const sameBlock = st.lastBlockAt && now - st.lastBlockAt < BLOCK_COUNT_WINDOW && st.lastBlockReason === reason;
    st.lastBlockAt = now;
    st.lastBlockReason = reason;
    if (sameBlock) return false;
    st.blocked += 1;
    state.stats.blocked += 1;
    logEvent(state, { at: now, kind: 'blocked', site: pattern || '', text: reason });
    return true;
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

  /* ------------------------------------------------------------------ */
  /* scheduled blocks                                                    */
  /* ------------------------------------------------------------------ */

  function minutesOf(hhmm) {
    const parts = String(hhmm).split(':');
    return Number(parts[0]) * 60 + Number(parts[1] || 0);
  }

  function dayStart(now) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /** Is this block live at `now`, and when does it end? */
  function blockWindow(block, now) {
    const d = new Date(now);
    const day = d.getDay();
    const mins = d.getHours() * 60 + d.getMinutes();
    const start = minutesOf(block.start);
    const end = minutesOf(block.end);
    const midnight = dayStart(now);
    const overnight = end <= start;

    if (!overnight) {
      if (!block.days.includes(day) || mins < start || mins >= end) return null;
      return { endsAt: midnight + end * 60000 };
    }
    // e.g. 22:00 → 02:00: runs into the next calendar day.
    const todayApplies = block.days.includes(day) && mins >= start;
    if (todayApplies) return { endsAt: midnight + 86400000 + end * 60000 };
    const yesterday = (day + 6) % 7;
    const earlyMorning = block.days.includes(yesterday) && mins < end;
    if (earlyMorning) return { endsAt: midnight + end * 60000 };
    return null;
  }

  /** The schedule as it stands right now. */
  function scheduleStatus(cfg, now) {
    const sched = cfg.schedule || { enabled: false, blocks: [], pausable: false };
    if (!sched.enabled || !sched.blocks.length) {
      return { active: false, block: null, endsAt: 0, nextStart: 0, nextBlock: null, pausable: !!sched.pausable };
    }
    for (const block of sched.blocks) {
      if (!block.enabled) continue;
      const win = blockWindow(block, now);
      if (win) {
        return { active: true, block, endsAt: win.endsAt, nextStart: 0, nextBlock: null, pausable: !!sched.pausable };
      }
    }
    // Nothing active: find the next window so the UI can say "block starts in 2h".
    let nextStart = 0;
    let nextBlock = null;
    for (let offset = 0; offset < 8; offset++) {
      const probe = dayStart(now) + offset * 86400000;
      for (const block of sched.blocks) {
        if (!block.enabled) continue;
        for (let dayOffset = 0; dayOffset <= offset; dayOffset++) {
          const dayTs = dayStart(now) + (offset - dayOffset) * 86400000;
          const day = new Date(dayTs).getDay();
          if (!block.days.includes(day)) continue;
          const candidate = dayTs + minutesOf(block.start) * 60000;
          if (candidate > now && (!nextStart || candidate < nextStart)) {
            nextStart = candidate;
            nextBlock = block;
          }
        }
      }
      if (nextStart) break;
    }
    return { active: false, block: null, endsAt: 0, nextStart, nextBlock, pausable: !!sched.pausable };
  }

  /** A scheduled block that a pause is allowed to override. */
  function scheduleBlocksAccess(state, cfg, now) {
    const status = scheduleStatus(cfg, now);
    if (!status.active) return false;
    if (pauseActive(state, now) && status.pausable) return false;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* pause gate                                                          */
  /* ------------------------------------------------------------------ */

  function canStartPause(state, cfg, now) {
    rollDay(state, now);
    const pause = state.pause;
    const limit = cfg.pause.maxPerDay;
    if (pauseActive(state, now)) {
      return {
        ok: false,
        reason: 'already-paused',
        retryAt: pause.until,
        remainingToday: Math.max(0, limit - pause.usedToday),
      };
    }
    const gapMs = (Number(cfg.pause.minGapMinutes) || 0) * 60000;
    if (gapMs > 0 && pause.lastPauseAt && now < pause.lastPauseAt + gapMs) {
      return {
        ok: false,
        reason: 'too-soon',
        retryAt: pause.lastPauseAt + gapMs,
        remainingToday: Math.max(0, limit - pause.usedToday),
      };
    }
    if (limit <= 0) return { ok: false, reason: 'disabled', retryAt: 0, remainingToday: 0 };
    if (pause.usedToday >= limit) return { ok: false, reason: 'daily-limit', retryAt: 0, remainingToday: 0 };
    return { ok: true, reason: 'ok', retryAt: 0, remainingToday: limit - pause.usedToday };
  }

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
    return { ok: true, until: state.pause.until, minutes: chosen, remainingToday: gate.remainingToday - 1 };
  }

  function stopPause(state, now) {
    const wasActive = pauseActive(state, now);
    state.pause.until = 0;
    for (const key of Object.keys(state.sites)) {
      state.sites[key].session = null;
    }
    return { ok: true, wasActive };
  }

  function expirePause(state, now) {
    if (state.pause.until && state.pause.until <= now) {
      state.pause.until = 0;
      for (const key of Object.keys(state.sites)) state.sites[key].session = null;
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* the log (intentions live here too)                                  */
  /* ------------------------------------------------------------------ */

  function logEvent(state, entry) {
    if (!Array.isArray(state.log)) state.log = [];
    state.log.unshift({
      at: Math.round(entry.at || Date.now()),
      kind: String(entry.kind || 'event').slice(0, 24),
      site: entry.site ? Util.normalizeSite(entry.site) : '',
      text: String(entry.text || '').slice(0, INTENTION_MAX),
      seconds: Math.max(0, Math.round(entry.seconds || 0)),
    });
    if (state.log.length > LOG_MAX) state.log.length = LOG_MAX;
    return state.log[0];
  }

  function logSince(state, since, kinds) {
    const list = Array.isArray(state.log) ? state.log : [];
    return list.filter((e) => e.at >= since && (!kinds || kinds.includes(e.kind)));
  }

  /**
   * Record that an intervention was completed (or walked away from).
   * `outcome` is 'continue' or 'close'.
   */
  function recordIntervention(state, cfg, site, now, outcome, extra) {
    const st = getSiteState(state, site.pattern, now);
    state.stats.interventions += 1;
    if (outcome === 'close') {
      state.stats.turnedAway += 1;
      logEvent(state, { at: now, kind: 'turned-away', site: site.pattern, text: '' });
      return { ok: true };
    }
    const iv = cfg.intervention || {};
    logEvent(state, {
      at: now,
      kind: 'intervention',
      site: site.pattern,
      text: (extra && extra.intention) || '',
      seconds: iv.durationSeconds || 0,
    });
    if ((extra && extra.intention) || iv.requireIntention) {
      const text = String((extra && extra.intention) || '').trim();
      if (text) {
        state.stats.intentions += 1;
        logEvent(state, { at: now, kind: 'intention', site: site.pattern, text });
      }
    }
    // A second look later in the visit, if configured.
    if (iv.reinterveneSeconds > 0) {
      st.pendingReintervention = true;
    }
    return { ok: true };
  }

  /* ------------------------------------------------------------------ */
  /* navigation                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Decide what to do when a tab is (or was) heading to `pattern`.
   * Returns one of:
   *   { action:'allow',  ... }  let it load
   *   { action:'intervene', ... } show the friction screen first
   *   { action:'block',  ... }  send the tab to the blocked page
   */
  function evaluateNavigation(state, cfg, pattern, tabId, now, opts) {
    const options = opts || {};
    rollDay(state, now);
    expirePause(state, now);

    if (!cfg.enabled) return { action: 'allow', reason: REASONS.DISABLED };

    const site = findSite(cfg, pattern);
    if (!site) return { action: 'allow', reason: REASONS.UNTRACKED };
    // A site you switched off is tracked, just not enforced. Saying "untracked"
    // sent the content script down a branch that never told the chip anything,
    // so a site you had switched off showed no chip at all on the page.
    if (!site.enabled) return { action: 'allow', reason: REASONS.DISABLED, site: site.pattern, label: site.label };

    const st = getSiteState(state, site.pattern, now);

    /* 1. scheduled focus hours win over everything but a pause */
    if (scheduleBlocksAccess(state, cfg, now)) {
      const status = scheduleStatus(cfg, now);
      // Chrome fires several listeners for one navigation (onBeforeNavigate,
      // tabs.onUpdated, sometimes onHistoryStateUpdated). Counting every
      // evaluation made "distractions blocked today" climb two or three times
      // per blocked page, so a block is only counted once per tab per minute.
      countBlock(st, state, site.pattern, 'schedule', now);
      return {
        action: 'block',
        reason: REASONS.SCHEDULE,
        site: site.pattern,
        label: site.label,
        until: status.endsAt,
        cooldownReason: REASONS.SCHEDULE,
        cooldownLabel: `Focus hours: ${status.block.start}–${status.block.end}`,
        blockLabel: status.block.label,
        scheduled: true,
      };
    }

    if (pauseActive(state, now)) {
      st.lastVisitAt = now;
      logEvent(state, { at: now, kind: 'visit-paused', site: site.pattern });
      return { action: 'allow', reason: REASONS.PAUSED, pauseUntil: state.pause.until, site: site.pattern };
    }

    /* 2. the cooldown wall */
    if (st.cooldownUntil > now) {
      countBlock(st, state, site.pattern, 'cooldown', now);
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
      countBlock(st, state, site.pattern, 'second-tab', now);
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

    /* 3. friction on the way in */
    const iv = cfg.intervention || {};
    if (iv.enabled && !options.skipIntervention) {
      return {
        action: 'intervene',
        reason: REASONS.INTERVENE,
        site: site.pattern,
        label: site.label,
        intervention: {
          type: iv.type,
          durationSeconds: iv.durationSeconds,
          requireIntention: iv.requireIntention,
          showAlternative: iv.showAlternative,
          alternative: iv.alternative,
          allowSkip: iv.allowSkip,
        },
      };
    }

    /* 4. a fresh visit */
    const session = startSession(state, cfg, site, tabId, now);
    return {
      action: 'allow',
      reason: 'started',
      site: site.pattern,
      label: site.label,
      session: publicSession(session, site, now),
    };
  }

  function startSession(state, cfg, site, tabId, now) {
    const st = getSiteState(state, site.pattern, now);
    const iv = cfg.intervention || {};
    const session = {
      tabId,
      windowId: -1,
      startedAt: now,
      graceEndsAt: now + (site.graceSeconds || 0) * 1000,
      focusedSeconds: 0,
      lastTickAt: now,
      capSeconds: site.maxSessionSeconds,
      nextInterventionAt: iv.reinterveneSeconds > 0 ? iv.reinterveneSeconds : 0,
    };
    st.session = session;
    st.lastVisitAt = now;
    state.stats.sessions += 1;
    logEvent(state, { at: now, kind: 'visit', site: site.pattern });
    return session;
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
   */
  function heartbeat(state, cfg, pattern, tabId, now, focused) {
    rollDay(state, now);
    expirePause(state, now);

    const site = findSite(cfg, pattern);
    if (!site || !site.enabled || !cfg.enabled) return { action: 'allow', reason: REASONS.UNTRACKED };
    const st = getSiteState(state, site.pattern, now);

    if (scheduleBlocksAccess(state, cfg, now)) {
      const status = scheduleStatus(cfg, now);
      return {
        action: 'block',
        reason: REASONS.SCHEDULE,
        site: site.pattern,
        label: site.label,
        until: status.endsAt,
      };
    }

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

      // A second look mid-visit, if configured.
      const iv = cfg.intervention || {};
      if (iv.enabled && session.nextInterventionAt > 0 && session.focusedSeconds >= session.nextInterventionAt) {
        session.nextInterventionAt = session.focusedSeconds + Math.max(60, iv.reinterveneSeconds);
        return {
          action: 'intervene',
          reason: REASONS.REINTERVENE,
          site: site.pattern,
          label: site.label,
          reintervention: true,
          intervention: {
            type: iv.type,
            durationSeconds: Math.min(iv.durationSeconds, 15),
            requireIntention: false,
            showAlternative: iv.showAlternative,
            alternative: iv.alternative,
            allowSkip: false,
          },
        };
      }

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
    logEvent(state, { at: now, kind: 'cooldown', site: site.pattern, text: reason, seconds: cooldown });
    return { cooldownUntil: st.cooldownUntil, cooldownSeconds: cooldown, graceUsed: false };
  }

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
        st.bestFocusSeconds = Math.max(st.bestFocusSeconds, Math.round(st.session.focusedSeconds));
        st.session = null;
        st.lastLeaveAt = now;
        st.trips += 1;
        return { action: 'allow', reason: 'grace-closed', cooldownUntil: 0, cooldownSeconds: 0 };
      }
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

  function recordTabClosed(state, cfg, pattern, now) {
    return recordLeave(state, cfg, pattern, now, REASONS.CLOSED, true);
  }

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

  /* ------------------------------------------------------------------ */
  /* snapshots for the UI                                               */
  /* ------------------------------------------------------------------ */

  function snapshot(state, cfg, now) {
    rollDay(state, now);
    const sched = scheduleStatus(cfg, now);
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
      intervention: cfg.intervention,
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
      schedule: {
        enabled: cfg.schedule.enabled,
        pausable: cfg.schedule.pausable,
        active: sched.active,
        block: sched.block
          ? { id: sched.block.id, label: sched.block.label, start: sched.block.start, end: sched.block.end, days: sched.block.days }
          : null,
        endsAt: sched.endsAt,
        nextStart: sched.nextStart,
        nextBlock: sched.nextBlock ? { id: sched.nextBlock.id, label: sched.nextBlock.label, start: sched.nextBlock.start, end: sched.nextBlock.end } : null,
        blocks: cfg.schedule.blocks,
      },
      stats: {
        day: state.stats.day,
        blocked: state.stats.blocked,
        sessions: state.stats.sessions,
        focusSeconds: Math.round(state.stats.focusSeconds),
        interventions: state.stats.interventions,
        turnedAway: state.stats.turnedAway,
        intentions: state.stats.intentions,
        pauses: state.pause.total,
      },
      /** Today's intentions + a short activity mirror, newest first. */
      log: (Array.isArray(state.log) ? state.log : []).slice(0, 40),
      intentions: (Array.isArray(state.log) ? state.log : []).filter((e) => e.kind === 'intention').slice(0, 12),
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
    scheduleStatus,
    scheduleBlocksAccess,
    evaluateNavigation,
    startSession,
    heartbeat,
    endVisit,
    recordLeave,
    recordTabClosed,
    endSessionManually,
    recordIntervention,
    logEvent,
    logSince,
    collectExpiredCooldowns,
    snapshot,
    publicSession,
  };
});
