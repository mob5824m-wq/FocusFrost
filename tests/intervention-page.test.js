/**
 * The intervention screen must actually let you through.
 *
 * The bug this pins down: every stage hid the footer (`#choices`) while it was
 * on screen, but that footer is where the "Continue to …" button lives. So the
 * button did become enabled once you wrote your sentence — you just could not
 * see it, and the screen looked stuck. These are static checks on the source
 * because jsdom is a dev-only dependency, not something the shipped tests can
 * assume.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'extension', 'intervention');
const JS = fs.readFileSync(path.join(DIR, 'intervention.js'), 'utf8');
const HTML = fs.readFileSync(path.join(DIR, 'intervention.html'), 'utf8');

/** The body of a named function, by brace matching (good enough for this file). */
function body(name) {
  const start = JS.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' should exist');
  let i = JS.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < JS.length; j += 1) {
    if (JS[j] === '{') depth += 1;
    else if (JS[j] === '}') {
      depth -= 1;
      if (depth === 0) return JS.slice(i, j + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name);
}

test('the continue button lives in the footer the stages toggle', () => {
  const footer = HTML.slice(HTML.indexOf('id="choices"'), HTML.indexOf('id="timebox"'));
  assert.match(footer, /id="continueBtn"/, 'continueBtn must be inside #choices');
});

test('the text stages show the footer instead of hiding it', () => {
  for (const fn of ['startReflection', 'startTyping']) {
    const src = body(fn);
    assert.match(src, /showChoices\(true\)/, fn + ' must reveal the footer');
    assert.doesNotMatch(src, /choices\.classList\.add\('hidden'\)/, fn + ' must not hide the footer');
  }
});

test('the breathing stage shows the footer once the breath is done', () => {
  assert.match(body('startBreathing'), /showChoices\(false\)/, 'hidden while breathing');
  assert.match(body('completeBreathing'), /showChoices\(true\)/, 'revealed on completion');
});

test('every stage that hides the footer also has a way to show it again', () => {
  // startBreathing -> completeBreathing is the only hide that is not immediate.
  const hides = (JS.match(/showChoices\(false\)/g) || []).length;
  const shows = (JS.match(/showChoices\(true\)/g) || []).length;
  assert.ok(shows > hides, 'expected more reveals than hides: ' + shows + ' vs ' + hides);
});

test('writing an intention unlocks continue, and the field says what is left', () => {
  const src = body('updateReflectReady');
  assert.match(src, /intention\.value\.trim\(\)/, 'reads the sentence');
  assert.match(src, /unlockContinue\(/, 'unlocks the button');
  assert.match(src, /intentHint\.textContent/, 'explains itself next to the field');
});

test('there is exactly one close-the-tab escape hatch, in the footer', () => {
  const closeButtons = HTML.match(/close this tab/gi) || [];
  assert.equal(closeButtons.length, 1, 'one "close this tab" label: ' + closeButtons.join(', '));
  assert.match(HTML, /id="closeBtn"/);
  assert.doesNotMatch(HTML, /id="reflectDone"/, 'the dead duplicate button is gone');
  assert.doesNotMatch(JS, /reflectDone/, 'and nothing still points at it');
});

test('the settings-page preview cannot grant a pass or navigate', () => {
  assert.match(JS, /params\.get\('preview'\) === '1'/, 'preview mode is detected');
  assert.match(body('continueOn'), /if \(preview\)/, 'continue short-circuits');
  assert.match(body('closeInstead'), /if \(preview\)/, 'close short-circuits');
  assert.match(JS, /nothing was recorded/i, 'and says so on screen');
});
