# src/encryption/CLAUDE.md — Encryption

Encrypted records are local. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/encryption/encryption.js  @alexify/syncom/encryption — the sealing plugin (encrypted: true) over src/encryption/{rsa,rsa.browser}.js,
                          and atRest(fsi | engine, …), the AES-256-GCM wrapper of a backend or an engine (the cipher, createCipher:
                          seal/open for text, sealBytes/openBytes for a blob); rotateAtRest(engine | { fsi, filesEngine }, { path, from,
                          to, into }) — the at-rest key rotated by a copy (engines/copy.js), the source fenced with moved.json (MOVED)
src/encryption/at-rest-engine.js  atRestEngine(engine, cipher): the engine contract over an engine, every value a ciphertext bound to
                          its place — records as text, pieces, copies, kv, the log's entries and index (its floor in the clear);
                          indexes off; a blob's bytes sealed as bytes (iv ‖ ciphertext) at the blob's place (the digest a name, in
                          the clear; a cipher of text alone seals them as base64 text); estimate passed through; the files engine
                          refused (wrap its backend) — requires engine.js, blobs.js, errors.js, crypto/pem.js only
```

## Rules

- **Encrypted records are local.** `{ encrypted: true }` seals a record for
  this node's key; it produces no op and is excluded from snapshots. Do not
  route an encrypted entry through `applyOp`.
- **At rest, a value is bound to its place — and, under an engine, to its database.** `atRest` seals with the place
  as AES-GCM's additional data — a file's name, or under an engine the database's path, length-prefixed
  (`<n>:<path>/`), then `data/<id>.json`, `data/<piece>`, `tags/<tag>/data/<id>.json`, `<ns>/<key>`, `log/<seq>`,
  `log/index.json` — so a ciphertext copied over another's place, or to the same place in another database of the
  engine (one key serves every path), does not open. What the place does not bind is the VERSION: an older
  ciphertext of the same place opens — the chain (`validate()`) tells a record rolled back, nothing tells a kv text
  or a log entry; say so where at-rest is promised. The keys (an id, a seq, a tag, a kv
  key) and the log index's `floor` stay in the clear: a medium tells a sealed seq from an open one by the floor. The
  engine wrapper writes a record as `text` and reads it through `raw` (a medium keeps a text that is no JSON as it
  is), and a blob as BYTES — `sealBytes`/`openBytes` of the cipher: iv ‖ ciphertext bound to `<n>:<path>/blobs/<digest>`,
  28 bytes over the blob's own size, never base64 (64 MiB cost 28× its size in heap as text); a blob that is not the
  key's, never sealed or moved to another place is DECRYPT_FAILED `key` — bytes carry no prefix to tell plain from
  sealed; a cipher of text alone (a test's) seals them as base64 text. The files engine is never wrapped this way —
  its journal reads the ops it writes — but at its backend.
- **A key is rotated by a copy, never in place — and the source is fenced.** `rotateAtRest(engine, …)` is
  `copyEngine(atRest(engine, from), atRest(into.engine ?? engine, to), { path, targetPath })`; over a backend — the
  default medium, the files engine, which `atRestEngine` refuses — it is `rotateAtRest({ fsi, filesEngine }, …)`:
  `copyEngine(filesEngine(atRestFsi(fsi, from)), filesEngine(atRestFsi(into.fsi ?? fsi, to)), …)`, the files engine's
  factory handed in because requiring it here would double the subpath (the journal, the log file format). The whole
  node — identity, epoch, vector, heads, every value and blob — lands sealed under the new key where `into` says. Then
  the SOURCE is fenced: `moved.json` `{ to: { path, engine }, at }` in its root namespace, sealed under `from`, which
  `loadIdentity` (src/identity.js) refuses as `MOVED { to }` at every open until `dropDatabase` takes the directory —
  the same node id never writes in two places (two instances minting one stream). A copy cut short leaves the source
  whole and its target marked (`copy.json`, copyEngine's, written first and removed last): the next copy into it takes
  the leftovers away first; the same engine and path is refused (a TypeError), as `copyEngine` refuses a target that
  is its source; `moved.json` and `copy.json` are never copied. A sealed record's pair (`encrypted: true`, the `keys/`
  namespace) is not rotated: a new pair is a new node.
