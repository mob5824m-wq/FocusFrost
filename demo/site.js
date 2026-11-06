/** FocusFrost sandbox: the stand-in page's own setup.
 *
 * Kept in its own file rather than inline in site.html so the demo also works
 * under a `script-src 'self'` policy (which is what the extension pages run).
 */
(function () {
  var params = new URLSearchParams(window.location.search);
  var host = params.get('host') || 'example.com';
  var tabId = Number(params.get('tab')) || null;
  window.__FF_TAB_ID = tabId;
  document.documentElement.dataset.ffTop = 'true';

  // The sandbox owns focus: there is no real browser chrome around this.
  window.__FF_DEMO_FOCUS = true;
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: function () { return !!window.__FF_DEMO_FOCUS; } });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return window.__FF_DEMO_FOCUS ? 'visible' : 'hidden'; } });

  var brandColors = {
    'youtube.com': '#e0483c', 'instagram.com': '#c13584', 'tiktok.com': '#111827',
    'x.com': '#111827', 'reddit.com': '#ff4500', 'facebook.com': '#1877f2',
    'twitch.tv': '#9146ff', 'netflix.com': '#e50914', 'discord.com': '#5865f2',
    'snapchat.com': '#fffc00', 'pinterest.com': '#e60023', 'tumblr.com': '#36465d',
    'wikipedia.org': '#1c4b8c'
  };
  var base = host.split('.').slice(-2).join('.');
  var brand = brandColors[base] || '#3f5a86';
  var pretty = (host.split('.').slice(0, -1).join('.') || host).replace(/[-_]/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });

  document.documentElement.style.setProperty('--brand', brand);
  document.getElementById('logo').textContent = (pretty[0] || '?').toUpperCase();
  document.getElementById('name').textContent = pretty;
  document.getElementById('host').textContent = host;

  var side = document.getElementById('side');
  ['Home', 'Explore', 'Following', 'Saved', 'Messages', 'Settings'].forEach(function (label) {
    var div = document.createElement('div');
    div.className = 'nav-item';
    div.innerHTML = '<span class="dot"></span>' + label;
    side.appendChild(div);
  });

  var feed = document.getElementById('feed');
  for (var i = 0; i < 3; i++) {
    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<div class="card-head"><div class="avatar"></div>' +
      '<div style="display:flex;flex-direction:column;gap:6px;flex:1">' +
      '<div class="sk w40"></div><div class="sk w60"></div></div></div>' +
      (i === 0 ? '<div class="thumb"></div>' : '') +
      '<div class="card-body"><div class="sk w80"></div><div class="sk w60"></div><div class="sk w40"></div></div>';
    feed.appendChild(card);
  }

  // Build a chrome.* that proxies to the sandbox top window, then load the
  // REAL content script, exactly as the manifest would inject it.
  function boot() {
    window.chrome = window.parent.__FF_TAB_CHROME__(tabId);
    var s = document.createElement('script');
    s.src = '/extension/content.js';
    document.documentElement.appendChild(s);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
