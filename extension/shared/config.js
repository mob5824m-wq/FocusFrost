/**
 * FocusFrost — settings schema, defaults and normalisation.
 *
 * Every field is clamped here so a hand-edited or synced payload can never
 * turn a "10 minute" cooldown into a "10 day" one by accident.
 */
(function (root, factory) {
  const api = factory(root.FFUtil || (typeof require === 'function' ? require('./util.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FFConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Util) {
  'use strict';

  const LIMITS = {
    cooldownSeconds: { min: 10, max: 86400 },
    graceSeconds: { min: 0, max: 600 },
    maxSessionSeconds: { min: 30, max: 7200 },
    holdMs: { min: 3000, max: 10000 },
    pauseMinutes: { min: 1, max: 30 },
    maxPerDay: { min: 0, max: 10 },
    minGapMinutes: { min: 0, max: 480 },
    interventionSeconds: { min: 3, max: 120 },
    reinterveneSeconds: { min: 0, max: 3600 },
  };

  /** The friction screens. Each one is a different way to break the autopilot. */
  const INTERVENTIONS = {
    breath: {
      id: 'breath',
      label: 'Take a deep breath',
      blurb: 'A slow guided breath — in, hold, out. The original one sec intervention.',
      needsText: false,
    },
    breathe478: {
      id: 'breathe478',
      label: '4-7-8 breathing',
      blurb: 'The longer, structured pattern used for anxiety: in 4, hold 7, out 8.',
      needsText: false,
    },
    reflect: {
      id: 'reflect',
      label: 'Ask yourself why',
      blurb: 'Two honest questions about what you are actually here for.',
      needsText: true,
    },
    type: {
      id: 'type',
      label: 'Type a phrase',
      blurb: 'Copy a random phrase exactly. Pure friction — no thinking required.',
      needsText: true,
    },
    intention: {
      id: 'intention',
      label: 'State your intention',
      blurb: 'One sentence on what you are about to do. Recorded, so you can check yourself later.',
      needsText: true,
    },
  };

  const PRESET_SITES = [
    'youtube.com',
    'instagram.com',
    'tiktok.com',
    'x.com',
    'reddit.com',
    'facebook.com',
    'twitch.tv',
    'netflix.com',
    'discord.com',
    'snapchat.com',
    'pinterest.com',
    'tumblr.com',
    'linkedin.com',
    'news.ycombinator.com',
  ];

  function makeSite(pattern, overrides) {
    const p = Util.normalizeSite(pattern);
    return Object.assign(
      {
        id: Util.uid('site'),
        pattern: p,
        label: Util.siteLabel(p),
        enabled: true,
        cooldownSeconds: 600,
        graceSeconds: 20,
        maxSessionSeconds: 300,
      },
      overrides || {}
    );
  }

  function defaultSettings() {
    return {
      version: 2,
      enabled: true,
      sites: [
        makeSite('youtube.com'),
        makeSite('instagram.com'),
        makeSite('tiktok.com'),
        makeSite('x.com'),
        makeSite('reddit.com'),
      ],
      defaults: {
        cooldownSeconds: 600,
        graceSeconds: 20,
        maxSessionSeconds: 300,
      },

      /* The one-sec side: friction before the visit starts. */
      intervention: {
        enabled: true,
        type: 'breath',
        durationSeconds: 10,
        requireIntention: false,
        showAlternative: true,
        alternative:
          'Put the kettle on and come back in ten minutes. If you still want it then, it will still be here.',
        allowSkip: false,
        reinterveneSeconds: 0, // 0 = off. Otherwise: seconds of focused time before a second pause.
        // The cooldown page offers a breathing exercise as a way back in. It
        // spends one of the day's pauses: the cooldown should cost something,
        // and this keeps a single ledger for every way through the shield.
        breatheToPass: true,
        breatheMinutes: 2,
      },

      pause: {
        holdMs: 6000,
        presets: [5, 15, 30],
        maxPerDay: 2,
        minGapMinutes: 30,
        strict: true,
      },

      /* Hard "don't even ask" windows, independent of cooldowns. */
      schedule: {
        enabled: false,
        pausable: false, // can a hold-to-pause override a scheduled block?
        blocks: [],
      },

      behavior: {
        closeOnBlur: true,
        blockNewTabs: true,
        showChip: true,
        notifyOnEnd: true,
        closeInsteadOfCooldown: false,
      },
    };
  }

  function num(value, fallback, bounds) {
    const raw = Number(value);
    const n = Number.isFinite(raw) ? raw : fallback;
    return Util.clamp(Math.round(n), bounds.min, bounds.max);
  }

  function normalizeSite(raw, defaults) {
    if (!raw) return null;
    const pattern = Util.normalizeSite(raw.pattern);
    if (!pattern) return null;
    return {
      id: String(raw.id || Util.uid('site')),
      pattern,
      label: String(raw.label || Util.siteLabel(pattern)).slice(0, 40),
      enabled: raw.enabled !== false,
      cooldownSeconds: num(raw.cooldownSeconds, defaults.cooldownSeconds, LIMITS.cooldownSeconds),
      graceSeconds: num(raw.graceSeconds, defaults.graceSeconds, LIMITS.graceSeconds),
      maxSessionSeconds: num(raw.maxSessionSeconds, defaults.maxSessionSeconds, LIMITS.maxSessionSeconds),
    };
  }

  const DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

  function normalizeBlock(raw) {
    if (!raw) return null;
    const start = String(raw.start || '');
    const end = String(raw.end || '');
    if (!DAY.test(start) || !DAY.test(end)) return null;
    if (start === end) return null;
    let days = Array.isArray(raw.days) ? raw.days.map(Number).filter((d) => d >= 0 && d <= 6) : [];
    days = Array.from(new Set(days)).sort((a, b) => a - b);
    if (!days.length) days = [1, 2, 3, 4, 5];
    return {
      id: String(raw.id || Util.uid('block')),
      label: String(raw.label || 'Focus block').slice(0, 40),
      days,
      start,
      end,
      enabled: raw.enabled !== false,
    };
  }

  /** Merge an unknown/corrupt object into a guaranteed-valid settings object. */
  function normalizeSettings(input) {
    const base = defaultSettings();
    if (!input || typeof input !== 'object') return base;

    const defaults = {
      cooldownSeconds: num(
        input.defaults && input.defaults.cooldownSeconds,
        base.defaults.cooldownSeconds,
        LIMITS.cooldownSeconds
      ),
      graceSeconds: num(
        input.defaults && input.defaults.graceSeconds,
        base.defaults.graceSeconds,
        LIMITS.graceSeconds
      ),
      maxSessionSeconds: num(
        input.defaults && input.defaults.maxSessionSeconds,
        base.defaults.maxSessionSeconds,
        LIMITS.maxSessionSeconds
      ),
    };

    const seen = new Set();
    const sites = (Array.isArray(input.sites) ? input.sites : base.sites)
      .map((s) => normalizeSite(s, defaults))
      .filter((s) => {
        if (!s || seen.has(s.pattern)) return false;
        seen.add(s.pattern);
        return true;
      })
      .slice(0, 200);

    const pauseIn = input.pause || {};
    let presets = (Array.isArray(pauseIn.presets) ? pauseIn.presets : base.pause.presets)
      .map((m) => num(m, 5, LIMITS.pauseMinutes))
      .filter((m, i, arr) => arr.indexOf(m) === i)
      .sort((a, b) => a - b)
      .slice(0, 4);
    if (!presets.length) presets = base.pause.presets.slice();

    const ivIn = input.intervention || {};
    const type = INTERVENTIONS[ivIn.type] ? ivIn.type : base.intervention.type;

    const schedIn = input.schedule || {};
    const blocks = (Array.isArray(schedIn.blocks) ? schedIn.blocks : [])
      .map(normalizeBlock)
      .filter(Boolean)
      .slice(0, 12);

    return {
      version: 2,
      enabled: input.enabled !== false,
      sites,
      defaults,
      intervention: {
        enabled: ivIn.enabled !== false,
        type,
        durationSeconds: num(ivIn.durationSeconds, base.intervention.durationSeconds, LIMITS.interventionSeconds),
        requireIntention: ivIn.requireIntention === true,
        showAlternative: ivIn.showAlternative !== false,
        alternative: String(ivIn.alternative == null ? base.intervention.alternative : ivIn.alternative).slice(0, 240),
        allowSkip: ivIn.allowSkip === true,
        reinterveneSeconds: num(
          ivIn.reinterveneSeconds,
          base.intervention.reinterveneSeconds,
          LIMITS.reinterveneSeconds
        ),
        breatheToPass: ivIn.breatheToPass !== false,
        breatheMinutes: num(ivIn.breatheMinutes, base.intervention.breatheMinutes, LIMITS.pauseMinutes),
      },
      pause: {
        holdMs: num(pauseIn.holdMs, base.pause.holdMs, LIMITS.holdMs),
        presets,
        maxPerDay: num(pauseIn.maxPerDay, base.pause.maxPerDay, LIMITS.maxPerDay),
        minGapMinutes: num(pauseIn.minGapMinutes, base.pause.minGapMinutes, LIMITS.minGapMinutes),
        strict: pauseIn.strict !== false,
      },
      schedule: {
        enabled: schedIn.enabled === true && blocks.length > 0,
        pausable: schedIn.pausable === true,
        blocks,
      },
      behavior: {
        closeOnBlur: (input.behavior || {}).closeOnBlur !== false,
        blockNewTabs: (input.behavior || {}).blockNewTabs !== false,
        showChip: (input.behavior || {}).showChip !== false,
        notifyOnEnd: (input.behavior || {}).notifyOnEnd !== false,
        closeInsteadOfCooldown: (input.behavior || {}).closeInsteadOfCooldown === true,
      },
    };
  }

  return {
    LIMITS,
    PRESET_SITES,
    INTERVENTIONS,
    defaultSettings,
    normalizeSettings,
    normalizeBlock,
    makeSite,
  };
});
