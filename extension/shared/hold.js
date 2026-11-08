/**
 * FocusFrost — press-and-hold controller.
 *
 * The whole product leans on one gesture: you must *hold* a button for the
 * configured time before anything happens. It is the difference between a
 * pause being a decision and being a reflex, so it cannot be re-implemented
 * per page and drift. This is the one implementation; popup, cooling-down page
 * and dashboard all drive it.
 *
 * Guarantees (pinned by tests/hold.test.js):
 *   - a hold completes only after the full duration has actually elapsed;
 *   - releasing early, dragging out of the button, or the pointer being
 *     cancelled aborts and leaves nothing behind;
 *   - a single click can never complete a hold;
 *   - the duration is read at the start of every hold, so a settings change
 *     takes effect without a reload.
 *
 * The clock and frame scheduler are injectable so the behaviour can be tested
 * without a browser (see the `now` / `raf` options).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FFHold = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Shorter than this is a click, not a hold. */
  const MIN_MS = 1000;
  const DEFAULT_MS = 6000;

  /** Every event that means "the finger/mouse is no longer committed". */
  const CANCEL_EVENTS = ['pointerup', 'pointerleave', 'pointercancel', 'blur'];

  function create(options) {
    const opts = options || {};
    const el = opts.el;
    if (!el || typeof el.addEventListener !== 'function') {
      throw new TypeError('FFHold.create needs an element');
    }
    const fill = opts.fill || null;

    const now =
      opts.now ||
      (() =>
        typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
    const raf =
      opts.raf ||
      ((fn) =>
        typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));
    const cancelFrame =
      opts.cancelFrame ||
      ((handle) =>
        typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(handle) : clearTimeout(handle));

    let holding = false;
    let startedAt = 0;
    let total = 0;
    let frame = null;

    /** The hold length, read fresh each time so settings changes apply. */
    function duration() {
      const raw = typeof opts.durationMs === 'function' ? opts.durationMs() : opts.durationMs;
      const value = Number(raw);
      return Math.max(MIN_MS, Number.isFinite(value) ? value : DEFAULT_MS);
    }

    function canStart() {
      return typeof opts.canStart === 'function' ? opts.canStart() !== false : true;
    }

    function paint(elapsed, total) {
      const percent = Math.min(100, Math.max(0, (elapsed / total) * 100));
      const secondsLeft = Math.max(0, Math.ceil((total - elapsed) / 1000));
      if (fill) fill.style.width = percent + '%';
      if (typeof opts.onTick === 'function') opts.onTick({ elapsed, total, percent, secondsLeft });
    }

    function stopFrame() {
      if (frame !== null && frame !== undefined) {
        cancelFrame(frame);
        frame = null;
      }
    }

    function start(event) {
      // Right-click (or a middle-click) is not a commitment.
      if (event && typeof event.button === 'number' && event.button !== 0) return false;
      if (holding) return false;
      if (!canStart()) {
        if (typeof opts.onBlocked === 'function') opts.onBlocked();
        return false;
      }

      holding = true;
      startedAt = now();
      // Captured once: the length of *this* hold, not a target that moves
      // under the user's finger.
      total = duration();
      if (fill) fill.classList.remove('done');
      if (typeof opts.onStart === 'function') opts.onStart();
      paint(0, total);

      const step = () => {
        if (!holding) return;
        const elapsed = now() - startedAt;
        paint(elapsed, total);
        if (elapsed >= total) {
          complete();
          return;
        }
        frame = raf(step);
      };
      frame = raf(step);
      return true;
    }

    /** Abort. No completion callback is ever reached from here. */
    function cancel() {
      if (!holding) return false;
      holding = false;
      stopFrame();
      if (fill) {
        fill.style.width = '0%';
        fill.classList.remove('done');
      }
      if (typeof opts.onCancel === 'function') opts.onCancel();
      return true;
    }

    function complete() {
      holding = false;
      stopFrame();
      if (fill) {
        fill.style.width = '100%';
        fill.classList.add('done');
      }
      if (typeof opts.onComplete === 'function') opts.onComplete();
    }

    /** Wire the DOM events. Safe to call once per element. */
    function attach(target) {
      const node = target || el;

      node.addEventListener('pointerdown', (event) => {
        if (node.setPointerCapture && event && event.pointerId != null) {
          // Keep receiving pointerup even if the pointer slides off the button.
          try {
            node.setPointerCapture(event.pointerId);
          } catch (_) {
            /* capture is a nicety, never a requirement */
          }
        }
        start(event);
      });

      for (const type of CANCEL_EVENTS) node.addEventListener(type, () => cancel());

      // A long press on a touch screen must not raise the context menu.
      node.addEventListener('contextmenu', (event) => event.preventDefault());

      // Keyboard parity: space/enter held down is a hold.
      node.addEventListener('keydown', (event) => {
        if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
          event.preventDefault();
          start();
        }
      });
      node.addEventListener('keyup', (event) => {
        if (event.key === ' ' || event.key === 'Enter') cancel();
      });

      return controller;
    }

    const controller = {
      attach,
      start,
      cancel,
      complete,
      duration,
      holding: () => holding,
      isHolding: () => holding,
      /** Reset the visual fill without touching hold state (post-completion). */
      reset() {
        if (fill) {
          fill.style.width = '0%';
          fill.classList.remove('done');
        }
      },
    };

    return controller;
  }

  return { create, CANCEL_EVENTS, DEFAULT_MS, MIN_MS };
});
