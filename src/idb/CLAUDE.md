# src/idb/CLAUDE.md — IndexedDB

The backend over IndexedDB (a file store) and the engine over it (object stores). The engine contract and the rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/idb/idb.js            @alexify/syncom/idb — createIdbFsi({ name, store, indexedDB }): one object store keyed [dir, name], a transaction
                          per file (the file store a database opened over before the engines), and the engine's export — requires
                          engine.js only
src/idb/engine.js         idbEngine({ name, indexedDB, IDBKeyRange, durability, channel }): the engine over object stores — kv [p, ns, key],
                          records [p, id] (the object as handed), pieces [p, id, name], copies [p, tag, id], log [p, seq] with the group's
                          first seq, meta [p, key] (the log's index and segments, the catalog's rows); one readwrite transaction per write
                          set and per log group, key ranges for listings, a BroadcastChannel for another tab — requires engine.js,
                          blobs.js, errors.js only
```

## Rules

- **A key range, never a scan; a transaction per write set, never per file.** Every key of every store begins with the
  database's path `p`, so one IndexedDB database serves many databases and `remove(path)` is a range delete per store. A
  listing is `getAllKeys` over `[...prefix]`..`[...prefix, []]` (a shorter array sorts before any it is a prefix of; an
  array component sorts after every string and number, so `[]` is the ceiling). A write set is one readwrite transaction
  over the stores it touches, every request queued before the first `await` (IndexedDB auto-commits a transaction the
  loop leaves idle), committed explicitly where `commit()` exists — and aborted where a request throws (a value no
  structured clone takes), so the requests queued before it go with it; the log's group is one transaction over `log`.
  The segments list in memory moves once the medium has it. Booleans never reach a key (none of the keys holds one).
- **Objects, not texts.** A record is the structured clone of the object the write set handed in, read back as an
  object; `raw(id)` stringifies on demand; a text that is no record is kept as `{ text }` and reads as `INTEGRITY`.
  The log's entries are clones too (a scrub puts the stripped entries again — `scrub`), and the catalog's rows are one
  meta value. `fake-indexeddb` runs it all under Node (`tests/engine.idb.test.js`, `tests/sync.engine.idb-engine.test.js`).
- **Seven stores, made at once, at version 1.** `kv`, `records`, `pieces`, `copies`, `log`, `meta` and `blobs`
  (`[p, digest]` → a Uint8Array) are made in the one `onupgradeneeded` a new database gets. Nothing is published, so
  there is no older database to upgrade: a store added before the first release joins `STORES` at version 1 and a
  development database is deleted, not upgraded (IndexedDB refuses a database of a higher version). After the first
  release a new store is a new version, never a store made outside the upgrade.
