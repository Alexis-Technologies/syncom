# src/encryption/CLAUDE.md — Encryption

Encrypted records are local. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/encryption/encryption.js  @alexify/syncom/encryption — the sealing plugin (encrypted: true) over src/encryption/{rsa,rsa.browser}.js,
                          and atRest(fsi | engine, …), the AES-256-GCM wrapper of a backend or an engine (the cipher, createCipher); rotateAtRest(engine, { path, from, to, into }) — the at-rest key rotated by a copy (engines/copy.js)
src/encryption/at-rest-engine.js  atRestEngine(engine, cipher): the engine contract over an engine, every value a ciphertext bound to
                          its place — records as text, pieces, copies, kv, the log's entries and index (its floor in the clear);
                          indexes off; a blob's bytes sealed as base64 text at the blob's place (the digest a name, in the clear);
                          the files engine refused (wrap its backend) — requires engine.js, errors.js, crypto/pem.js only
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
  is); the files engine is never wrapped this way — its journal reads the ops it writes — but at its backend.
- **A key is rotated by a copy, never in place.** `rotateAtRest` is `copyEngine(atRest(engine, from), atRest(into.engine ??
engine, to), { path, targetPath: into.path ?? path })`: the whole node — identity, epoch, vector, heads, every value and
  blob — lands sealed under the new key where `into` says, and a copy cut short leaves the source whole and the target
  empty; the same engine and path is refused (a TypeError), as `copyEngine` refuses a target that is its source. A sealed
  record's pair (`encrypted: true`, the `keys/` namespace) is not rotated: a new pair is a new node.
