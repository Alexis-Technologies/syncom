<div align="center">
  <img src="./docs/public/logo-mark.svg" width="96" height="96" alt="syncom">
  <h1>syncom</h1>
</div>

Fast, zero-dependency distributed data sync engine 🌐

[![npm](https://img.shields.io/npm/v/%40alexify%2Fsyncom)](https://www.npmjs.com/package/@alexify/syncom)
[![CI](https://github.com/Alexis-Technologies/syncom/actions/workflows/ci.yml/badge.svg)](https://github.com/Alexis-Technologies/syncom/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/%40alexify%2Fsyncom)](#installation)
[![dependencies](https://img.shields.io/badge/runtime_dependencies-0-brightgreen)](#bundle-size)
[![docs](https://img.shields.io/badge/docs-online-blue)](https://syncomjs.vercel.app/)
[![license](https://img.shields.io/npm/l/%40alexify%2Fsyncom)](./LICENSE)

`syncom` is a local-first data engine for JavaScript. It stores records on
disk — or in the browser's origin-private filesystem — commits every write to
a hash-linked log so tampering is detectable, and replicates every write to
peers as an operation that converges without coordination: last-writer-wins
registers, per-origin counters, tombstones. The transport is injected —
[wrpc](https://wrpc.vercel.app) out of the box — and the package has no
runtime dependencies.

```js
'use strict';

const { open } = require('@alexify/syncom');

const main = async () => {
  const storage = await open({ path: 'data' });

  const id = await storage.insert({ name: 'Ada' });
  const record = await storage.record(id);

  record.on('update', (data, delta) => console.log('changed', delta));

  record.title = 'Ada Lovelace';
  await record.save();
  await storage.inc(id, 'hits', 1); // a counter: increments add up across nodes

  console.log(await storage.validate({ last: 10 })); // true
};

main();
```

📚 **[Documentation](https://syncomjs.vercel.app/)** ·
[Getting started](https://syncomjs.vercel.app/guide/getting-started) ·
[API reference](https://syncomjs.vercel.app/reference/api)

## Table of Contents

- [Installation](#installation)
- [Bundle size](#bundle-size)
- [Quick Start](#quick-start)
- [Features](#features)
- [Browser usage](#browser-usage)
- [Status](#status)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Changelog](#changelog)
- [Security](#security)
- [License](#license)

## Installation

Requires **Node.js ≥ 22**, or a modern browser with OPFS and Web Crypto.

```bash
npm install @alexify/syncom
```

### Bundle size

Measured by `pnpm size` on every CI run. The browser entry carries a budget
that fails the build when exceeded.

| Entry | raw | min | min+gzip | budget |
| ----- | ---:| ---:| --------:| ------:|
| main entry — browser (@alexify/syncom) | 114.6 KB | 46.6 KB | 16.1 KB | 17.0 KB |
| main entry — node (@alexify/syncom) | 106.6 KB | 45.6 KB | 15.8 KB | — |
| wrpc adapter — browser (@alexify/syncom/wrpc) | 3.3 KB | 1.4 KB | 0.7 KB | 2.0 KB |

## Quick Start

```js
const { open, diff, merge } = require('@alexify/syncom');

// A schema turns entity names into collections.
const storage = await open({
  path: 'data',
  schema: { entities: { Post: {}, Author: {} } },
});

const author = await storage.Author.insert({ name: 'Ada' });
const post = await storage.Post.insert({ title: 'Draft', author: author.id });

// Records expose live properties and track their own delta.
post.title = 'Published';
console.log(post.delta());  // { title: 'Published' }
await post.save();

// Compare-and-swap, for writers that must not clobber each other.
await storage.swap(post.id, { title: 'Final' }, { title: 'Published' });

// The CRDT helpers work standalone, on plain objects. Numbers ADD, which is
// what lets two peers each increment a counter and converge.
merge({ hits: 10 }, { hits: 1 });              // { hits: 11 }
diff({ tags: ['a'] }, { tags: ['a', 'b'] });   // { tags: ['b'] }
```

### Syncing between nodes

Host one end on a [wrpc](https://wrpc.vercel.app) server, dial it from the
other. wrpc is yours to install — syncom only takes the client you built:

```js
// the hub
const { Server, defineRouter } = require('@alexify/wrpc');
const router = defineRouter({ syncom: storage.sync.unit({ access: 'public' }) });
await new Server({ router, host: '0.0.0.0', port: 8000, protocol: 'http' }).listen();

// a node — a server, a CLI, a browser tab
const { WrpcClient } = require('@alexify/wrpc');
const { createWrpcLink } = require('@alexify/syncom/wrpc');
const storage = await open({
  path: 'data',
  sync: { connect: async (node) => createWrpcLink(await WrpcClient.connect(node.url)) },
});
await storage.sync.addNode({ url: 'ws://hub.example.com:8000/api' });
```

Every node can be both, and ops relay hop by hop, so any connected graph of
nodes converges.

## Features

| Area | What you get |
| --- | --- |
| **Storage** | Records with live properties and per-record deltas, schema-driven collections, compare-and-swap writes, counters, encryption at rest (AES-256-GCM under an RSA-wrapped key) |
| **Replication** | Every write is an op in a persisted log; peers exchange ops over an injected link, resume from where they stopped, and bootstrap from a streamed snapshot when they cannot; scopes for partial replication |
| **Convergence** | Last-writer-wins registers, per-origin counters, tombstones with revival — any order, any number of times, same result |
| **Transport** | `@alexify/syncom/wrpc` adapts a `WrpcClient`; `storage.sync.unit()` is the router unit a wrpc server mounts. Reconnects, resumable subscriptions, binary streams and rooms come from wrpc |
| **Integrity** | Every write appends a hash-linked block; reads re-verify the record against the block that committed it and throw on a mismatch |
| **CRDT** | `diff` / `merge` / `apply` over plain objects — nested maps merge recursively, arrays are grow-only sets, numbers add so counters converge |
| **Contracts** | Store a procedure in the chain by hash, load it anywhere, run it against a read-only view of storage; failures are recorded as blocks |
| **Portability** | One API over `node:fs` + `node:crypto` on the server and OPFS + Web Crypto in the browser, chosen by the `browser` export condition |
| **Observability** | Injected OpenTelemetry (`open({ telemetry })`): spans for local writes, applied batches, pushes, bootstraps and log rolls, plus outcome and lag metrics — nested under wrpc's spans, which carry the trace across the wire. See [OpenTelemetry](https://syncomjs.vercel.app/guide/telemetry) |
| **Dependencies** | None. wrpc is a devDependency for one integration test and is injected at runtime |

## Browser usage

The `browser` export condition selects `browser.js` automatically — no bundler
configuration needed.

```js
import { open, diff, merge } from '@alexify/syncom';
```

Crypto is asynchronous there (`calculateHash`, `encrypt` and `decrypt` return
promises), and storage lives in the origin-private filesystem. `browser.d.ts`
declares those signatures separately. A browser node dials the mesh through
`@alexify/syncom/wrpc` like any other. See
[Browser](https://syncomjs.vercel.app/guide/browser).

## Status

Pre-1.0. Everything on this page works today and is covered by the test suite,
including replication over real wrpc WebSockets. Known limits — a counter
straddling a concurrent reset, no op signatures, encrypted records staying
local — are listed under [Guarantees and limits](https://syncomjs.vercel.app/guide/sync#guarantees-and-limits).

## Documentation

- [Getting started](https://syncomjs.vercel.app/guide/getting-started)
- [Storage](https://syncomjs.vercel.app/guide/storage) ·
  [CRDT deltas](https://syncomjs.vercel.app/guide/crdt) ·
  [Blockchain log](https://syncomjs.vercel.app/guide/chain) ·
  [Smart contracts](https://syncomjs.vercel.app/guide/contracts)
- [Sync](https://syncomjs.vercel.app/guide/sync) ·
  [wrpc transport](https://syncomjs.vercel.app/guide/wrpc) ·
  [Browser](https://syncomjs.vercel.app/guide/browser)
- [API reference](https://syncomjs.vercel.app/reference/api)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

```bash
pnpm install
pnpm test              # node --test, recursive over tests/
pnpm test:coverage     # c8 over src/
pnpm test:types        # tsd against the .d.ts files
pnpm lint              # oxlint
pnpm format            # oxfmt (format:check in CI)
pnpm size              # bundle-size report; the browser budget fails the run
pnpm bench             # every script in bench/
pnpm docs:dev          # the VitePress site
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## Security

See [SECURITY.md](./SECURITY.md). Report vulnerabilities privately — do not
open a public issue.

## License

[MIT](./LICENSE) © Alexis Technologies
