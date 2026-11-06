/**
 * The on-page chip must stay collapsed once you collapse it.
 *
 * The bug this pins down: pressing – collapsed the pill, but the chip re-rendered
 * on every tick and every repaint, and the worker can re-run this script whenever
 * the service worker restarts. The choice was held in a local variable that got
 * thrown away, so the pill kept coming back. It is now remembered per site.
 *
 * Static checks on the source, because jsdom is a dev-only dependency and the
 * shipped test suite cannot assume it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8');

function body(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' should exist');
  const open = SRC.indexOf('{', start);
  let depth = 0;
  for (let j = open; j < SRC.length; j += 1) {
    if (SRC[j] === '{') depth += 1;
    else if (SRC[j] === '}') {
      depth -= 1;
      if (depth === 0) return SRC.slice(open, j + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name);
}

test('the collapsed state is remembered in storage, not just in a variable', () => {
  assert.match(SRC, /const COLLAPSE_KEY = 'ff_chip_collapsed'/, 'a storage key exists');
  assert.match(body('rememberCollapsed'), /chrome\.storage\.local\.set/, 'writes the choice');
  assert.match(body('loadCollapsed'), /chrome\.storage\.local\.get/, 'reads it back');
  assert.match(SRC, /loadCollapsed\(\);/, 'and does so on boot');
});

test('it is remembered per site, so one site cannot uncollapse another', () => {
  assert.match(body('rememberCollapsed'), /map\[host\] = true/, 'keyed by the page host');
  assert.match(body('loadCollapsed'), /map\[host\] === true/, 'and read back by host');
});

test('pressing – writes the choice down', () => {
  const onMin = SRC.slice(SRC.indexOf("querySelector('.minbtn').addEventListener"));
  const handler = onMin.slice(0, onMin.indexOf('});') + 3);
  assert.match(handler, /collapsed = true/, 'collapses');
  assert.match(handler, /rememberCollapsed\(true\)/, 'and persists it');
});

test('clicking the dot expands it again and records that too', () => {
  const idx = SRC.indexOf("node.addEventListener('click'");
  assert.ok(idx > 0, 'the chip has a click handler');
  const handler = SRC.slice(idx, SRC.indexOf('});', idx));
  assert.match(handler, /collapsed = false/, 'expands');
  assert.match(handler, /rememberCollapsed\(false\)/, 'and persists it');
});

test('a repaint honours the remembered state instead of resetting it', () => {
  assert.match(body('render'), /applyCollapsed\(\)/, 'render re-applies the state');
  assert.match(body('applyCollapsed'), /classList\.toggle\('min', collapsed\)/, 'toggling, never adding blindly');
});

test('a chip host the page wiped out is rebuilt', () => {
  const src = body('buildChip');
  assert.match(src, /isConnected === false/, 'detects a detached host');
  assert.match(src, /chip = null/, 'and drops the stale reference');
});

test('an untracked verdict does not hide the chip', () => {
  // Only an explicit switched-off flag should tear the chip down.
  assert.match(SRC, /if \(msg\.enabled === false\)/, 'explicit false only');
  assert.doesNotMatch(SRC, /if \(!msg\.enabled\)/, 'a missing flag must not count as off');
});
