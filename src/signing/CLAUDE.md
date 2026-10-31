# src/signing/CLAUDE.md — Signing

The node id as the key, what a signature covers, the async halves. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/signing/signing.js    @alexify/syncom/signing — the identity plugin (nodeId = the Ed25519 key, sign/verify) over src/signing/{ed25519,
                          ed25519.browser, sign}.js; the key functions off the root
src/signing/sign.js       canonical form, signOp, verifyOp — what a signature covers (the header + a salted payload digest) and the verdict on a peer's op
```

## Rules

- **Async asymmetry is real.** `calculateHash`, `sign` and `verify` are synchronous in
  `src/signing/ed25519.js` and promise-returning in `src/signing/ed25519.browser.js`; so are
  `encrypt` and `decrypt` in `src/encryption/rsa.js` against `rsa.browser.js`. Shared code must
  `await` them; each subpath's `*.browser.d.ts` (the `browser` types condition of its export)
  exists to declare that difference. Do not "fix" it by making the Node half async. The one
  async function of the Node half is `verifyAsync` — the engine's verify, `crypto.verify` with
  a callback, on libuv's thread pool — and it is not on the subpath's surface: `signing.js`
  leaves it out by name, and `src/signing/sign.js` is its only caller. In the browser it is
  `verify` itself. The core's own hash, `sha256` in `src/crypto/digest.js`, is async on both;
  `hashText` beside it is the write path's, at once on both (src/crypto/sha256.js in the browser).
  The barrels spell every export out — a required module spread whole, the
  rest by name, never a spread of a local — because that is the shape Node's
  cjs-module-lexer reads for an ESM importer (`tests/package/esm.test.js`).
- **Signed ops: the id is the key, the signature is the header plus a salted
  digest.** With the `signing` plugin `nodeId` = the Ed25519 public key (`isKeyId`: 43
  base64url chars, canonical last char — a non-canonical one is the same key under another
  id); `keys/sign-*.pem` next to the RSA pair, `node.json` names the id (a non-key id there —
  a UUID from before signing, or a directory opened without the plugin — is rekeyed once with
  `identity.rekeyed`; another key id is `IDENTITY_MISMATCH`, never silent). Without the plugin
  the id is what `node.json` names or `getId` mints, and a key id stays the id. `src/signing/sign.js` signs
  `[1, origin, seq, ts, type, id, scope, from, v, actor, digest, msg, prev]`
  (`headerOf` in src/header.js) with `digest = sha256(nonce + canonical(payload))`
  — `prev` minted by the core for every op, the digest where the node signs
  (`link`), at the four sites that make an op of this node's own: `issue` and
  `transact` in src/commit.js (after `validateLocal` rewrote `op.data`),
  `mergeBatch` (after the seq is assigned) and `adopt` in src/bootstrap.js —
  then `core.sign`, all before the append. A peer's
  page is verified in `checkPage` (src/apply.js) BEFORE the sequential
  `admit`, sixty-four at a time through `verifyAsync` (the thread pool in
  Node.js — a synchronous verify there would hold a page to one check at a
  time); it never throws (a throw there would be `PAGE_FAILED`, a
  stream-stopper). `OpLog.scrub` deletes the nonce with
  the payload and keeps `sig`+`digest`, so a scrubbed op's header verifies.
  A refused op is a gap, like a malformed one. `'verify'` is the default
  because ~70 call sites inject unsigned hand-made ops; `'require'` is the
  only mode that resists stripping — say so wherever signatures are
  documented — and so is the plugin on every node, since a node without it
  signs nothing. Never put the key or a signature into a metric label.
