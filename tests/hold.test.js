/**
 * The press-and-hold gesture.
 *
 * This is the gesture the whole product rests on: a pause has to cost six
 * seconds of commitment, and "clear everything" on the dashboard has to cost
 * the same. It was previously re-implemented on each page, and the dashboard
 * had no confirmation at all — one click wiped every cooldown, session and
 * running pause, no hold, no prompt. These tests pin the shared controller so
 * that drift cannot happen again, and assert every surface actually uses it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const Hold = require(path.join(EXT, 'shared', 'hold.js'));

/* ------------------------------------------------------------------ */
/* a fake clock + frame queue                                          */
/* ------------------------------------------------------------------ */

function harness(opts = {}) {
  let clock = 1000;
  let queue = [];
  let handle = 1;

  const el = {
    listeners: {},
    style: {},
    classes: new Set(),
    capture: [],
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    fire(type, event) {
      for (const fn of this.listeners[type] || []) fn(event || { button: 0, pointerId: 1 });
    },
    setPointerCapture(id) {
      this.capture.push(id);
    },
    classList: {
      add(c) {
        el.classes.add(c);
      },
      remove(c) {
        el.classes.delete(c);
      },
      contains(c) {
        return el.classes.has(c);
      },
    },
  };
  const fill = { style: {}, classList: el.classList };

  const events = [];
  const hold = Hold.create({
    el,
    fill,
    durationMs: opts.durationMs || 6000,
    canStart: opts.canStart,
    now: () => clock,
    raf: (fn) => {
      const id = handle++;
      queue.push({ id, fn });
      return id;
    },
    cancelFrame: (id) => {
      queue = queue.filter((q) => q.id !== id);
    },
    onStart: () => events.push('start'),
    onCancel: () => events.push('cancel'),
    onComplete: () => events.push('complete'),
    onBlocked: () => events.push('blocked'),
    onTick: (info) => events.push('tick:' + info.secondsLeft),
  });
  hold.attach();

  /** Advance the fake clock and run pending frames, like real frames would. */
  function advance(ms) {
    const end = clock + ms;
    let guard = 0;
    while (queue.length && guard < 10000) {
      guard += 1;
      const next = queue.shift();
      clock = Math.min(end, clock + 16);
      next.fn();
      if (clock >= end) break;
    }
    clock = end;
  }

  return { el, fill, hold, events, advance, get clock() { return clock; } };
}

/* ------------------------------------------------------------------ */
/* the controller itself                                               */
/* ------------------------------------------------------------------ */

test('a full hold completes exactly once, only after the whole duration', () => {
  const h = harness();
  h.el.fire('pointerdown');
  assert.deepEqual(h.events, ['start', 'tick:6']);

  h.advance(5999);
  assert.ok(!h.events.includes('complete'), 'must not fire a millisecond early');

  h.advance(2);
  assert.equal(h.events.filter((e) => e === 'complete').length, 1);
  assert.equal(h.fill.style.width, '100%');
});

test('releasing early aborts and never completes, even much later', () => {
  const h = harness();
  h.el.fire('pointerdown');
  h.advance(3000);
  h.el.fire('pointerup');
  assert.ok(h.events.includes('cancel'));

  h.advance(60000);
  assert.ok(!h.events.includes('complete'), 'a cancelled hold can never complete');
  assert.equal(h.fill.style.width, '0%');
  assert.equal(h.hold.holding(), false);
});

test('every way of letting go cancels: up, leave, cancel, blur', () => {
  // Hard-coded on purpose: iterating CANCEL_EVENTS would make this test pass
  // even if the list lost 'pointerleave', which is exactly the bug that leaves
  // a hold running after the finger has slid off the button.
  for (const required of ['pointerup', 'pointerleave', 'pointercancel']) {
    assert.ok(Hold.CANCEL_EVENTS.includes(required), required + ' must abort a hold');
  }
  for (const type of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) {
    const h = harness();
    h.el.fire('pointerdown');
    h.advance(2000);
    h.el.fire(type);
    h.advance(30000);
    assert.ok(!h.events.includes('complete'), type + ' must abort the hold');
    assert.ok(h.events.includes('cancel'), type + ' should report a cancel');
  }
});

test('a single click cannot complete a hold', () => {
  const h = harness();
  h.el.fire('pointerdown');
  h.el.fire('pointerup');
  h.advance(60000);
  assert.ok(!h.events.includes('complete'));
});

test('right-clicking does not start a hold', () => {
  const h = harness();
  h.el.fire('pointerdown', { button: 2, pointerId: 1 });
  assert.deepEqual(h.events, []);
  assert.equal(h.hold.holding(), false);
});

test('the duration is re-read for every hold, minimum 1s', () => {
  let configured = 6000;
  const h = harness({ durationMs: () => configured });
  assert.equal(h.hold.duration(), 6000);
  configured = 3000;
  assert.equal(h.hold.duration(), 3000, 'a settings change applies without a reload');

  configured = 0;
  assert.equal(h.hold.duration(), 1000, 'never insta-confirm');

  configured = NaN;
  assert.equal(h.hold.duration(), 6000, 'falls back to the default');
});

