# src/engines/CLAUDE.md — Engines: served over a port, copied between

What is done with engines rather than by one. The engine contract and the rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/engines/engines.js    @alexify/syncom/engines — serveEngine, remoteEngine, connectEngine, copyEngine — requires remote.js, copy.js only
src/engines/remote.js     serveEngine(engine, port) answers the contract over a message port; remoteEngine(port, { name, capabilities })
                          and connectEngine(port) are the engine on the other side: a message per call, the log store's getters kept
                          from the last answer, change events and a lease's loss pushed — requires engine.js, errors.js only
src/engines/copy.js       copyEngine(from, to, { path, batch }): the database at a path copied — kv (not the lock), records with their
                          pieces, a tag's copies, the log (sealed entries as one segment, open groups as they were) and its index — both
                          held for the copy, the target empty (TARGET_NOT_EMPTY) — requires engine.js, errors.js, lock.js only
```

## Rules

- **Only bytes cross the port.** `remoteEngine` is a proxy of the stores: every call one message, its answer or its
  error back (a `SyncomError` with its code and fields, a `TypeError`, an `EEXIST`). A callback never crosses —
  `append`'s `onFail` is the answer `{ landed: false, error }`, `scrub`'s `entriesBetween` the entries it would
  answer, sent along; `drop(segment)` names the segment by its range, since the proxy's `segments` are copies. The
  OpLog reads the log store's getters at once, so the proxy keeps them from the last answer. The database lives where
  it is opened (its seqs are minted there); the served side is one engine for every port it answers.
- **A copy is the node, not a snapshot of it.** `copyEngine` carries the identity, the epoch, the vector and the heads
  (the log's index) with every entry, so the node opens on the new engine as itself and a peer resumes its cursor
  without a bootstrap. Both databases are held as `createDatabase()` holds them (the lock key, or the engine's lease),
  the lock key itself is not copied, and a target that holds `node.json` or a record is refused. The sealed entries go
  as one segment: retention compacts it as a whole, which it would have done piece by piece.
