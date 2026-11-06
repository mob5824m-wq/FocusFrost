/**
 * Content Security Policy guards.
 *
 * Extension pages run under `script-src 'self'` (manifest.json). That blocks
 * inline <script> blocks and inline event handlers with a console error the
 * user actually sees — and hashes cannot whitelist event handlers, so the only
 * fix is not to emit them. These tests fail the build if one creeps back in.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const EXT = path.join(__dirname, '..', 'extension');

/** Every .html and .js file in the shipped extension. */
function shippedFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(html|js)$/.test(entry.name)) out.push(full);
    }
  };
  walk(EXT);
  return out;
}

const rel = (file) => path.relative(EXT, file).split(path.sep).join('/');
const read = (file) => fs.readFileSync(file, 'utf8');

/**
 * Strip comments and (for JS) single-quoted / backtick string literals, so the
 * scan does not trip over documentation that mentions the very thing it bans.
 */
function codeOnly(source, isJs) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  if (isJs) {
    // Template literals and quotes carry the generated markup we *do* care
    // about, so only blank out single-quoted bare words that look like prose.
    out = out.replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => (m.includes('<') ? m : "''"));
  }
  return out;
}

const INLINE_HANDLER = /\son[a-z]+\s*=\s*["']/i;

test('no inline event handlers anywhere in the extension', () => {
  const offenders = [];
  for (const file of shippedFiles()) {
    const source = codeOnly(read(file), file.endsWith('.js'));
    source.split('\n').forEach((line, index) => {
      // Skip the pattern where the attribute is set by the DOM instead.
      if (INLINE_HANDLER.test(line) && !/addEventListener/.test(line)) {
        offenders.push(`${rel(file)}:${index + 1}  ${line.trim().slice(0, 100)}`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'inline on* handlers are blocked by script-src \'self\':\n' + offenders.join('\n'));
});

test('no inline <script> blocks', () => {
  for (const file of shippedFiles()) {
    if (!file.endsWith('.html')) continue;
    const html = read(file);
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].filter(
      (m) => m[1].trim().length > 0
    );
    assert.equal(inline.length, 0, `${rel(file)} has an inline <script> block, which CSP blocks`);
  }
});

test('no eval, new Function, or javascript: URLs', () => {
  for (const file of shippedFiles()) {
    const source = codeOnly(read(file), file.endsWith('.js'));
    assert.ok(!/\bnew Function\s*\(/.test(source), `${rel(file)} uses new Function()`);
    assert.ok(!/\beval\s*\(/.test(source), `${rel(file)} uses eval()`);
    assert.ok(!/javascript:/i.test(source), `${rel(file)} uses a javascript: URL`);
  }
});

test('every script the pages load is a same-extension file', () => {
  for (const file of shippedFiles()) {
    if (!file.endsWith('.html')) continue;
    const html = read(file);
    for (const match of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/gi)) {
      const src = match[1];
      assert.ok(!/^(https?:)?\/\//.test(src), `${rel(file)} loads a remote script: ${src}`);
    }
  }
});

test('the manifest keeps a strict script-src', () => {
  const manifest = JSON.parse(read(path.join(EXT, 'manifest.json')));
  const policy = manifest.content_security_policy && manifest.content_security_policy.extension_pages;
  assert.ok(policy, 'manifest.json should declare extension_pages CSP');
  assert.match(policy, /script-src 'self'/);
  assert.ok(!/unsafe-inline/.test(policy), 'unsafe-inline would undo the point of the CSP');
});

test('favicons use the listener-based helper, not markup', () => {
  const util = require(path.join(EXT, 'shared/util.js'));
  assert.equal(typeof util.favicon, 'function');

  // A missing icon must degrade to the initial without throwing or leaving an
  // error listener attached to a stale node.
  const created = [];
  const parent = {
    classList: { add() {} },
    set textContent(v) {
      created.length = 0;
      this._text = v;
    },
    get textContent() {
      return this._text;
    },
    appendChild(node) {
      created.push(node);
      return node;
    },
    ownerDocument: {
      createElement(tag) {
        return {
          tagName: tag.toUpperCase(),
          listeners: {},
          remove() {
            this.removed = true;
          },
          addEventListener(type, fn) {
            this.listeners[type] = fn;
          },
        };
      },
    },
  };
  util.favicon(parent, 'youtube.com', 'YouTube');
  const [letter, img] = created;
  assert.equal(letter.textContent, 'Y', 'the initial is rendered as the permanent fallback');
  assert.equal(img.tagName, 'IMG');
  assert.match(img.src, /youtube\.com/);
  assert.equal(typeof img.listeners.error, 'function', 'errors are handled with a listener, not an attribute');
});
