# Browser

The browser build is selected by the `browser` export condition, so any
bundler that honours `package.json#exports` and `#browser` picks it up with no
configuration:

```js
import { open, diff, merge } from '@alexify/syncom';
```

Under the hood the entry resolves to `browser.js`, and four modules are
swapped for their browser twins:

| Node | Browser | Backed by |
| --- | --- | --- |
| `src/fsi.js` | `src/fsi.browser.js` | OPFS (`navigator.storage.getDirectory()`) |
| `src/crypto.js` | `src/crypto.browser.js` | Web Crypto (`crypto.subtle`) |
| `src/sync.js` | `src/sync.browser.js` | in-memory node registry |
| `src/utils.js` | `src/utils.browser.js` | `crypto.randomUUID()` |

CRDT, contracts, the chain and storage are the same code in both halves.

## What differs

**Crypto is asynchronous.** `node:crypto` hashes and encrypts synchronously;
the Web Crypto API does not. So in the browser:

```js
await calculateHash({ a: 1 }); // Promise<string> — sync in Node.js
await encrypt(data, publicKey);
await decrypt(data, privateKey);
```

`browser.d.ts` declares these signatures separately from `index.d.ts` for
exactly this reason.

The cipher differs too: Node.js uses RSA with the default padding via
`publicEncrypt`; the browser uses RSA-OAEP with SHA-256. Keys generated on one
platform are PEM-compatible, but ciphertext is not portable between them.

**Storage is origin-private.** `fsi.browser.js` resolves paths against
`navigator.storage.getDirectory()`, so `open({ path: 'data' })` creates a
`data/` directory inside the origin's OPFS rather than on disk. It is
per-origin and the browser may evict it.

**Sync nodes are not persisted.** See [Sync](./sync).

## Requirements

OPFS and Web Crypto — available in current Chrome, Edge, Firefox and Safari.
Both APIs require a **secure context** (HTTPS or `localhost`).

## Bundle size

The browser entry is measured on every CI run with a budget that fails the
build when exceeded:

```bash
pnpm size
```

The self-contained check in `scripts/size.js` also rejects any bare import
that sneaks into the browser bundle, so it cannot silently grow a dependency.

## Testing without a browser

The suite exercises the browser halves under Node.js using a mock OPFS
(`tests/utils/mock-opfs.js`) and `node:crypto`'s `webcrypto`. See
`tests/index.browser.test.js` for the pattern.
