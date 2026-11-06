/**
 * FocusFrost — settings schema, defaults and normalisation.
 * Every field is clamped here so a hand-edited sync payload can never
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
      version: 1,
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
      pause: {
        holdMs: 6000,
        presets: [5, 15, 30], // minutes the user may choose from
        maxPerDay: 2,         // how many focus pauses allowed per day
        minGapMinutes: 30,    // enforced rest between two pauses
        strict: true,         // hard cap on every pause duration
      },
      behavior: {
        closeOnBlur: true,    // close the tab when you wander off
        blockNewTabs: true,   // a second tab on a tracked site gets blocked
        showChip: true,       // floating countdown on the page
        notifyOnEnd: true,    // system notification when a session is killed
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

    return {
      version: 1,
      enabled: input.enabled !== false,
      sites,
      defaults,
      pause: {
        holdMs: num(pauseIn.holdMs, base.pause.holdMs, LIMITS.holdMs),
        presets,
        maxPerDay: num(pauseIn.maxPerDay, base.pause.maxPerDay, LIMITS.maxPerDay),
        minGapMinutes: num(pauseIn.minGapMinutes, base.pause.minGapMinutes, LIMITS.minGapMinutes),
        strict: pauseIn.strict !== false,
      },
      behavior: {
        closeOnBlur: (input.behavior || {}).closeOnBlur !== false,
        blockNewTabs: (input.behavior || {}).blockNewTabs !== false,
        showChip: (input.behavior || {}).showChip !== false,
        notifyOnEnd: (input.behavior || {}).notifyOnEnd !== false,
      },
    };
  }

  return { LIMITS, PRESET_SITES, defaultSettings, normalizeSettings, makeSite };
});
