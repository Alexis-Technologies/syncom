# src/files/CLAUDE.md — The files engine

The engine every fsi becomes: today's layout, byte for byte. The engine contract and the rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/files/files.js        @alexify/syncom/files — filesEngine(fsi): a kv namespace is a directory under the path and a key a file in it,
                          a record data/<id>.json, its pieces data/<id>~<n>.json, a tag's copies tags/<tag>/data/<id>.json; write(batch)
                          lands the kv puts, then each record (its new pieces, its file, the pieces it drops), then the copies and the kv
                          removals — not atomic; remove(path) is the sweep a branch drops with — requires backend.js, engine.js, shape.js,
                          errors.js only
```

## Rules

- **Nothing on disk changes.** A database opened through `createDatabase({ fsi })` is `filesEngine(fsi)`, and every file is where it
  was before the engines: the fixture tests that alter files by hand (`tests/log.test.js`, `tests/storage.pieces.test.js`,
  `tests/suites/tags.js`) are the proof. A new store or key of the contract maps onto a directory and a file here, never onto
  a new format.
- **The order of a write set is the crash order.** The kv puts first (a chain block before the records it names), then per
  record the pieces it makes, its file, the pieces it drops (src/entries.js says why), then the copies, then the kv
  removals. A files write set is never atomic (`capabilities.atomicBatch` false): the log append stays the commit point and
  a failed landing is `UNPERSISTED`, as it always was.
