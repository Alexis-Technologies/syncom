# tests/CLAUDE.md — Tests

The suites run twice, the mesh, coverage, INVARIANTS.md. what holds for the whole repository is in [CLAUDE.md](../CLAUDE.md).

## Layout

```
tests/                    *.test.js are tests; anything else is a helper
```

## Testing

`node:test` + `node:assert`. Browser halves run under Node with the OPFS mock
(`tests/utils/mock-opfs.js`) and `node:crypto`'s `webcrypto` — see
`tests/index.browser.test.js`. Cross-platform behaviour goes in `tests/suites/`
and is run against both halves (`schema`, `catalog`, `query`, `search`, `purge`,
`hooks`, `fsi`, `sync-engine`, `signatures`, `signing`, each with a `*.test.js`
and a `*.browser.test.js`
wrapper); `tests/suites/sync-engine.js` runs the
convergence properties (a partition, a seeded fuzz over `set`/`update`/`inc`/
`add`/`remove`/`delete` — a new op kind joins as a branch there — and a late
joiner) over `tests/utils/memory-link.js` (an in-process link
that mimics a wrpc client: JSON across the boundary, a reconnect re-opens the
subscription from its last event id against a fresh server-side client) and
`tests/utils/mesh.js` (N storages from an adjacency list, `settle()`).
`tests/wrpc.integration.test.js` runs two real wrpc `Server`s and a dialer,
the `onRequest` rate-limit recipe of `docs/guide/scaling.md` (keep the two in
step), plus syncom over a fake WebRTC data channel
(`tests/utils/fake-channel.js`) attached to an `RpcServer` and to a
`PeerHost`, and skips when `@alexify/wrpc` (2.x) is not installed. Two things bite there: two nodes'
clocks are independent, so "later" needs a `tick()` between writes on
different nodes; and `settle()` ignores `@~` vector keys, because a node's
bootstrap stream never reaches the node it bootstrapped from.

Coverage thresholds (95/95/90/95) are enforced in CI. They currently pass with
headroom; do not lower them to land a change.

`INVARIANTS.md` names, for every guarantee (an id `PREFIX-n`, the prefix from the
prefix registry at its top), the tests that hold it; `tests/package/invariants.test.js` fails when an
id names no test, a named title is gone, a prefix is not in the registry or a row is out of
the registry's order. Rename a test and its row together; a new
guarantee gets an id, a test and a row. Only plain-string titles are citable. The
hazard walk in `tests/suites/sync-engine.js` (drops, duplicate pages through
`tests/utils/memory-link.js`'s `duplicate` hook, a reopen) is the one that must stay
green whatever else moves.
