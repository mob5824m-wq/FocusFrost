#!/usr/bin/env node
/**
 * FocusFrost — one source of truth for the version number.
 *
 * The version has to appear in two places Chrome and npm each insist on, and
 * they must never drift. So `package.json` holds it, and this tool writes it
 * everywhere else.
 *
 *   node tools/version.js              # print the current version (and nothing else)
 *   node tools/version.js 1.2.0        # set it explicitly
 *   node tools/version.js patch|minor|major
 *   node tools/version.js --sync       # re-stamp every file from package.json
 *   node tools/version.js --check      # fail if anything disagrees
 *
 * Printing is deliberately machine-clean: `v=$(node tools/version.js)` works.
 *
 * `--check` is what CI and the release workflow use: a tag that does not match
 * the manifest is a bug, not a release.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');
const MANIFEST = path.join(ROOT, 'extension', 'manifest.json');
const README = path.join(ROOT, 'README.md');

// Chrome's version format: 1-4 dot-separated integers, 0-65535 each.
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  // Match the repo's formatting: 2 spaces, trailing newline.
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function chromeSafe(version) {
  const match = SEMVER.exec(version);
  if (!match) {
    throw new Error(
      `"${version}" is not a Chrome-compatible version. Use MAJOR.MINOR.PATCH with integers ` +
        '(Chrome rejects pre-release and build metadata in manifest.json).'
    );
  }
  for (const part of match.slice(1)) {
    if (Number(part) > 65535) throw new Error(`"${version}" has a component above 65535; Chrome will reject it.`);
  }
  return version;
}

function bump(version, kind) {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`Cannot bump "${version}": expected MAJOR.MINOR.PATCH.`);
  let [, major, minor, patch] = match.map(Number);
  if (kind === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (kind === 'minor') {
    minor += 1;
    patch = 0;
  } else if (kind === 'patch') {
    patch += 1;
  } else {
    throw new Error(`Unknown bump "${kind}". Use major, minor or patch.`);
  }
  return `${major}.${minor}.${patch}`;
}

function currentVersion() {
  return readJson(PKG).version;
}

/**
 * Apply a version to every file that carries one.
 * Returns the list of files actually changed.
 */
function setVersion(version) {
  chromeSafe(version);
  const changed = [];

  const pkg = readJson(PKG);
  if (pkg.version !== version) {
    pkg.version = version;
    writeJson(PKG, pkg);
    changed.push('package.json');
  }

  const manifest = readJson(MANIFEST);
  if (manifest.version !== version) {
    manifest.version = version;
    writeJson(MANIFEST, manifest);
    changed.push('extension/manifest.json');
  }

  // The README quotes the version in a few places; keep them honest.
  if (fs.existsSync(README)) {
    const before = fs.readFileSync(README, 'utf8');
    const after = before
      .replace(/\bFocusFrost v\d+\.\d+\.\d+\b/g, `FocusFrost v${version}`)
      .replace(/\bfocusfrost-\d+\.\d+\.\d+\.zip\b/g, `focusfrost-${version}.zip`);
    if (after !== before) {
      fs.writeFileSync(README, after, 'utf8');
      changed.push('README.md');
    }
  }

  return changed;
}

/** Every place that states a version, for the mismatch report. */
function findAll() {
  const found = [
    { file: 'package.json', version: readJson(PKG).version },
    { file: 'extension/manifest.json', version: readJson(MANIFEST).version },
  ];
  if (fs.existsSync(README)) {
    const readme = fs.readFileSync(README, 'utf8');
    for (const match of readme.matchAll(/\bFocusFrost v(\d+\.\d+\.\d+)\b/g)) {
      found.push({ file: 'README.md', version: match[1] });
    }
  }
  return found;
}

function main(argv) {
  const args = argv.slice(2);

  if (args.includes('--check')) {
    const versions = findAll();
    const unique = [...new Set(versions.map((v) => v.version))];
    if (unique.length === 1) {
      console.log(`version ${unique[0]} — consistent across ${versions.length} references`);
      return 0;
    }
    console.error('Version mismatch:');
    for (const { file, version } of versions) console.error(`  ${file}: ${version}`);
    console.error('\nFix it with: npm run version:set -- <version>');
    return 1;
  }

  if (args.includes('--sync')) {
    const version = currentVersion();
    const changed = setVersion(version);
    console.log(changed.length ? `synced ${version} → ${changed.join(', ')}` : `version ${version} — already in sync`);
    return 0;
  }

  const requested = args.find((a) => !a.startsWith('-'));

  if (!requested) {
    // Bare invocation prints the version and changes nothing, so it is safe to
    // use in scripts and shell substitutions.
    console.log(currentVersion());
    return 0;
  }

  const next = ['major', 'minor', 'patch'].includes(requested)
    ? bump(currentVersion(), requested)
    : requested;

  const changed = setVersion(next);
  console.log(`version ${next}`);
  if (changed.length) console.log(`updated: ${changed.join(', ')}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { setVersion, currentVersion, bump, chromeSafe, findAll };
