# Browser

The browser build is selected by the `browser` export condition, so any
bundler that honours `package.json#exports` and `#browser` picks it up with no
configuration:

```js
import { open, diff, merge } from '@alexify/syncom';
```

Under the hood the entry resolves to `browser.js`, and four modules are
swapped for their browser twins — two in the core, two in the subpaths that
carry the crypto:

| Node | Browser | Backed by |
| --- | --- | --- |
| `src/fsi.js` | `src/fsi.browser.js` | OPFS (`navigator.storage.getDirectory()`) |
| `src/utils.js` | `src/utils.browser.js` | `crypto.randomUUID()` — the default `getId` |
| `src/signing/ed25519.js` | `src/signing/ed25519.browser.js` | Web Crypto (`crypto.subtle`) — `@alexify/syncom/signing` |
| `src/encryption/rsa.js` | `src/encryption/rsa.browser.js` | Web Crypto — `@alexify/syncom/encryption` |

CRDT, contracts, the chain, storage — lists, text, trees, history and tags
among it — the operation log and sync are the same code in both halves; so
are the `/wrpc`, `/search`, `/order`, `/undo` and `/branch` subpaths. The
core's own hash (the chain's blocks, the schema hash) is SHA-256 through Web
Crypto on both platforms. `@alexify/syncom/idb` is the one that is
browser-only.

## What differs

**Crypto is asynchronous.** `node:crypto` hashes and encrypts synchronously;
the Web Crypto API does not. So in the browser, from `@alexify/syncom/signing`
and `@alexify/syncom/encryption`:

```js
await calculateHash({ a: 1 }); // Promise<string> — sync in Node.js
await encrypt(data, publicKey);
await decrypt(data, privateKey);
await sign(message, privateKey); // the Ed25519 pair that signs ops
await verify(message, signature, nodeId);
```

Each subpath's `browser` export condition carries its own types
(`signing.browser.d.ts`, `encryption.browser.d.ts`) that declare these five
signatures separately for exactly this reason.

The cipher is the same on both: AES-256-GCM under a key wrapped with
RSA-OAEP (SHA-256), and the signature is Ed25519 over the same bytes. Keys,
ciphertext and signatures move between the platforms: a signing pair on disk
is one node id on both.

**Storage is origin-private.** `fsi.browser.js` resolves paths against
`navigator.storage.getDirectory()`, so `open({ path: 'data' })` creates a
`data/` directory inside the origin's OPFS rather than on disk. It is
per-origin and the browser may evict it. Another backend goes in through
`open({ fsi })` — `createMemoryFsi()` for a node that must not persist, or
IndexedDB (see [Backends](./backends)).

## OPFS or IndexedDB

OPFS is the default. Where it is unavailable or unwanted — a context without
it, a profile that evicts it, an app that already lives in IndexedDB — the
`@alexify/syncom/idb` subpath is the same contract over IndexedDB:

```js
import { open } from '@alexify/syncom';
import { createIdbFsi } from '@alexify/syncom/idb';

const fsi = createIdbFsi({ name: 'app' }); // one database, one store `files`
const storage = await open({ path: 'data', fsi });
// …
await storage.close();
await fsi.close();
```

Every file of the storage — records, log, chain, keys, registry — is a row
keyed by `[dir, name]`; a directory listing is one index lookup. The database
is opened on the first call and reopened after another tab upgrades or
deletes it; a write resolves once its transaction completed, which is as
durable as IndexedDB gets (`durable: true` is a no-op here). `close()` is the
backend's own: the storage never closes a backend it was handed, since two
storages may share one.

**A browser node dials a hub, and hosts for its peers over WebRTC.** Its
registry, log and cursors live in OPFS like everything else, so a reload
resumes where it left off; `storage.sync.unit()` mounted on a wrpc
`PeerHost` makes it a host other browsers dial. See [Sync](./sync),
[wrpc transport](./wrpc#in-the-browser) and [WebRTC](./webrtc).

## Requirements

OPFS and Web Crypto — SHA-256 for the core, Ed25519 among its algorithms
for the `signing` plugin (it signs every op), RSA-OAEP and AES-GCM for the
`encryption` one — available in current Chrome, Edge, Firefox and Safari. Both APIs require a
**secure context** (HTTPS or `localhost`).

## Bundle size

The browser entry — the core — is measured on every CI run with a budget
that fails the build when exceeded — 54 KB min+gzip — and so is every
subpath, on its own row with its own budget (`/text` 15 KB, `/tree` 5.5 KB,
`/all`, everything registered, 68.5 KB), so what an app imports is what it
ships (see [Entry points](/guide/entry-points)):

```bash
pnpm size
```

The self-contained check in `scripts/size.js` also rejects any bare import
that sneaks into a browser bundle, so it cannot silently grow a dependency.
The table is in the [README](https://github.com/Alexis-Technologies/syncom#bundle-size).

## Testing without a browser

The suite exercises the browser halves under Node.js using a mock OPFS
(`tests/utils/mock-opfs.js`) and `node:crypto`'s `webcrypto`.
`tests/utils/browser-env.js` loads the shared modules the way a bundler
honouring `package.json#browser` would, so storage and sync run against OPFS
too — see `tests/storage.browser.test.js` and `tests/sync.engine.browser.test.js`.
