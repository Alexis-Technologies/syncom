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
a hash-linked log so tampering is detectable, and produces CRDT deltas that
peers can merge without coordination. It has no runtime dependencies.

```js
'use strict';

const { open } = require('@alexify/syncom');

const main = async () => {
  const storage = await open({ path: 'data' });

  const id = await storage.insert({ name: 'Ada', hits: 0 });
  const record = await storage.record(id);

  record.on('update', (data, delta) => console.log('changed', delta));

  record.hits = 1;
  await record.save();

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
| main entry — browser (@alexify/syncom) | 30.9 KB | 13.0 KB | 4.7 KB | 5.0 KB |
| main entry — node (@alexify/syncom) | 27.7 KB | 12.6 KB | 4.5 KB | — |

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

## Features

| Area | What you get |
| --- | --- |
| **Storage** | Records with live properties and per-record deltas, schema-driven collections, compare-and-swap writes, optional RSA encryption at rest |
| **Integrity** | Every write appends a hash-linked block; reads re-verify the record against the block that committed it and throw on a mismatch |
| **CRDT** | `diff` / `merge` / `apply` over plain objects — nested maps merge recursively, arrays are grow-only sets, numbers add so counters converge |
| **Contracts** | Store a procedure in the chain by hash, load it anywhere, run it against a read-only view of storage; failures are recorded as blocks |
| **Portability** | One API over `node:fs` + `node:crypto` on the server and OPFS + Web Crypto in the browser, chosen by the `browser` export condition |
| **Dependencies** | None |

## Browser usage

The `browser` export condition selects `browser.js` automatically — no bundler
configuration needed.

```js
import { open, diff, merge } from '@alexify/syncom';
```

Crypto is asynchronous there (`calculateHash`, `encrypt` and `decrypt` return
promises), and storage lives in the origin-private filesystem. `browser.d.ts`
declares those signatures separately. See
[Browser](https://syncomjs.vercel.app/guide/browser).

## Status

Pre-1.0, and one part of the surface is a stub worth calling out: `storage.sync`
registers, persists and lists peer nodes, but **no transport is implemented** —
`sync.start()` is a no-op. Everything else on this page works today. See
[Sync](https://syncomjs.vercel.app/guide/sync).

## Documentation

- [Getting started](https://syncomjs.vercel.app/guide/getting-started)
- [Storage](https://syncomjs.vercel.app/guide/storage) ·
  [CRDT deltas](https://syncomjs.vercel.app/guide/crdt) ·
  [Blockchain log](https://syncomjs.vercel.app/guide/chain) ·
  [Smart contracts](https://syncomjs.vercel.app/guide/contracts)
- [Sync](https://syncomjs.vercel.app/guide/sync) ·
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
