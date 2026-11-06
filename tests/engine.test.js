/* FocusFrost engine tests — run with: node --test tests/ */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const Config = require(path.join(__dirname, '../extension/shared/config.js'));
const Engine = require(path.join(__dirname, '../extension/shared/engine.js'));

const T0 = new Date(2026, 10, 6, 9, 0, 0).getTime();

function setup(overrides) {
  const cfg = Config.normalizeSettings(
    Object.assign(
      {
        sites: [
          {
            id: 'site_yt',
            pattern: 'youtube.com',
            label: 'YouTube',
            enabled: true,
            cooldownSeconds: 600,
            graceSeconds: 20,
            maxSessionSeconds: 300,
          },
        ],
        pause: { holdMs: 6000, presets: [5, 15, 30], maxPerDay: 2, minGapMinutes: 30, strict: true },
        // The intervention gate has its own tests; keep it out of the way here.
        intervention: { enabled: false },
      },
      overrides || {}
    )
  );
  return { cfg, state: Engine.emptyState(T0) };
}

function nav(ctx, at, tabId) {
  return Engine.evaluateNavigation(ctx.state, ctx.cfg, 'youtube.com', tabId === undefined ? 7 : tabId, at);
}

test('grace window lets you leave and come back for free', () => {
  const ctx = setup();
  const first = nav(ctx, T0);
  assert.equal(first.action, 'allow');
  assert.equal(first.reason, 'started');
  assert.equal(first.session.graceEndsAt, T0 + 20000);

  // Leave 5s in (inside grace), tab still alive -> free bounce.
  const leave = Engine.recordLeave(ctx.state, ctx.cfg, 'www.youtube.com', T0 + 5000);
  assert.equal(leave.action, 'allow');
  assert.equal(leave.reason, 'grace');

  // Come straight back -> same visit, grace clock untouched.
  const back = nav(ctx, T0 + 8000);
  assert.equal(back.action, 'allow');
  assert.equal(back.reason, 'session-active');
  assert.equal(back.session.graceEndsAt, T0 + 20000);
});

test('closing the tab inside grace is free and does not leave a ghost session', () => {
  const ctx = setup();
  nav(ctx, T0);
  const closed = Engine.recordTabClosed(ctx.state, ctx.cfg, 'youtube.com', T0 + 5000);
  assert.equal(closed.action, 'allow');
  assert.equal(closed.reason, 'grace-closed');
  assert.equal(ctx.state.sites['youtube.com'].session, null);
  // A fresh tab opens normally and is not mistaken for a second tab.
  const reopen = nav(ctx, T0 + 6000, 9);
  assert.equal(reopen.action, 'allow');
  assert.equal(reopen.reason, 'started');
});

test('leaving after the grace window locks the site for the cooldown', () => {
  const ctx = setup();
  nav(ctx, T0);
  const leave = Engine.recordLeave(ctx.state, ctx.cfg, 'youtube.com', T0 + 30000);
  assert.equal(leave.action, 'close');
  assert.equal(leave.cooldownSeconds, 600);
  assert.equal(leave.cooldownUntil, T0 + 30000 + 600000);

  const blocked = nav(ctx, T0 + 60000);
  assert.equal(blocked.action, 'block');
  assert.equal(blocked.reason, 'cooldown');
  assert.equal(blocked.until, T0 + 630000);
  assert.equal(blocked.cooldownLabel, 'You switched away');
  assert.equal(blocked.label, 'YouTube');

  // Still blocked one second before expiry, allowed at expiry.
  assert.equal(nav(ctx, T0 + 629999).action, 'block');
  assert.equal(nav(ctx, T0 + 630001).action, 'allow');
});

test('closing the tab after grace is a cooldown with its own reason', () => {
  const ctx = setup();
  nav(ctx, T0);
  const res = Engine.recordTabClosed(ctx.state, ctx.cfg, 'youtube.com', T0 + 45000);
  assert.equal(res.action, 'close');
  assert.equal(ctx.state.sites['youtube.com'].cooldownReason, Engine.REASONS.CLOSED);
});

