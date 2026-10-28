# src/versions/CLAUDE.md — Versions and tags

The past folded out of the log, tags copy-on-write, patches. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/versions/history.js  the past out of the log: a version (event id / stamp / vector) as a cut, the exact start above droppedTs, the fold
src/versions/tags.js     Tags — named versions kept locally: tags.json, a catalog per tag, copy-on-write record files in the newest tag
src/versions/versions.js @alexify/syncom/versions — the versions plugin: setup hands the core its Tags (`versions` hook), `methods`
                          are the facade's stubs (getAt, diff, restore, tag, untag, tags, at, history)
src/versions/api.js      the versions API — get(id, { at }), history, diff/restore, tag/untag/at — over the lent core
```

## Rules

- **A version is folded, a fork at one is paged.** `atVersion` in
  src/versions/api.js folds every id the log retains entries for (`log.ids()`)
  and every catalog id through `versionEntry`, and computes the vector at the
  version per stream from the retained entries (a stream with nothing retained
  was dropped whole below the floor — inside the version; one retained only
  past the version is `HISTORY_GONE compacted`); its `snapshot` is `pageOf`
  over a synthetic catalog — never a second page writer. `branch()` takes
  `from: { at }` through it. Blame (src/blame.js, the plugins' `editors`
  hook, the text plugin's `editorOf`) reads the metadata alone: an `origin`
  is a node id, never resolved to a person here.
- **A version is a fold of the retained log, exact only from a reset above
  `droppedTs`.** The model is the header of `src/versions/history.js`; the glue is
  `src/versions/api.js` (`past`/`applied`/`present`), the versions plugin's,
  outside the queue:
  `log.entriesOf(id)` filtered by `appliedHere` (skipped out, held in once
  the node runs the version), folded with `applyOp`. With `droppedTs > 0` the
  fold of everything retained must `deepEqual` the present (`present`) — the
  counter straddle `repair()` also has — or it is `HISTORY_GONE compacted` /
  `exact: false`; a stamp below a retained `merge` is `reason: 'merge'`, a
  cut before a purge `'scrubbed'`. Never answer a version from the record
  file or the catalog, and never fold from an entry below the exact start.
- **A tag is copy-on-write at the EntryStore seam.** The layout, the read
  walk, the untag move-down and the lazy read of an older tag are the header
  of `src/versions/tags.js` (the versions plugin's: without the plugin
  `core.tags` is null, `stats().tags` null, and a directory with tags is
  refused at open — `#hasTags`). What crosses modules: record files are copied by
  `EntryStore.#changing` (`before(id, file)`) ahead of
  `write`/`writeSealed`/`remove`, into the NEWEST tag only, once per record,
  only for a record the tag's catalog holds live — so the newest tag is read
  at open and after every drop, an older one at its first use, and the sync
  readers `hasAt`/`rowAt`/`catalogOf` come after `ensure(name)` (a Cursor at
  a tag awaits its source's `ready`). `tag()` flushes deferred files first and
  refuses (`UNPERSISTED`) while a record is held — its file is behind the
  cache and a copy from memory would carry no block to verify; a record held
  since the tag reads as its file, still the tag's state. An unreadable
  `tags.json` never fails `open()` (`tags.corrupt.json`, `stats().tags`,
  `take()` refuses `CORRUPT`, the copies wait under `tags/.pending/data/` for
  the next good open); never rebuild `tags.json` from the disk — fsi lists
  files, not directories. Every purge path goes through `core.scrub` (log +
  tags) — never `core.log.scrub` alone. The error field is `tag`, never
  `name` (it would overwrite `Error.name`). A view at a tag (`at(name)`,
  `src/versions/api.js`) reads through `sourceAt`, a `storage[SOURCE]`-shaped seam
  over the tag's catalog (`searches` false, `subscribe` throws), and pages
  through `snapshotPage` with a core of the tag's catalog, entries and
  position — the same `pageOf`, never a second page writer.
- **A patch is in the write API's terms, and the only way back is new ops.**
  The vocabulary and the per-kind diff are the header of `src/patch.js`;
  `realize(patch)` maps to `[type, payload]` for `commit()`. `applyPatches`
  (`src/patches.js`, the core's) rehearses, then runs them in ONE `#run` turn;
  `restore(id, at)` = `applyPatches(diff(id, undefined, at))` — never rewrite
  the log or the file. A `remove` patch with `removals` goes out as given
  (`prepareOp` takes `payload.removals` over `observedTags`), one with `own:
true` keeps this node's tags alone (`ownTags`): an undo revokes this node's
  adds and leaves a peer's. The `commit` event (`announce` in src/commit.js)
  is LOCAL ops only, built only when `listenerCount('commit') > 0`, with
  `before`/`after` as copies and the kinds of both sides — the copies (and
  `embeds`) taken at their first read, never on the write path (`commitEvent`;
  the data objects are never changed in place, so a late copy is the same);
  the undo manager keeps the events (`Kept`: a step's first `before`, last
  `after`) and copies only when it inverts. A peer's op raises `change`,
  never `commit`.
