# Browser

The browser build is selected by the `browser` export condition, so any
bundler that honours `package.json#exports` and `#browser` picks it up with no
configuration:

```js
import { open, diff, merge } from '@alexify/syncom';
```

Under the hood the entry resolves to `browser.js`, and three modules are
swapped for their browser twins:

| Node | Browser | Backed by |
| --- | --- | --- |
| `src/fsi.js` | `src/fsi.browser.js` | OPFS (`navigator.storage.getDirectory()`) |
| `src/crypto.js` | `src/crypto.browser.js` | Web Crypto (`crypto.subtle`) |
| `src/utils.js` | `src/utils.browser.js` | `crypto.randomUUID()` — the default `getId` |

CRDT, contracts, the chain, storage, the operation log and sync are the same
code in both halves; so is the `@alexify/syncom/wrpc` adapter.

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

The cipher is the same on both: AES-256-GCM under a key wrapped with
RSA-OAEP (SHA-256). Keys and ciphertext move between the platforms.

**Storage is origin-private.** `fsi.browser.js` resolves paths against
`navigator.storage.getDirectory()`, so `open({ path: 'data' })` creates a
`data/` directory inside the origin's OPFS rather than on disk. It is
per-origin and the browser may evict it.

**A browser node dials, it cannot host.** Its registry, log and cursors live
in OPFS like everything else, so a reload resumes where it left off. See
[Sync](./sync) and [wrpc transport](./wrpc#in-the-browser).

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
(`tests/utils/mock-opfs.js`) and `node:crypto`'s `webcrypto`.
`tests/utils/browser-env.js` loads the shared modules the way a bundler
honouring `package.json#browser` would, so storage and sync run against OPFS
too — see `tests/storage.browser.test.js` and `tests/sync.engine.browser.test.js`.