test('focused time accumulates and the session cap force-closes the tab', () => {
  const ctx = setup();
  nav(ctx, T0);
  let at = T0;
  let last;
  // 300s cap, one heartbeat per second while focused.
  for (let i = 0; i < 299; i++) {
    at += 1000;
    last = Engine.heartbeat(ctx.state, ctx.cfg, 'youtube.com', 7, at, true);
    assert.equal(last.action, 'allow');
  }
  assert.ok(last.session.remainingSeconds <= 2, 'cap is counting down');
  at += 1000;
  const closed = Engine.heartbeat(ctx.state, ctx.cfg, 'youtube.com', 7, at, true);
  assert.equal(closed.action, 'close');
  assert.equal(closed.reason, Engine.REASONS.LIMIT);
  assert.ok(closed.cooldownUntil > at);
  // No session left behind.
  assert.equal(ctx.state.sites['youtube.com'].session, null);
});

test('losing focus inside grace is fine, after grace it closes', () => {
  const ctx = setup();
  nav(ctx, T0);
  const early = Engine.heartbeat(ctx.state, ctx.cfg, 'youtube.com', 7, T0 + 4000, false);
  assert.equal(early.action, 'allow');
  const late = Engine.heartbeat(ctx.state, ctx.cfg, 'youtube.com', 7, T0 + 40000, false);
  assert.equal(late.action, 'close');
  assert.equal(late.reason, Engine.REASONS.BLUR);
});

test('a second tab cannot open the same site', () => {
  const ctx = setup();
  nav(ctx, T0, 7);
  const second = nav(ctx, T0 + 1000, 8);
  assert.equal(second.action, 'block');
  assert.equal(second.reason, Engine.REASONS.SECOND_TAB);
  assert.equal(second.otherTabId, 7);
  // The original tab is unaffected.
  assert.equal(Engine.heartbeat(ctx.state, ctx.cfg, 'youtube.com', 7, T0 + 2000, true).action, 'allow');
});

test('one visit, one tab: reloading the same tab keeps the clock', () => {
  const ctx = setup();
  nav(ctx, T0, 7);
  const again = nav(ctx, T0 + 12000, 7);
  assert.equal(again.action, 'allow');
  assert.equal(again.reason, Engine.REASONS.SESSION_ACTIVE);
  assert.equal(again.resumed, true);
  assert.equal(again.session.startedAt, T0);
});

test('pause: only presets, limited per day, with a mandatory gap', () => {
  const ctx = setup();
  const bad = Engine.startPause(ctx.state, ctx.cfg, 45, T0);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'not-a-preset');

  const good = Engine.startPause(ctx.state, ctx.cfg, 15, T0);
  assert.equal(good.ok, true);
  assert.equal(ctx.state.pause.until, T0 + 15 * 60000);
  assert.equal(good.remainingToday, 1);

  const twice = Engine.startPause(ctx.state, ctx.cfg, 5, T0 + 1000);
  assert.equal(twice.ok, false);
  assert.equal(twice.reason, 'already-paused');

  // After the pause expires the gap still applies.
  const after = T0 + 15 * 60000 + 5000;
  assert.equal(Engine.pauseActive(ctx.state, after), false);
  const tooSoon = Engine.startPause(ctx.state, ctx.cfg, 5, after);
  assert.equal(tooSoon.ok, false);
  assert.equal(tooSoon.reason, 'too-soon');

  const later = T0 + 15 * 60000 + 30 * 60000 + 1000;
  const second = Engine.startPause(ctx.state, ctx.cfg, 5, later);
  assert.equal(second.ok, true);
  assert.equal(second.remainingToday, 0);

  const third = Engine.startPause(ctx.state, ctx.cfg, 5, later + 2 * 3600000);
  assert.equal(third.ok, false);
  assert.equal(third.reason, 'daily-limit');
});

test('pause lifts an active cooldown and lets the site through', () => {
  const ctx = setup();
  nav(ctx, T0);
  Engine.recordLeave(ctx.state, ctx.cfg, 'youtube.com', T0 + 60000);
  assert.equal(nav(ctx, T0 + 61000).action, 'block');

  const pause = Engine.startPause(ctx.state, ctx.cfg, 5, T0 + 62000);
  assert.equal(pause.ok, true);

  const allowed = nav(ctx, T0 + 63000);
  assert.equal(allowed.action, 'allow');
  assert.equal(allowed.reason, Engine.REASONS.PAUSED);

  // It expires on its own. The old lockout stays lifted (that is the price of
  // a pause) but the next visit is a normal, capped visit again.
  const after = T0 + 62000 + 5 * 60000 + 1;
  assert.equal(Engine.pauseActive(ctx.state, after), false);
  assert.equal(ctx.state.sites['youtube.com'].cooldownUntil, 0);
  const fresh = nav(ctx, after, 11);
  assert.equal(fresh.action, 'allow');
  assert.equal(fresh.reason, 'started');
  // ...and leaving that visit after grace locks it again.
  const leave = Engine.recordLeave(ctx.state, ctx.cfg, 'youtube.com', after + 60000);
  assert.equal(leave.action, 'close');
});

