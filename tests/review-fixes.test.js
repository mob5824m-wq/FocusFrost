/**
 * Regressions found in a review pass, all three of them silent.
 *
 * 1. Flipping the master switch in the popup wiped settings the popup does not
 *    render (schedule, friction screen, alternative text, breath window),
 *    because it rebuilt the whole settings object from the worker's snapshot.
 * 2. One blocked navigation was counted once per listener, so "distractions
 *    blocked today" grew two or three at a time.
 * 3. A site you switched off was reported as "untracked", which the content
 *    script read as "nothing to draw" — so the on-page chip vanished entirely
 *    instead of saying the site was switched off.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Engine = require('../extension/shared/engine.js');
const Config = require('../extension/shared/config.js');

const EXT = path.join(__dirname, '..', 'extension');
const POPUP = fs.readFileSync(path.join(EXT, 'popup', 'popup.js'), 'utf8');
const CONTENT = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
const WORKER = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');

const T0 = new Date(2026, 10, 6, 10, 0, 0).getTime();

function setup(mutate) {
  const cfg = Config.defaultSettings();
  cfg.intervention.enabled = false;
  if (mutate) mutate(cfg);
  return { cfg, state: Engine.emptyState(T0) };
}

/* ------------------------------------------------------------------ */
/* 1. the popup must not save settings it does not own                 */
/* ------------------------------------------------------------------ */

