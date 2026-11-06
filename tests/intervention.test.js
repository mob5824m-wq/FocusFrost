/* FocusFrost — the one-sec half: interventions, focus hours, intentions. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const Config = require(path.join(__dirname, '../extension/shared/config.js'));
const Engine = require(path.join(__dirname, '../extension/shared/engine.js'));

// Monday 6 Nov 2026, 10:00 local.
const MON_10AM = new Date(2026, 10, 2, 10, 0, 0).getTime();

function setup(overrides) {
  const cfg = Config.normalizeSettings(
    Object.assign(
      {
        sites: [
          {
            id: 's1',
            pattern: 'youtube.com',
            label: 'YouTube',
            enabled: true,
            cooldownSeconds: 600,
            graceSeconds: 20,
            maxSessionSeconds: 300,
          },
        ],
        pause: { holdMs: 6000, presets: [5, 15, 30], maxPerDay: 2, minGapMinutes: 30, strict: true },
        intervention: { enabled: true, type: 'breath', durationSeconds: 10 },
      },
      overrides || {}
    )
  );
  return { cfg, state: Engine.emptyState(MON_10AM) };
}

const nav = (ctx, at, tabId, opts) =>
  Engine.evaluateNavigation(ctx.state, ctx.cfg, 'youtube.com', tabId === undefined ? 7 : tabId, at, opts);

/* ================================================================== */
/* interventions                                                       */
/* ================================================================== */

test('an intervention stands between you and the page', () => {
  const ctx = setup();
  const first = nav(ctx, MON_10AM);
  assert.equal(first.action, 'intervene');
  assert.equal(first.reason, Engine.REASONS.INTERVENE);
  assert.equal(first.intervention.type, 'breath');
  assert.equal(first.intervention.durationSeconds, 10);
  // No session yet: the visit has not really started.
  const site = ctx.state.sites['youtube.com'];
  assert.ok(!site || site.session === null, 'no session until the gate is cleared');
});

test('clearing the intervention opens the visit and starts the clock', () => {
  const ctx = setup();
  nav(ctx, MON_10AM);
  const passed = Engine.evaluateNavigation(ctx.state, ctx.cfg, 'youtube.com', 7, MON_10AM + 12000, {
    skipIntervention: true,
  });
  assert.equal(passed.action, 'allow');
  assert.equal(passed.reason, 'started');
  assert.equal(passed.session.inGrace, true);
  assert.equal(passed.session.graceEndsAt, MON_10AM + 12000 + 20000);
});

test('turning interventions off goes straight to the grace window', () => {
  const ctx = setup({ intervention: { enabled: false } });
  const first = nav(ctx, MON_10AM);
  assert.equal(first.action, 'allow');
  assert.equal(first.reason, 'started');
});

test('a cooldown outranks the intervention screen', () => {
  const ctx = setup();
  nav(ctx, MON_10AM);
  Engine.evaluateNavigation(ctx.state, ctx.cfg, 'youtube.com', 7, MON_10AM + 1000, { skipIntervention: true });
  Engine.recordLeave(ctx.state, ctx.cfg, 'youtube.com', MON_10AM + 40000);

  const blocked = nav(ctx, MON_10AM + 41000);
  assert.equal(blocked.action, 'block');
  assert.equal(blocked.reason, 'cooldown');
});

test('a pause outranks the intervention too', () => {
  const ctx = setup();
  Engine.startPause(ctx.state, ctx.cfg, 5, MON_10AM);
  const res = nav(ctx, MON_10AM + 1000);
  assert.equal(res.action, 'allow');
  assert.equal(res.reason, Engine.REASONS.PAUSED);
});

test('intentions and walk-aways are recorded, and counted for the day', () => {
  const ctx = setup({ intervention: { enabled: true, type: 'reflect', requireIntention: true } });
  const site = ctx.cfg.sites[0];

  Engine.recordIntervention(ctx.state, ctx.cfg, site, MON_10AM, 'continue', {
    intention: 'find the CSS grid tutorial and leave',
  });
  Engine.recordIntervention(ctx.state, ctx.cfg, site, MON_10AM + 1000, 'continue', {
    intention: 'reply to Sam',
  });
  Engine.recordIntervention(ctx.state, ctx.cfg, site, MON_10AM + 2000, 'close', {});

  assert.equal(ctx.state.stats.interventions, 3);
  assert.equal(ctx.state.stats.turnedAway, 1);
  assert.equal(ctx.state.stats.intentions, 2);

  const intentions = Engine.logSince(ctx.state, MON_10AM, ['intention']);
  assert.equal(intentions.length, 2);
  assert.equal(intentions[0].text, 'reply to Sam', 'newest first');
  assert.equal(intentions[0].site, 'youtube.com');
});

