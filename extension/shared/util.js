/**
 * FocusFrost — shared helpers.
 * Loaded by the service worker (importScripts) and by extension pages (<script>).
 * Also exportable for Node so the logic can be unit tested.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FFUtil = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 0:07, 4:59, 12:00, 1:02:00 */
  function clock(seconds) {
    const s = Math.max(0, Math.ceil(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
    return `${m}:${pad(sec)}`;
  }

  /** Human duration: "45s", "12m", "1h 5m" */
  function humanDuration(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rest = s % 60;
    if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return mm ? `${h}h ${mm}m` : `${h}h`;
  }

  /** Local calendar day key, e.g. "2026-11-06" (used for daily limits). */
  function dayKey(ts) {
    const d = new Date(Number(ts) || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  /** "youtube.com", "https://www.reddit.com/r/all" -> "reddit.com" */
  function normalizeSite(input) {
    let s = String(input == null ? '' : input).trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
    s = s.replace(/^[^@/]*@/, '');                // credentials
    s = s.split('/')[0].split('?')[0].split('#')[0];
    s = s.replace(/:\d+$/, '');                  // port
    s = s.replace(/\.+$/, '.').replace(/\.$/, '');
    s = s.replace(/^www\./, '');
    // Basic sanity: must look like at least one dot with valid characters.
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) {
      return '';
    }
    return s;
  }

  /** Pretty label for a site pattern: "youtube.com" -> "Youtube" */
  function siteLabel(pattern) {
    const base = String(pattern || '').split('.').slice(0, -1).join('.') || pattern || '';
    return base
      .replace(/[-_]+/g, ' ')
      .replace(/\b[a-z]/g, (c) => c.toUpperCase())
      .trim();
  }

  function uid(prefix) {
    return `${prefix || 'id'}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
  }

  /**
   * Fill a `.favicon` element with a site's icon, falling back to its initial.
   *
   * The error is handled with `addEventListener`, never an inline `onerror`:
   * extension pages run under `script-src 'self'`, which blocks inline event
   * handlers outright (and hashes cannot whitelist them — that would need
   * 'unsafe-hashes'). The fallback letter is always rendered underneath, so a
   * missing icon degrades quietly instead of logging a CSP violation.
   */
  function favicon(parent, pattern, label) {
    if (!parent) return null;
    const initial = String(label || pattern || '?').trim().slice(0, 1).toUpperCase() || '?';
    parent.textContent = '';
    const letter = parent.ownerDocument.createElement('span');
    letter.className = 'favicon-letter';
    letter.textContent = initial;
    parent.appendChild(letter);

    const img = parent.ownerDocument.createElement('img');
    img.className = 'favicon-img';
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.remove());
    img.addEventListener('load', () => parent.classList.add('has-icon'));
    img.src = `https://icons.duckduckgo.com/ip3/${encodeURIComponent(pattern)}.ico`;
    parent.appendChild(img);
    return img;
  }

  function plural(n, word, suffix) {
    return `${n} ${word}${n === 1 ? '' : suffix || 's'}`;
  }

  return {
    clock,
    humanDuration,
    dayKey,
    clamp,
    normalizeSite,
    siteLabel,
    uid,
    plural,
    favicon,
  };
});