test('the popup layers its one switch over the full settings object', () => {
  const fn = POPUP.slice(POPUP.indexOf('function settingsFromStatus'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /status\.settings/, 'uses the full settings from the snapshot');
  assert.match(body, /Config\.mergeEdits\(/, 'merges instead of rebuilding');
  assert.match(body, /enabled: el\.master\.checked/, 'and overrides only the switch it owns');
});

test('mergeEdits keeps everything it is not told to change', () => {
  const base = Config.defaultSettings();
  base.schedule = {
    enabled: true,
    pausable: true,
    blocks: [{ id: 'b1', label: 'Work', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', enabled: true }],
  };
  base.intervention = Object.assign({}, base.intervention, {
    type: 'intention', durationSeconds: 25, alternative: 'Go for a walk', breatheMinutes: 9,
  });

  const merged = Config.mergeEdits(base, { enabled: false });
  assert.equal(merged.enabled, false, 'the edit applied');
  assert.equal(merged.schedule.enabled, true, 'the schedule is untouched');
  assert.deepEqual(merged.schedule.blocks, base.schedule.blocks);
  assert.equal(merged.intervention.type, 'intention', 'the friction screen is untouched');
  assert.equal(merged.intervention.durationSeconds, 25);
  assert.equal(merged.intervention.alternative, 'Go for a walk');
  assert.equal(merged.intervention.breatheMinutes, 9);

  // and it must not mutate the caller's object
  assert.equal(base.enabled, true, 'the original is left alone');
  // nested patches merge rather than replace
  const nested = Config.mergeEdits(base, { intervention: { enabled: false } });
  assert.equal(nested.intervention.enabled, false);
  assert.equal(nested.intervention.type, 'intention', 'siblings survive a nested edit');
  // and garbage in does not throw
  assert.ok(Config.mergeEdits(null, { enabled: false }));
});

test('restoring saved state keeps the day keys that drive the daily reset', () => {
  // normalizeState() ran every field through a numeric coercion, including the
  // "2026-11-06" day keys, which became 0. rollDay() then thought every load
  // was a new day and wiped the counters on each worker restart.
  const { cfg, state } = setup();
  Engine.evaluateNavigation(state, cfg, 'youtube.com', 1, T0);
  Engine.endVisit(state, cfg, Engine.findSite(cfg, 'youtube.com'), T0 + 60000, Engine.REASONS.CLOSED);
  Engine.evaluateNavigation(state, cfg, 'youtube.com', 2, T0 + 61000);
  Engine.startPause(state, cfg, 5, T0 + 70000);

  const restored = Engine.normalizeState(JSON.parse(JSON.stringify(state)), T0 + 80000);
  assert.equal(restored.stats.day, state.stats.day, 'the stats day survives');
  assert.equal(restored.pause.day, state.pause.day, 'the pause day survives');
  assert.ok(restored.stats.blocked > 0, 'and the counters are not wiped');
  assert.ok(restored.pause.usedToday > 0, 'including the pauses you have spent');

  // Rolling the day forward must still reset, exactly once.
  const tomorrow = new Date(2026, 10, 7, 0, 30, 0).getTime();
  Engine.rollDay(restored, tomorrow);
  assert.equal(restored.stats.blocked, 0, 'a real new day resets');
  assert.equal(restored.pause.usedToday, 0);
});

test('saving the popup switch preserves schedule and friction', () => {
  // Simulate the save path the popup now takes: full settings, one field changed.
  const base = Config.defaultSettings();
  base.schedule = {
    enabled: true,
    pausable: true,
    blocks: [{ id: 'b1', label: 'Work', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', enabled: true }],
  };
  base.intervention = Object.assign({}, base.intervention, {
    type: 'intention', durationSeconds: 25, alternative: 'Go for a walk', breatheMinutes: 9,
  });

  const copy = JSON.parse(JSON.stringify(base));
  copy.enabled = false;
  const saved = Config.normalizeSettings(copy);

  assert.equal(saved.enabled, false, 'the switch applied');
  assert.equal(saved.schedule.enabled, true, 'the schedule survived');
  assert.equal(saved.schedule.blocks.length, 1);
  assert.equal(saved.intervention.type, 'intention', 'the friction screen survived');
  assert.equal(saved.intervention.durationSeconds, 25);
  assert.equal(saved.intervention.alternative, 'Go for a walk');
  assert.equal(saved.intervention.breatheMinutes, 9);
});

/* ------------------------------------------------------------------ */
/* 2. one blocked navigation, one count                                */
/* ------------------------------------------------------------------ */

test('evaluating the same block repeatedly only counts it once', () => {
  const { cfg, state } = setup();
  const site = state.sites['youtube.com'] || Engine.getSiteState(state, 'youtube.com', T0);
  assert.ok(site);

  Engine.evaluateNavigation(state, cfg, 'youtube.com', 1, T0); // starts the visit
  // put it in a cooldown
  Engine.endVisit(state, cfg, Engine.findSite(cfg, 'youtube.com'), T0 + 60000, Engine.REASONS.CLOSED);
  const afterCooldown = state.stats.blocked;

  // Chrome fires several listeners a few milliseconds apart for one navigation
  for (const dt of [0, 5, 40, 300]) {
    const d = Engine.evaluateNavigation(state, cfg, 'youtube.com', 2, T0 + 61000 + dt);
    assert.equal(d.action, 'block');
  }
  assert.equal(state.stats.blocked, afterCooldown + 1, 'counted once, not four times');
  assert.equal(state.sites['youtube.com'].blocked, 1);
});

test('a genuinely new block later on is counted again', () => {
  const { cfg, state } = setup();
  Engine.evaluateNavigation(state, cfg, 'youtube.com', 1, T0);
  Engine.endVisit(state, cfg, Engine.findSite(cfg, 'youtube.com'), T0 + 60000, Engine.REASONS.CLOSED);
  Engine.evaluateNavigation(state, cfg, 'youtube.com', 2, T0 + 61000);
  const first = state.stats.blocked;
  assert.equal(first, 1);

  // two minutes later, the same lockout is still a fresh refusal
  Engine.evaluateNavigation(state, cfg, 'youtube.com', 3, T0 + 61000 + 2 * 60000);
  assert.equal(state.stats.blocked, 2, 'a later attempt counts again');
});

test('the de-dupe key is persisted so a worker restart cannot double count', () => {
  const { cfg, state } = setup();
  Engine.evaluateNavigation(state, cfg, 'youtube.com', 1, T0);
  Engine.endVisit(state, cfg, Engine.findSite(cfg, 'youtube.com'), T0 + 60000, Engine.REASONS.CLOSED);
  Engine.evaluateNavigation(state, cfg, 'youtube.com', 2, T0 + 61000);
  const counted = state.stats.blocked;

  const restored = Engine.normalizeState(JSON.parse(JSON.stringify(state)), T0 + 62000);
  assert.ok(restored.sites['youtube.com'].lastBlockAt > 0, 'the timestamp survives');
  Engine.evaluateNavigation(restored, cfg, 'youtube.com', 3, T0 + 62000);
  assert.equal(restored.stats.blocked, counted, 'still one block after a restart');
});

/* ------------------------------------------------------------------ */
/* 3. a switched-off site says so, instead of going silent             */
/* ------------------------------------------------------------------ */

test('a site you switched off is reported as disabled and still names itself', () => {
  const { cfg, state } = setup((c) => {
    c.sites = c.sites.map((s) => (s.pattern === 'youtube.com' ? Object.assign({}, s, { enabled: false }) : s));
  });
  const decision = Engine.evaluateNavigation(state, cfg, 'youtube.com', 1, T0);
  assert.equal(decision.action, 'allow', 'nothing is enforced');
  assert.equal(decision.reason, Engine.REASONS.DISABLED, 'and it says why');
  assert.equal(decision.site, 'youtube.com', 'so the chip can name it');
});

test('a host we do not track is still plain untracked', () => {
  const { cfg, state } = setup();
  const decision = Engine.evaluateNavigation(state, cfg, 'news.ycombinator.com', 1, T0);
  assert.equal(decision.reason, Engine.REASONS.UNTRACKED);
  assert.equal(decision.site, undefined, 'no site to name');
});

test('the worker sends disabled sites a verdict instead of nothing', () => {
  assert.match(WORKER, /reason: !site \? 'untracked' : 'disabled'/, 'the hello branch names the difference');
  assert.match(WORKER, /siteCfg: site \|\| null/, 'and carries the site so the chip can draw');
});

test('the content script draws a stand-down chip for switched-off sites', () => {
  assert.match(CONTENT, /standDown = msg\.reason === 'disabled'/, 'it notices the reason');
  assert.match(CONTENT, /Switched off for this site/, 'and says so in plain words');
});
