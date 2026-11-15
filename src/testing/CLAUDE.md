# src/testing/CLAUDE.md — Testing

What a test over syncom stands on, and what this repository's suite runs on. The rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/testing/testing.js    @alexify/syncom/testing — MemoryLink, createMesh, settle, waitUntil, sameVectors, prng, withDatabase, and the
                          memory engine re-exported — requires link.js, mesh.js, memory/memory.js only
src/testing/link.js       MemoryLink: an in-process SyncLink over a host's unit() — JSON across the boundary, `changes` as an async
                          generator, the hazards (latency, drop, duplicate, maxMessage, disconnect, wrpc's reconnect), wrpc's binary
                          streams in process under `streams` (pipe) — requires utils.js only
src/testing/mesh.js       createMesh(names, edges, { createStorage, link, sync, nodes, unit, scopes }), the host's server (rooms, sendTo),
                          settle, waitUntil, sameVectors, prng — requires link.js only
```

## Rules

- **One copy.** The link and the mesh were `tests/utils/memory-link.js` and `tests/utils/mesh.js`; those files
  re-export this module (the mesh with the test context: `createMesh(t, names, edges, createStorage, options)`
  registers each close on `t`). A hazard a suite needs — a page dropped, doubled, a reconnect — is added here, in
  the link's options, never in a test's own copy of the link: the hazard walk of `tests/suites/sync-engine.js`
  and an application's test must see the same boundary.
- **The databases are the caller's.** `createMesh` makes no database: `createStorage(name, options)` is handed
  `sync.connect` (the links) and `autoStart: false` over what `nodes[name]` and `sync` say, and spreads them into
  its own `createDatabase()` — the engine, the plugins, the schema under test are the caller's; this module
  requires nothing of the core but `utils.js` (the emitter) and the memory engine it re-exports.
- **The link is wrpc at the boundary, no more.** Arguments and results cross as JSON (the tracked symbol stripped),
  `changes` runs as an async generator with `{ lastEventId, signal }`, `disconnect()` aborts it and fails every call
  with code 503, `reconnect()` re-opens every subscription from the last event id it delivered against a fresh
  server-side client (its `data` bag empty, so the host greets it again) and then announces `reconnect` — wrpc's
  restore, nothing wrpc does not do. The event id moves only after a page is handed over (`onData` done), never for
  a page `drop` lost: a socket never loses one message and carries on, so a dropped page takes the link down
  (`disconnect()`, `close` announced) and nothing after it is delivered until `reconnect()` hands it over again. The
  links of one host share a server (rooms, `sendTo`), as wrpc's do. A call the socket went under fails (503) whatever
  the host answered or refused: nothing arrives over a closed socket. Under `streams` the link is a binary transport
  as wrpc's are: the host's client and the link each announce a stream (`createStream`) the other end reads once
  (`getStream`, `stream`) — `pipe`: a copy of every chunk, `write` answering false past `HIGH` chunks unread with a
  `drain` after, a writer's `end`/`terminate`, a reader's `terminate` after which the writer's chunks are taken and
  dropped (nothing tells a wrpc writer that its reader let go), every stream closed with the socket — so a snapshot
  page and an attachment's bytes cross as they do over a WebSocket. `maxMessage` is the socket's limit: a call
  whose arguments are longer as JSON, or a chunk past it, takes the link down — what makes a test prove that bytes
  cross in pieces and never as one message.
- **Quiet is vectors AND nothing in flight, three polls in a row.** A peer's page moves the vector at the log append
  and lands its records after, inside the same `applyRemote`; `settle()` waits for every queue empty and every
  peer's `pending` zero as well, and ignores `@~` keys (a bootstrap stream never reaches the node it came from). A
  timeout of `settle()` or `waitUntil()` is a plain `Error`: a test's failure, not a condition a program handles.