test('the log is capped and refuses to grow forever', () => {
  const ctx = setup();
  const site = ctx.cfg.sites[0];
  for (let i = 0; i < 200; i++) {
    Engine.logEvent(ctx.state, { at: MON_10AM + i, kind: 'visit', site: 'youtube.com' });
  }
  assert.equal(ctx.state.log.length, 60);
});

test('the re-intervention brake fires after a set amount of focused time', () => {
  const ctx = setup({ intervention: { enabled: true, type: 'breath', reinterveneSeconds: 60 } });
  const started = Engine.evaluateNavigation(ctx.state, ctx.cfg, 'youtube.com', 7, MON_10AM, {
    skipIntervention: true,
  });
  assert.equal(started.action, 'allow');

  let at = MON_10AM;
  let seen = null;
  for (let i = 0; i < 70; i++) {
    at += 1000;
    const res = Engine.heartbeat(ctx.state, ctx.cfg, 'youtube.com', 7, at, true);
    if (res.action === 'intervene') {
      seen = res;
      break;
    }
  }
  assert.ok(seen, 'the second look happened');
  assert.equal(seen.reintervention, true);
  assert.equal(seen.reason, Engine.REASONS.REINTERVENE);
  assert.ok(at - MON_10AM >= 60000);
});

/* ================================================================== */
/* focus hours                                                         */
/* ================================================================== */

function scheduleCfg(blocks, opts) {
  return setup(
    Object.assign(
      {
        intervention: { enabled: false },
        schedule: Object.assign({ enabled: true, pausable: false, blocks }, opts || {}),
      },
      {}
    )
  );
}

