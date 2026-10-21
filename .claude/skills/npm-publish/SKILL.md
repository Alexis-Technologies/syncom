---
name: npm-publish
description: Prepare an @alexify package for publishing with pnpm. Handles version bump, CHANGELOG update, typings check, quality gates, README and docs refresh, package.json audit, and pnpm pack verification. Use when the user asks to prepare a release, bump version, publish a package, or do release prep.
---

<!-- Adapted from metaskills v1.0.5 (skills/npm-publish) for syncom: pnpm instead of npm, the gates
     CI runs, Keep a Changelog headings as used in CHANGELOG.md, and the hand-run release
     checklist of CONTRIBUTING.md, which wins if the two ever disagree. -->

# npm Publish Preparation

Systematic workflow for preparing the package for a new release. Every step must pass before proceeding to the next. The package manager is pnpm (pinned in `packageManager`); never create `package-lock.json`. Releases are run by hand on purpose: there is no release workflow and no publish automation, and this skill never publishes.

`@alexify/syncom` has not been published yet (`1.0.0` in `package.json`, no `v*` tags, an `[Unreleased]` section that says so). The first release is the first run of this skill; read the "first release" notes in Steps 2 and 3.

## Step 0: Gather Release Intent

Ask the user (use AskUserQuestion if available):

1. **Version bump type**: patch / minor / major / explicit version / prerelease tag
2. **Prerelease label** (if any): e.g. `alpha`, `beta`, `rc`
3. **Confirm changelog entries**: ask if the `[Unreleased]` section in CHANGELOG is complete, or if the user wants to draft entries from recent commits

If the user already specified intent (e.g. "prepare 0.1.0 release"), skip the question and proceed.

## Step 1: Pre-flight Checks

Run:

```bash
pnpm install --frozen-lockfile   # install deps exactly as locked
pnpm lint                        # oxlint
pnpm format:check                # oxfmt
pnpm test:coverage               # tests under the c8 gate (95 lines / 95 statements / 90 branches / 95 functions)
pnpm test:types                  # tsd against the .d.ts files
pnpm size                        # the bundle report; the browser budget fails the run
pnpm docs:build                  # the docs site; a dead link fails it
```

These are the three CI jobs (lint, test, docs). Do not lower a coverage threshold or raise a size budget to get green; a budget is a ratchet raised deliberately, in the change that earns the bytes, with the reason in a comment next to the number.

Then in parallel: `pnpm outdated` and `pnpm audit` (report to the user; devDependencies only, the package has no runtime dependencies).

If any gate fails, stop and fix issues before continuing.

## Step 2: Version Bump

### Read current version from `package.json`

Compute the new version based on user intent and semver rules:

- **patch**: `1.2.3` → `1.2.4`
- **minor**: `1.2.3` → `1.3.0`
- **major**: `1.2.3` → `2.0.0`
- **prerelease**: `1.2.3` → `1.2.4-<label>.0`, or `1.2.4-beta.0` → `1.2.4-beta.1`
- **Removing prerelease tag**: `4.0.3-prerelease` → `4.0.3` (just strip the suffix)

Update `"version"` in `package.json` with the Edit tool, not `pnpm version`: the bump is a plain edit, and the commit, tag and changelog are handled by hand in the steps below.

Change the nav label in `docs/.vitepress/config.mts` (`text: 'v<version>'`) in the same edit: it is hand-synced and `tests/package/consistency.test.js` fails when the two differ.

**First release:** the user chose `1.0.0`, and `package.json` and the nav label already carry it; confirm it is still the intent. The changelog states that all of `[Unreleased]` lands in it.

## Step 3: Update CHANGELOG.md

The changelog follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/):

- **Sections**: `## [Unreleased]` at top; `## [X.Y.Z] - YYYY-MM-DD` for releases (date in ISO 8601)
- **Order**: newest first; every version gets an entry
- **Types of changes**: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`. Omit empty subsections
- **Entries**: bullets starting with a **bold lead-in**, then the explanation; human-readable and curated (no raw git diffs); call out breaking changes clearly
- **Links**: reference-style link block at the bottom: `[unreleased]: ...`, `[X.Y.Z]: ...`

### 3a: Detect changelog structure

Read the full `CHANGELOG.md`. Identify:

- The `[Unreleased]` section and the note under it that says the package is unpublished
- The previous release heading, if there is one (to derive the comparison base)
- Whether a links block exists at the bottom (it does not yet; the first release adds it)
- The GitHub repo URL from `package.json` `repository`

Release tags are `vX.Y.Z`.

### 3b: Create the new version entry

**Always** draft entries from `git log` since the previous release tag:

```bash
git log $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD --oneline
```

For the first release there is no tag and the range is the whole history.

Commits follow Conventional Commits: map `feat` → Added, `fix` → Fixed, `refactor!`/`feat!`/`fix!` → call out as breaking, `ci`/`chore` → only when user-visible. Merge with the existing `[Unreleased]` content; it is usually already written.

Turn `[Unreleased]` into the release and leave an empty `[Unreleased]` above it:

```markdown
## [Unreleased]

## [NEW_VERSION] - YYYY-MM-DD

### Added

- **Feature name.** What it does and why it matters.
```

On the first release, drop the "has not been published to npm yet" note from the top of the file: it stops being true.

### 3c: Update comparison links

At the bottom of `CHANGELOG.md`, update the `[unreleased]` link and add the new version link:

```markdown
[unreleased]: https://github.com/OWNER/REPO/compare/vNEW_VERSION...HEAD
[NEW_VERSION]: https://github.com/OWNER/REPO/compare/vPREVIOUS_VERSION...vNEW_VERSION
```

For the first release there is no previous version: link it to `https://github.com/OWNER/REPO/releases/tag/vNEW_VERSION`.

