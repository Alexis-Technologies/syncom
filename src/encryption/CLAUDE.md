# src/encryption/CLAUDE.md — Encryption

Encrypted records are local. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/encryption/encryption.js  @alexify/syncom/encryption — the sealing plugin (encrypted: true) over src/encryption/{rsa,rsa.browser}.js,
                          and atRest(fsi | engine, …), the AES-256-GCM wrapper of a backend or an engine (the cipher, createCipher)
src/encryption/at-rest-engine.js  atRestEngine(engine, cipher): the engine contract over an engine, every value a ciphertext bound to
                          its place — records as text, pieces, copies, kv, the log's entries and index (its floor in the clear);
                          indexes off; the files engine refused (wrap its backend) — requires engine.js, errors.js only
```

## Rules

- **Encrypted records are local.** `{ encrypted: true }` seals a record for
  this node's key; it produces no op and is excluded from snapshots. Do not
  route an encrypted entry through `applyOp`.
- **At rest, a value is bound to its place.** `atRest` seals with the place as AES-GCM's additional data — a file's
  name, or under an engine `data/<id>.json`, `data/<piece>`, `tags/<tag>/data/<id>.json`, `<ns>/<key>`, `log/<seq>`,
  `log/index.json` — so a ciphertext copied over another's place does not open. The keys (an id, a seq, a tag, a kv
  key) and the log index's `floor` stay in the clear: a medium tells a sealed seq from an open one by the floor. The
  engine wrapper writes a record as `text` and reads it through `raw` (a medium keeps a text that is no JSON as it
  is); the files engine is never wrapped this way — its journal reads the ops it writes — but at its backend.
