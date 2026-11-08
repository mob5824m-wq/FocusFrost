#!/usr/bin/env node
/**
 * FocusFrost sandbox server.
 *
 * Serves the extension's real pages plus demo/ in a normal browser tab so the
 * ruleset can be tried, demoed and screenshotted without installing anything.
 * No dependencies, no build step.
 *
 *   node demo/server.js            # http://localhost:4173
 *   PORT=8080 node demo/server.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

/**
 * URL → file. `/extension/...` is the unpacked extension, everything else is
 * the demo folder, and `/` is the sandbox itself.
 */
function resolvePath(pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') return path.join(ROOT, 'demo', 'sandbox.html');
  if (rel.startsWith('/extension/')) return path.join(ROOT, rel.slice(1));
  if (rel.startsWith('/demo/')) return path.join(ROOT, rel.slice(1));
  // shared scripts are referenced by the harness as /shared/*.js
  if (rel.startsWith('/shared/')) return path.join(ROOT, 'extension', rel.slice(1));
  if (rel === '/background.js') return path.join(ROOT, 'extension', 'background.js');
  if (rel === '/content.js') return path.join(ROOT, 'extension', 'content.js');
  if (rel === '/favicon.ico') return path.join(ROOT, 'extension', 'icons', 'icon32.png');
  return path.join(ROOT, 'demo', rel.slice(1));
}

function safeJoin(file) {
  const rel = path.relative(ROOT, file);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  if (parsed.pathname === '/demo/version.js') {
    // The sandbox fakes chrome.runtime for the real pages; the manifest version
    // is the one thing it can just tell the truth about.
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return res.end('window.__FF_MANIFEST_VERSION__ = ' + JSON.stringify(MANIFEST.version) + ';\n');
  }

  const file = resolvePath(parsed.pathname);

  if (!safeJoin(file)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found: ' + parsed.pathname);
    }
    const ext = path.extname(file).toLowerCase();
    const type = TYPES[ext] || 'application/octet-stream';

    // Extension pages expect a chrome.* API. Inject the demo harness so they
    // run against the sandbox's fake browser instead of crashing.
    const isExtensionPage =
      file.startsWith(path.join(ROOT, 'extension')) && ext === '.html';

    if (isExtensionPage) {
      const html = fs.readFileSync(file, 'utf8');
      // A single external script: extension pages declare `script-src 'self'`,
      // so an inline <script> stub here would be refused by the page's own CSP.
      // preview.js sets window.__FF_DEMO itself.
      const tag = '<script src="/demo/version.js"></script><script src="/demo/preview.js"></script>';
      // It must run *before* the page's own scripts, which expect chrome.* to
      // already exist. Dropping it at the top of <head> guarantees that.
      const injected = /<head[^>]*>/i.test(html)
        ? html.replace(/<head[^>]*>/i, (m) => `${m}\n  ${tag}`)
        : tag + html;
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(injected);
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`FocusFrost sandbox → http://localhost:${PORT}`);
  console.log('  /                     live sandbox (fake browser + real worker)');
  console.log('  /extension/popup/popup.html');
  console.log('  /extension/options/options.html');
  console.log('  /extension/dashboard/dashboard.html');
  console.log('  /extension/blocked/blocked.html');
});
