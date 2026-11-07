# src/engines/CLAUDE.md — Engines: served over a port, copied between

What is done with engines rather than by one. The engine contract and the rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/engines/engines.js    @alexify/syncom/engines — serveEngine, remoteEngine, connectEngine, copyEngine — requires remote.js, copy.js only
src/engines/remote.js     serveEngine(engine, port, { allow }) answers the contract over a message port — every call checked against a
                          table of the stores, their methods and their arguments; remoteEngine(port, { name, capabilities, timeout })
                          and connectEngine(port, { timeout }) are the engine on the other side: a message per call, the log store's
                          getters kept from the last answer, change events, a lease's loss and its life (`leaseEvent`) pushed, the port's death and a timeout
                          ENGINE_UNREACHABLE, stats() — requires engine.js, blobs.js, write-set.js, shape.js, errors.js only
src/engines/copy.js       copyEngine(from, to, { path, batch }): the database at a path copied — kv (not the lock; the identity last),
                          records with their pieces, a tag's copies, the log (sealed entries as one segment, `batch` a group; open
                          groups as they were) and its index — both held for the copy, the target empty (TARGET_NOT_EMPTY), a failure
                          taken away again — requires engine.js, errors.js, lock.js, crypto/keys.js only
```

## Rules

- **Only bytes cross the port.** `remoteEngine` is a proxy of the stores: every call one message, its answer or its
  error back (a `SyncomError` with its code and fields, a `TypeError`, an `EEXIST` — never a file system's `path`,
  `syscall` or `errno`). A callback never crosses — `append`'s `onFail` is the answer `{ landed: false, error }`,
  `scrub`'s `entriesBetween` the scrubbed entries themselves, sent along (the journal rebuilds nothing from less than
  it held: src/files/CLAUDE.md); `drop(segment)` names the segment by its range, since the proxy's `segments` are
  copies, and the OpLog reads `segments` again after every drop. The OpLog reads the log store's getters at once, so
  the proxy keeps them from the last answer. The database lives where it is opened (its seqs are minted there); the
  served side is one engine for every port it answers.
- **The served side trusts the port as it trusts the process, no further.** A call names a store and a method of the
  contract — the table in remote.js, `Object.hasOwn` — and nothing else: not a `lock`, a files engine's `fsi`, an
  inherited `valueOf`. Every key, id, tag, piece's name and path is checked before a store sees it (`isKvKey`,
  `isRecordId`, `checkWriteSet`: a key becomes a file name in the files engine, a value a filter in MongoDB), a path
  may be opened only where `allow` lists it, and `remove(path)` takes what this port opened (or what `allow` lists).
  An answer that does not clone crosses as an error. A port that closes or a worker that exits fails every call
  waiting and every call after as `ENGINE_UNREACHABLE` (`reason: 'closed'`), and the served side lets go of what
  that port held — its leases, subscriptions, databases; a call past `timeout` fails the same (`reason: 'timeout'`).
  A refusal of the served side is a `TypeError`: the call was wrong, not the data.
- **A copy is the node, not a snapshot of it.** `copyEngine` carries the identity, the epoch, the vector and the heads
  (the log's index) with every entry, so the node opens on the new engine as itself and a peer resumes its cursor
  without a bootstrap. Both databases are held as `createDatabase()` holds them (the lock key, or the engine's lease —
  lost on the way, the copy fails `LEASE_LOST`), the lock key itself is not copied, and a target that holds
  `node.json` or a record is refused. The identity — the keys (with their file mode, `KEY_FILE_MODE`), then
  `node.json` — lands LAST, so a copy cut short is no node of that name, and a copy that fails removes what it wrote
  (`to.remove(path)`: the target was empty). The sealed entries go as one segment, `batch` entries a group: retention
  compacts it as a whole, which it would have done piece by piece. The kv namespaces copied are `KV_NAMESPACES`
  (src/engine.js) and a tag's — a plugin's namespace of its own is added there.
- **A copy may land beside its source.** `copyEngine(from, to, { path, targetPath })` opens the target at `targetPath`
  (`path` by default): the at-rest key's rotation copies a database into another path of the same engine, sealed under
  the new key; the same engine and the same path is refused (a TypeError) before anything is held. The attachments'
  blobs are copied one by one where both engines keep them (`counts.blobs`); a target WITHOUT a blobs store while the
  source holds blobs is `BLOBS_UNSUPPORTED` (`engine`, `blobs`), refused after the emptiness check and before anything
  is written — a copy that silently dropped every blob would leave registers naming bytes nowhere.
