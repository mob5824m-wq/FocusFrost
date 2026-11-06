#!/usr/bin/env node
/**
 * FocusFrost — build the shippable extension zip.
 *
 *   node tools/package.js                 # → dist/focusfrost-<version>.zip
 *   node tools/package.js --out some.zip
 *
 * Produces the file a user actually loads via "Load unpacked" (Chrome accepts
 * the unzipped folder too, so the archive is just the folder, no nesting).
 * Fails loudly rather than shipping a broken package.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');

/* ------------------------------------------------------------------ */
/* a tiny zip writer, so the release needs no dependency and no `zip`  */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * Entries are stored deflated. Reproducibility matters for releases: a tag
 * should always produce the same bytes, so timestamps come from SOURCE_DATE_EPOCH
 * (or a fixed fallback) rather than "now".
 */
function buildZip(files, stamp) {
  const { time, day } = dosDateTime(stamp);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, end]);
}

/* ------------------------------------------------------------------ */
/* collect + validate                                                  */
/* ------------------------------------------------------------------ */

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue; // no .DS_Store, no dotfiles
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push({ name: path.relative(base, full).split(path.sep).join('/'), file: full });
  }
  return out;
}

function validate(manifest) {
  const problems = [];
  if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version || '')) problems.push(`bad version "${manifest.version}"`);
  if (!manifest.background || !manifest.background.service_worker) problems.push('no background service worker');
  if (!manifest.action || !manifest.action.default_popup) problems.push('no action popup');

  const referenced = new Set();
  const add = (p) => p && referenced.add(p.replace(/^\//, ''));
  add(manifest.background && manifest.background.service_worker);
  add(manifest.action && manifest.action.default_popup);
  add(manifest.options_ui && manifest.options_ui.page);
  add(manifest.options_page);
  for (const icon of Object.values(manifest.icons || {})) add(icon);
  for (const icon of Object.values((manifest.action && manifest.action.default_icon) || {})) add(icon);
  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) add(file);
    for (const file of script.css || []) add(file);
  }
  for (const war of manifest.web_accessible_resources || []) {
    for (const resource of war.resources || []) {
      if (resource.includes('*')) continue;
      add(resource);
    }
  }

  for (const rel of referenced) {
    if (!fs.existsSync(path.join(EXTENSION, rel))) problems.push(`manifest references a missing file: ${rel}`);
  }

  // Anything the popup/options/blocked pages pull in via <script src>/<link href>
  // must exist too — a typo there is invisible until a user opens the page.
  for (const { name, file } of walk(EXTENSION)) {
    if (!name.endsWith('.html')) continue;
    const html = fs.readFileSync(file, 'utf8');
    for (const match of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
      const target = match[1];
      if (/^(data:|https?:|mailto:)/.test(target)) continue;
      const resolved = path.resolve(path.dirname(file), target);
      if (!fs.existsSync(resolved)) problems.push(`${name} links to a missing file: ${target}`);
    }
  }

  return problems;
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION, 'manifest.json'), 'utf8'));

  const problems = validate(manifest);
  if (problems.length) {
    console.error('Refusing to package:\n' + problems.map((p) => '  - ' + p).join('\n'));
    return 1;
  }

  const outIndex = process.argv.indexOf('--out');
  const outFile =
    outIndex > -1 && process.argv[outIndex + 1]
      ? path.resolve(process.argv[outIndex + 1])
      : path.join(DIST, `focusfrost-${manifest.version}.zip`);

  const stamp = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000)
    : new Date(Date.UTC(2024, 0, 1));

  const files = walk(EXTENSION).map(({ name, file }) => ({ name, data: fs.readFileSync(file) }));
  const zip = buildZip(files, stamp);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, zip);

  const bytes = zip.length;
  console.log(`${path.relative(ROOT, outFile)}  ${(bytes / 1024).toFixed(1)} KiB  ${files.length} files  v${manifest.version}`);
  // Machine-readable line for the release workflow.
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `zip=${outFile}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `bytes=${bytes}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${require('crypto').createHash('sha256').update(zip).digest('hex')}\n`);
  }
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { buildZip, validate };
