/**
 * Tests for the release tooling: the version is stated in more than one place,
 * and the packaged zip is what users actually install. Both are easy to get
 * subtly wrong and impossible to notice until a release is broken.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const VERSION_TOOL = path.join(ROOT, 'tools', 'version.js');
const PACKAGE_TOOL = path.join(ROOT, 'tools', 'package.js');

const { buildZip, validate } = require(PACKAGE_TOOL);

function run(script, args, cwd = ROOT) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
  }
}

/* ------------------------------------------------------------------ */
/* version                                                             */
/* ------------------------------------------------------------------ */

test('the version is consistent everywhere it is written down', () => {
  const res = run(VERSION_TOOL, ['--check']);
  assert.equal(res.code, 0, res.stdout + (res.stderr || ''));
  assert.match(res.stdout, /consistent/);
});

test('printing the version is machine-clean', () => {
  const res = run(VERSION_TOOL, []);
  assert.equal(res.code, 0);
  // Used as $(node tools/version.js) in the release workflow: one semver, no prose.
  assert.match(res.stdout, /^\d+\.\d+\.\d+\n$/);
});

test('manifest and package.json agree', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, pkg.version);
  // Chrome is strict about the version format.
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('bumping moves both files together', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-version-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  fs.cpSync(path.join(ROOT, 'tools'), path.join(tmp, 'tools'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'extension'), path.join(tmp, 'extension'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(tmp, 'package.json'));

  const before = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')).version;
  const res = run(path.join(tmp, 'tools', 'version.js'), ['patch'], tmp);
  assert.equal(res.code, 0, res.stderr);

  const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'extension', 'manifest.json'), 'utf8'));
  assert.equal(pkg.version, manifest.version);
  assert.notEqual(pkg.version, before);
  assert.equal(run(path.join(tmp, 'tools', 'version.js'), ['--check'], tmp).code, 0);
});

test('a version Chrome would reject is refused', () => {
  for (const bad of ['1.2.3-beta.1', '1.2.3+build', 'v1.2.3', '1.2', '1.2.3.4.5']) {
    const res = run(VERSION_TOOL, [bad]);
    assert.notEqual(res.code, 0, `${bad} should be rejected`);
  }
});

/* ------------------------------------------------------------------ */
/* packaging                                                           */
/* ------------------------------------------------------------------ */

test('the real manifest and every page it references validate', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  assert.deepEqual(validate(manifest), []);
});

test('the zip is a valid archive with the manifest at its root', () => {
  const manifest = fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8');
  const files = [{ name: 'manifest.json', data: Buffer.from(manifest) }];
  const zip = buildZip(files, new Date(Date.UTC(2024, 0, 1)));

  // Local file header signature, then the end-of-central-directory at the tail.
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);

  // One entry, and the name is stored raw (no directory prefix: Chrome loads
  // the archive contents, not a nested folder).
  assert.equal(zip.readUInt16LE(zip.length - 12), 1);
  assert.ok(zip.includes(Buffer.from('manifest.json')));
});

test('the same input always produces the same bytes', () => {
  // Reproducibility is what makes the published checksum meaningful.
  const files = [
    { name: 'a.js', data: Buffer.from('console.log(1);\n') },
    { name: 'b.css', data: Buffer.from('body{}\n') },
  ];
  const stamp = new Date(Date.UTC(2024, 5, 1, 12, 0, 0));
  const first = buildZip(files, stamp);
  const second = buildZip(files, stamp);
  assert.ok(first.equals(second));
});

test('compressible content is actually deflated', () => {
  const body = Buffer.from('a'.repeat(5000));
  const zip = buildZip([{ name: 'big.js', data: body }], new Date(Date.UTC(2024, 0, 1)));
  assert.ok(zip.length < body.length / 4, `zip was ${zip.length} bytes`);

  // The stored stream round-trips back to the original bytes.
  const nameLen = zip.readUInt16LE(26);
  const method = zip.readUInt16LE(8);
  const compressedSize = zip.readUInt32LE(18);
  assert.equal(method, 8);
  const start = 30 + nameLen;
  const raw = zlib.inflateRawSync(zip.subarray(start, start + compressedSize));
  assert.equal(raw.toString(), body.toString());
});

test('packaging refuses a broken tree instead of shipping it', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-package-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  fs.cpSync(path.join(ROOT, 'tools'), path.join(tmp, 'tools'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'extension'), path.join(tmp, 'extension'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(tmp, 'package.json'));

  // A page pointing at a file that does not exist.
  const page = path.join(tmp, 'extension', 'blocked', 'blocked.html');
  fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('blocked.js', 'gone.js'));

  const res = run(path.join(tmp, 'tools', 'package.js'), [], tmp);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr || res.stdout, /missing file/);
});

test('an explicit output path is honoured', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-out-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // Run from a copy so the test never reads or writes the repo's dist/.
  fs.cpSync(path.join(ROOT, 'tools'), path.join(tmp, 'tools'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'extension'), path.join(tmp, 'extension'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(tmp, 'package.json'));

  const out = path.join(tmp, 'custom-name.zip');
  const res = run(path.join(tmp, 'tools', 'package.js'), ['--out', out], tmp);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(fs.existsSync(out));
  assert.ok(!fs.existsSync(path.join(tmp, 'dist')), 'a custom --out must not also write to dist/');
});

test('the default zip name is derived from the manifest version', () => {
  // The release workflow looks for dist/focusfrost-<version>.zip, so the name
  // is part of the contract, not a cosmetic detail.
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  const source = fs.readFileSync(PACKAGE_TOOL, 'utf8');
  assert.match(source, /focusfrost-\$\{manifest\.version\}\.zip/);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});