test('a hold that is not allowed reports blocked instead of starting', () => {
  const h = harness({ canStart: () => false });
  h.el.fire('pointerdown');
  assert.deepEqual(h.events, ['blocked']);
  assert.equal(h.hold.holding(), false);
});

test('holding is not re-entrant and capture is requested on the button', () => {
  const h = harness();
  h.el.fire('pointerdown');
  h.el.fire('pointerdown');
  assert.equal(h.events.filter((e) => e === 'start').length, 1);
  assert.deepEqual(h.el.capture, [1, 1], 'pointer capture keeps pointerup coming if the finger slides');
});

/* ------------------------------------------------------------------ */
/* every surface uses it                                               */
/* ------------------------------------------------------------------ */

const read = (rel) => fs.readFileSync(path.join(EXT, rel), 'utf8');

test('the dashboard has a real hold control for clearing locks', () => {
  const html = read('dashboard/dashboard.html');
  const js = read('dashboard/dashboard.js');

  assert.match(html, /<button\b[^>]*\bhold\b[^>]*>/, 'the page has a hold button');
  assert.match(html, /id="clearAll" class="[^"]*\bhold\b/, 'clear-all is a hold button, not a plain button');
  assert.match(html, /id="clearAllFill"/, 'the fill is exposed for progress');
  assert.match(html, /id="clearAllLabel"/, 'the label explains the gesture');
  assert.match(html, /shared\/hold\.js/, 'the page loads the shared controller');
  assert.match(js, /FFHold\.create\(/, 'the controller is created');
  assert.match(js, /durationMs:[^\n]*holdMs/, 'the hold length comes from settings');
  assert.match(js, /onComplete:\s*async/, 'completion is what clears the locks');
});

test('clearing locks is behind the hold, not behind confirm()', () => {
  const js = read('dashboard/dashboard.js');
  const start = js.indexOf("$('clearAll')");
  assert.ok(start > 0, "the clear-all wiring should exist");
  const wiring = js.slice(start, start + 1400);
  assert.doesNotMatch(js, /confirm\('Clear every cooldown/, 'no browser confirm stand-in');
  assert.doesNotMatch(wiring, /addEventListener\('click'[^)]*clearCooldowns/, 'a click must not clear');
  assert.match(wiring, /clearCooldowns/, 'the hold handler calls clearCooldowns');
  assert.ok(
    wiring.indexOf('FFHold') < wiring.indexOf('clearCooldowns'),
    'the controller is wired before the completion path'
  );
});

test('the popup and the cooling-down page use the same controller', () => {
  for (const rel of ['popup/popup.js', 'blocked/blocked.js']) {
    const js = read(rel);
    assert.match(js, /FFHold\.create\(/, rel + ' should not hand-roll a second hold');
    assert.doesNotMatch(js, /requestAnimationFrame\(step\)|requestAnimationFrame\(tick\)/, rel + ' still has its own frame loop');
  }
  for (const rel of ['popup/popup.html', 'blocked/blocked.html']) {
    assert.match(read(rel), /shared\/hold\.js/, rel + ' must load the controller');
  }
});

test('a status refresh mid-hold cannot disable the held button', () => {
  // The popup renders twice a second. Folding the live hold state into
  // `disabled` drops pointer capture, so on a touch screen the gesture dies
  // halfway through and nothing happens however long you press.
  for (const rel of ['popup/popup.js', 'blocked/blocked.js']) {
    const js = read(rel);
    assert.doesNotMatch(
      js,
      /disabled\s*=\s*[^;\n]*\bholding\b/,
      rel + ' must not disable the button while a hold is running'
    );
  }
  assert.match(read('popup/popup.js'), /hold\.holding\(\)/, 'state is reflected in classes instead');
});

test('the sandbox pause is a hold too, not a one-click button', () => {
  // The sandbox is documentation by demonstration. A one-click pause there
  // teaches a gesture the real product refuses.
  const html = read('dashboard/dashboard.html');
  const js = read('dashboard/dashboard.js');
  assert.doesNotMatch(html, /data-sim="pause"/, 'no click-to-pause in the sandbox');
  assert.match(html, /id="simPause"[^>]*class="[^"]*\bhold\b/, 'the sandbox pause is a hold button');
  const start = js.indexOf('const sandboxPause = FFHold.create(');
  assert.ok(start > 0, 'it is driven by the shared controller');
  assert.match(js.slice(start, start + 600), /durationMs:[^\n]*holdMs/, 'and honours the configured length');
  assert.doesNotMatch(js, /action === 'pause'[^\n]*sim\.pause/, 'a click must not start a pause');
});

test('the dashboard footer reads its version from the manifest', () => {
  // It said "v1.1" while the manifest said 3.0.0. A hardcoded number will always
  // rot, so there is no number in the markup at all.
  const html = read('dashboard/dashboard.html');
  const js = read('dashboard/dashboard.js');
  assert.doesNotMatch(html, /FocusFrost v\d/, 'no version literal in the footer');
  assert.match(html, /id="appVersion"/, 'the footer has a slot for it');
  assert.match(js, /getManifest\(\)\.version/, 'filled from the manifest at runtime');
});