test('a focus window blocks the site outright, with no grace', () => {
  const ctx = scheduleCfg([{ id: 'b1', label: 'Deep work', days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' }]);
  const res = nav(ctx, MON_10AM);
  assert.equal(res.action, 'block');
  assert.equal(res.reason, Engine.REASONS.SCHEDULE);
  assert.equal(res.blockLabel, 'Deep work');
  assert.equal(res.until, new Date(2026, 10, 2, 12, 0, 0).getTime());
});

test('outside the window the normal rules apply again', () => {
  const ctx = scheduleCfg([{ id: 'b1', label: 'Deep work', days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' }]);
  const afternoon = new Date(2026, 10, 2, 15, 0, 0).getTime();
  assert.equal(nav(ctx, afternoon).action, 'allow');

  // ...and the next window is reported so the UI can warn you.
  const status = Engine.scheduleStatus(ctx.cfg, afternoon);
  assert.equal(status.active, false);
  assert.equal(status.nextStart, new Date(2026, 10, 3, 9, 0, 0).getTime());
  assert.equal(status.nextBlock.label, 'Deep work');
});

test('a window that runs past midnight covers the small hours', () => {
  const ctx = scheduleCfg([{ id: 'b1', label: 'Wind down', days: [0, 1, 2, 3, 4, 5, 6], start: '21:00', end: '07:00' }]);
  const mondayLate = new Date(2026, 10, 2, 23, 30, 0).getTime();
  const tuesdayEarly = new Date(2026, 10, 3, 6, 30, 0).getTime();
  const tuesdayMidday = new Date(2026, 10, 3, 12, 0, 0).getTime();

  assert.equal(Engine.scheduleStatus(ctx.cfg, mondayLate).active, true);
  assert.equal(Engine.scheduleStatus(ctx.cfg, tuesdayEarly).active, true);
  assert.equal(Engine.scheduleStatus(ctx.cfg, tuesdayMidday).active, false);
  assert.equal(
    Engine.scheduleStatus(ctx.cfg, mondayLate).endsAt,
    new Date(2026, 10, 3, 7, 0, 0).getTime()
  );
});

test('the day list is respected', () => {
  const ctx = scheduleCfg([{ id: 'b1', label: 'Weekdays', days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' }]);
  const saturday10am = new Date(2026, 10, 7, 10, 0, 0).getTime();
  assert.equal(Engine.scheduleStatus(ctx.cfg, saturday10am).active, false);
});

test('a pause only punches through focus hours when allowed', () => {
  const strict = scheduleCfg([{ id: 'b1', label: 'Deep work', days: [1], start: '09:00', end: '12:00' }], { pausable: false });
  Engine.startPause(strict.state, strict.cfg, 5, MON_10AM);
  assert.equal(nav(strict, MON_10AM + 1000).reason, Engine.REASONS.SCHEDULE);

  const soft = scheduleCfg([{ id: 'b1', label: 'Deep work', days: [1], start: '09:00', end: '12:00' }], { pausable: true });
  Engine.startPause(soft.state, soft.cfg, 5, MON_10AM);
  assert.equal(nav(soft, MON_10AM + 1000).action, 'allow');
});

test('focus hours interrupt a visit that is already running', () => {
  const ctx = setup({ intervention: { enabled: false } });
  const started = nav(ctx, MON_10AM);
  assert.equal(started.action, 'allow');

  // A window opens right now.
  ctx.cfg.schedule = {
    enabled: true,
    pausable: false,
    blocks: [{ id: 'b2', label: 'Now', days: [1], start: '09:30', end: '10:30', enabled: true }],
  };
  const tick = Engine.heartbeat(ctx.state, ctx.cfg, 'youtube.com', 7, MON_10AM + 2000, true);
  assert.equal(tick.action, 'block');
  assert.equal(tick.reason, Engine.REASONS.SCHEDULE);
});

/* ================================================================== */
/* settings normalisation                                              */
/* ================================================================== */

test('intervention settings are clamped and validated', () => {
  const cfg = Config.normalizeSettings({
    sites: [],
    intervention: { type: 'nonsense', durationSeconds: 9999, reinterveneSeconds: -4, alternative: 'x'.repeat(500) },
    schedule: {
      enabled: true,
      blocks: [
        { start: '09:00', end: '12:00', days: [1, 1, 2, 99] },
        { start: '25:00', end: '12:00' },
        { start: '10:00', end: '10:00' },
        'garbage',
      ],
    },
  });
  assert.equal(cfg.intervention.type, 'breath', 'unknown type falls back');
  assert.equal(cfg.intervention.durationSeconds, 120, 'clamped to the max');
  assert.equal(cfg.intervention.reinterveneSeconds, 0);
  assert.equal(cfg.intervention.alternative.length, 240);
  assert.equal(cfg.schedule.blocks.length, 1, 'invalid windows are dropped');
  assert.deepEqual(cfg.schedule.blocks[0].days, [1, 2]);
  assert.equal(cfg.schedule.enabled, true);
});

test('a schedule with no valid blocks is switched off', () => {
  const cfg = Config.normalizeSettings({ sites: [], schedule: { enabled: true, blocks: [] } });
  assert.equal(cfg.schedule.enabled, false);
});

test('the snapshot carries intervention, schedule, intentions and the log', () => {
  const ctx = setup({ intervention: { enabled: true, type: 'intention', requireIntention: true } });
  Engine.recordIntervention(ctx.state, ctx.cfg, ctx.cfg.sites[0], MON_10AM, 'continue', { intention: 'check messages' });
  const snap = Engine.snapshot(ctx.state, ctx.cfg, MON_10AM + 1000);
  assert.equal(snap.intervention.type, 'intention');
  assert.equal(snap.stats.intentions, 1);
  assert.equal(snap.intentions.length, 1);
  assert.equal(snap.intentions[0].text, 'check messages');
  assert.equal(snap.schedule.enabled, false);
  assert.ok(Array.isArray(snap.log));
});

test('stored logs survive a round trip through normalizeState', () => {
  const ctx = setup();
  Engine.logEvent(ctx.state, { at: MON_10AM, kind: 'intention', site: 'youtube.com', text: 'write the doc' });
  const copy = Engine.normalizeState(JSON.parse(JSON.stringify(ctx.state)), MON_10AM);
  assert.equal(copy.log.length, 1);
  assert.equal(copy.log[0].text, 'write the doc');
  assert.equal(copy.stats.intentions, 0);
});

test('rubbish in the log does not break anything', () => {
  const state = Engine.normalizeState(
    { log: [null, 'x', { at: 'nope' }, { at: MON_10AM, kind: 'intention', text: 42, site: 'not a domain' }] },
    MON_10AM
  );
  assert.equal(state.log.length, 1);
  assert.equal(state.log[0].text, '42');
  assert.equal(state.log[0].site, '');
});