Keep all existing links intact.

## Step 4: TypeScript Declarations

The types are hand-written: `index.d.ts` (Node surface), `browser.d.ts` (re-exports `index.d.ts` and overrides the three async crypto functions) and `wrpc.d.ts` (the `./wrpc` subpath):

1. `pnpm test:types` (tsd, `tests/*.test-d.ts`) must pass with no errors
2. Read `src/index.js`, `src/index.browser.js` and `src/wrpc.js` and confirm every exported class, function, type and method is declared, and no private (`#`) or internal fields leak into the declarations
3. Confirm the event maps (`StorageEvents`, `SyncEvents`, `RecordEvents`) and the hook option types match the events and hooks `src/commit.js`, `src/apply.js`, `src/bootstrap.js`, `src/storage.js` and `src/sync.js` actually emit and run
4. If the release includes API changes, update the typings and `tests/*.test-d.ts` accordingly; a `.d.ts` change and its `tsd` test land together

## Step 5: README, Docs & License Review

**Update the year** of the copyright line in `LICENSE` if the release is in a later year than the one it carries.

Scan for staleness:

1. **README.md usage examples**: do they match the current API? Run them if in doubt; the documented outputs must be true
2. **README.md bundle-size table**: refresh it from `pnpm size`
3. **Badges**: do the URLs point to `@alexify/syncom` and the `Alexis-Technologies` repository?
4. **docs/**: guide and reference pages for anything the release changed; `docs/guide/sync.md` and `docs/guide/wrpc.md` must agree with `src/sync.js` and `src/hosting.js`, and `docs/guide/hooks.md` with the hook and event surface of `src/commit.js`, `src/apply.js`, `src/bootstrap.js`, `src/storage.js` and `src/sync.js`. `pnpm docs:build` must pass (dead links fail it)
5. **docs/public/llms.txt**: key facts (exports, Node.js version, size)
6. **docs keywords**: the `const keywords = [...]` block in `docs/.vitepress/config.mts` mirrors `package.json#keywords` (the consistency test checks it)
7. **SECURITY.md**: the supported-versions table, on a major release (or the first one)

Only edit if something is factually wrong or outdated. Don't rewrite style or add unsolicited content.

## Step 6: Package Audit

### 6a: Verify `package.json` fields

Check these fields are correct:

- `"main"` / `"exports"` / `"browser"` — point to existing files; `exports` lists `types` first for `.` (with a `browser` condition resolving to `browser.js` / `browser.d.ts`) and `./wrpc`, and the `browser` map covers the root entry and each `*.browser.js` half
- `"types"` — points to `index.d.ts`
- `"files"` — the explicit allowlist includes everything that ships (`index.js`, `browser.js`, `wrpc.js`, the three `.d.ts`, `src/`, `LICENSE`, `README.md`, `CHANGELOG.md`, `SECURITY.md`) and nothing else
- `"engines"` — `node >=22`, matches the CI matrix (`.github/workflows/ci.yml`)
- `"dependencies"` — absent; the package has no runtime dependencies (`@alexify/wrpc` and `@opentelemetry/*` stay devDependencies)
- `"keywords"` — no typos, relevant terms
- `"license"`, `"repository"`, `"homepage"`, `"bugs"`, `"publishConfig"` (`access: public`) — valid

`tests/package/consistency.test.js` is the machine-checked half of this list. If it goes red after a change to an entry point, update `exports`, `files`, the `browser` map, `scripts/size.js` `ENTRIES` and the docs keywords; the test is right.

### 6b: Dry-run pack

```bash
pnpm pack --dry-run
pnpm size
```

Review the file list:

- Source files (`src/`) and root entry points are included
- Type definitions are included
- Tests, docs, bench, examples, scripts, configs, `.claude/` and CI files are excluded
- No unexpected large files

Then pack for real into a scratch directory and smoke the tarball: `require()` it from a scratch CJS file, and typecheck it with `npx tsc --moduleResolution bundler --module esnext --noEmit`.

Report the file count and the bundle sizes from `pnpm size` to the user.

## Step 7: Final Verification

Run the gates one more time after all edits:

```bash
pnpm lint && pnpm format:check && pnpm test:coverage && pnpm test:types && pnpm size && pnpm docs:build
```

Must exit 0. If it fails, fix and re-run.

## Step 8: Summary & Next Steps

Present a summary to the user:

```
Release preparation complete:
  Package:  <name>
  Version:  <old> → <new>
  Tests:    ✓ passing (coverage gate met)
  Types:    ✓ valid
  Packed:   <N> files, <min+gzip size>
```

Then list remaining manual steps:

1. `git add -A && git commit -m "chore(release): vX.Y.Z"` on the release branch (or ask the user if they want you to commit)
2. Merge the branch into `main`
3. `git tag vX.Y.Z` on the release commit, then `git push origin main && git push origin vX.Y.Z`
4. `pnpm publish` from that commit (for prereleases: `pnpm publish --tag <label>`)
5. Write the GitHub release notes from the changelog section
6. Verify the docs deploy: `curl -o /dev/null -sw '%{http_code}' https://syncomjs.vercel.app/`

Do NOT run `pnpm publish`, `npm publish` or `git push` automatically — always let the user do it or explicitly confirm.

## Step 9: Lockfile

Run `pnpm install` only if dependencies changed during the release; commit the updated `pnpm-lock.yaml` with the release. Never generate or commit `package-lock.json`.
