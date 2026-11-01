# src/files/CLAUDE.md — The files engine

The engine every fsi becomes: today's layout, byte for byte. The engine contract and the rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/files/files.js        filesEngine(fsi), a root export of @alexify/syncom: a kv namespace is a directory under the path and a key a file in it,
                          a record data/<id>.json, its pieces data/<id>~<n>.json, a tag's copies tags/<tag>/data/<id>.json; write(batch)
                          lands the kv puts, then each record (its new pieces, its file, the pieces it drops), then the copies and the kv
                          removals — not atomic; remove(path) is the sweep a branch drops with; db.log is the journal store below —
                          requires backend.js, engine.js, write-set.js, shape.js, errors.js, journal.js only
src/files/journal.js      createJournalStore(fsi, path): the op log's medium — open groups as journal lines (or a file each), sealed
                          segments with a trailer, corrupt/, index.json; load/append/seal/sealed/segments/drop/saveIndex/scrub; the
                          file format (fileOf/readFile/segmentOf/readSegment) lives here — requires crc32.js, header.js, errors.js only
```

## Rules

- **Nothing on disk changes.** A database opened through `createDatabase({ fsi })` is `filesEngine(fsi)`, and every file is where it
  was before the engines: the fixture tests that alter files by hand (`tests/log.test.js`, `tests/storage.pieces.test.js`,
  `tests/suites/tags.js`) are the proof. A new store or key of the contract maps onto a directory and a file here, never onto
  a new format.
- **The order of a write set is the crash order.** The kv puts first (a chain block before the records it names), then the
  tags' copies (a record as it was, before its file changes: a crash between leaves a copy, never a changed record
  without one), then per record the pieces it makes, its file, the pieces it drops (src/entries.js says why), then the kv
  removals. A files write set is never atomic (`capabilities.atomicBatch` false): the log append stays the commit point and
  a failed landing is `UNPERSISTED`, as it always was.
- **A name is a file: checked first, sorted after.** A namespace, a key, a tag, a piece's name reach the backend only as
  `isKvKey` admits them (src/engine.js: no separator, no `..`, no control character) — `kv.*`, `pieces.*`, `copies.*` and
  `write` refuse the rest with a `TypeError` (a rejection, never a throw) before a path is made of it. The backend lists
  in its own order (a hash on ext4; `a-b.json` before `a.json` by name), so `records.ids` and `copies.ids` collect every
  name, sort, and page after: an id order a listing by file name would not give.
- **The journal rebuilds nothing from less than it held.** `scrub` and the rewrite after a failed append take the entries
  of a file from the log where it answers the whole range, else from the file's own text — a segment read back, a group's
  line parsed — with the entries at the scrubbed seqs swapped for what the log hands back (`entriesBetween(seq, seq)` is
  all a store is handed for certain: a proxy sends those alone). A file that is whole neither way is left as it is and
  said out loud (`log.journal.unrewritten`, `log.segment.unscrubbed`), never written short.