test('pause can be cut short manually', () => {
  const ctx = setup();
  Engine.startPause(ctx.state, ctx.cfg, 30, T0);
  assert.equal(Engine.pauseActive(ctx.state, T0 + 1000), true);
  const res = Engine.stopPause(ctx.state, T0 + 2000);
  assert.equal(res.wasActive, true);
  assert.equal(Engine.pauseActive(ctx.state, T0 + 3000), false);
  // The pause still counts against the daily allowance.
  assert.equal(ctx.state.pause.usedToday, 1);
});

test('daily counters reset at midnight', () => {
  const ctx = setup();
  Engine.startPause(ctx.state, ctx.cfg, 5, T0);
  assert.equal(ctx.state.pause.usedToday, 1);
  const tomorrow = new Date(2026, 10, 7, 0, 30, 0).getTime();
  Engine.rollDay(ctx.state, tomorrow);
  assert.equal(ctx.state.pause.usedToday, 0);
  assert.equal(ctx.state.stats.blocked, 0);
});

test('untracked hosts and disabled sites pass straight through', () => {
  const ctx = setup();
  assert.equal(Engine.evaluateNavigation(ctx.state, ctx.cfg, 'news.ycombinator.com', 7, T0).reason, 'untracked');
  ctx.cfg.enabled = false;
  assert.equal(nav(ctx, T0).action, 'allow');
  assert.equal(nav(ctx, T0).reason, 'disabled');
});

test('subdomains are covered, lookalikes are not', () => {
  const ctx = setup();
  assert.ok(Engine.findSite(ctx.cfg, 'm.youtube.com'));
  assert.ok(Engine.findSite(ctx.cfg, 'youtube.com'));
  assert.equal(Engine.findSite(ctx.cfg, 'notyoutube.com'), null);
  assert.equal(Engine.findSite(ctx.cfg, 'youtube.com.evil.io'), null);
});

test('settings are clamped against absurd or corrupt values', () => {
  const cfg = Config.normalizeSettings({
    sites: [
      { pattern: 'https://www.Reddit.com/r/all', cooldownSeconds: 1e9, graceSeconds: -5, maxSessionSeconds: 1 },
      { pattern: 'not a domain' },
      { pattern: 'reddit.com' },
    ],
    pause: { holdMs: 1, presets: [999, 999, -3], maxPerDay: 99 },
  });
  assert.equal(cfg.sites.length, 1);
  const site = cfg.sites[0];
  assert.equal(site.pattern, 'reddit.com');
  assert.equal(site.cooldownSeconds, 86400);
  assert.equal(site.graceSeconds, 0);
  assert.equal(site.maxSessionSeconds, 30);
  assert.equal(cfg.pause.holdMs, 3000);
  // [999, 999, -3] -> dedupe then clamp -> [30, 1] -> sorted [1, 30]
  assert.deepEqual(cfg.pause.presets, [1, 30]);
  assert.equal(cfg.pause.maxPerDay, 10);
});

test('corrupt stored state is repaired', () => {
  const raw = { sites: { 'youtube.com': { cooldownUntil: 'nope', session: { tabId: 'x' }, focusSeconds: -20 } } };
  const state = Engine.normalizeState(raw, T0);
  assert.equal(state.sites['youtube.com'].cooldownUntil, 0);
  assert.equal(state.sites['youtube.com'].focusSeconds, 0);
  assert.equal(state.sites['youtube.com'].session.startedAt, 0);
});

test('snapshot reports cooling and active counts', () => {
  const ctx = setup();
  nav(ctx, T0);
  let snap = Engine.snapshot(ctx.state, ctx.cfg, T0 + 1000);
  assert.equal(snap.totals.active, 1);
  assert.equal(snap.sites[0].session.inGrace, true);

  Engine.recordLeave(ctx.state, ctx.cfg, 'youtube.com', T0 + 60000);
  snap = Engine.snapshot(ctx.state, ctx.cfg, T0 + 61000);
  assert.equal(snap.totals.active, 0);
  assert.equal(snap.totals.cooling, 1);
  assert.equal(snap.sites[0].cooldownRemaining, 600000 - 1000);
  assert.equal(snap.pause.canStart, true);
});
