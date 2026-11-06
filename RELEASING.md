# Releasing FocusFrost

The version lives in exactly one place conceptually (it is written to `package.json`
and `extension/manifest.json`, which must never disagree) and **merging is the
release**. There is no separate "publish" button to forget.

```
  bump (Actions ▸ Version bump)  →  PR "v1.2.0"  →  merge  →  tag + release + zip
```

## Cutting a release

1. Go to **Actions ▸ Version bump ▸ Run workflow**, pick `patch`, `minor` or `major`.
2. The workflow bumps both version files, runs the full test suite, builds the
   zip to prove it packages, and opens a pull request titled `v1.2.0`.
3. Review and **merge it**.

Merging is the whole trigger. The `Release` workflow then:

- sees that the version in the manifest has moved past the last `v*` tag,
- re-runs the tests on `main` (a merge can combine two green branches into a red one),
- builds `dist/focusfrost-1.2.0.zip` and verifies the manifest *inside* the archive
  matches the version being tagged,
- tags the merge commit `v1.2.0` and pushes the tag,
- publishes a GitHub release with the zip, its `.sha256`, and notes generated from
  the commits since the previous tag.

A push to `main` that does **not** change the version is not a release — the
workflow compares against existing tags and exits quietly.

## Doing it locally instead

```bash
npm run version:minor        # or version:patch / version:major
npm test                     # 66 tests
npm run zip                  # → dist/focusfrost-<version>.zip
git commit -am "v$(npm run --silent version)"
```

Chrome rejects semver suffixes (`1.2.3-beta.1`) in `manifest.json`, so pre-release
versions are not a thing here. Mark a release as a pre-release on GitHub instead if
you want to signal it is early.

## What is versioned, and what is not

| Versioned | Not versioned |
| --- | --- |
| `package.json`, `extension/manifest.json` | `dist/` (build output, regenerated) |
| Git tags `vMAJOR.MINOR.PATCH` | zip archives (`*.zip` is ignored) |

`npm run version:check` (run by CI and before every release) fails if the two
version files disagree. `npm run version` prints just the version, so
`$(npm run --silent version)` is safe in scripts.

## The archive

`node tools/package.js` writes a zip with no dependencies and no build step:

- Contents sit at the archive root — Chrome loads the contents, so there is no
  nested folder to trip over.
- Dotfiles (`__MACOSX`, `.DS_Store`) are skipped.
- Before writing anything it validates that every file the manifest references
  exists, **and** that every `<script src>` / `<link href>` in every extension page
  resolves. A typo in a page is caught here rather than by a user.
- Output is reproducible: timestamps come from `SOURCE_DATE_EPOCH` (the release
  workflow sets it to the commit time), so the same commit always yields the same
  bytes and the published checksum means something.

## Republishing

If a release needs new assets without a version bump, run **Actions ▸ Release ▸
Run workflow** with `force` enabled. It re-tags the current commit, rebuilds, and
overwrites the release assets.

## Files

| File | Role |
| --- | --- |
| `tools/version.js` | Reads, sets, bumps and checks the version across files. |
| `tools/package.js` | Validates the extension tree and writes the zip. |
| `tests/release.test.js` | Tests for both of the above. |
| `.github/workflows/ci.yml` | Tests on Node 18/20/22, parse check, package check. |
| `.github/workflows/version-bump.yml` | Manual: bump + PR. |
| `.github/workflows/release.yml` | On merge: tag, build, publish. |
