# src/encryption/CLAUDE.md — Encryption

Encrypted records are local. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/encryption/encryption.js  @alexify/syncom/encryption — the sealing plugin (encrypted: true) over src/encryption/{rsa,rsa.browser}.js,
                          and atRest(fsi, …), the AES-256-GCM backend wrapper
```

## Rules

- **Encrypted records are local.** `{ encrypted: true }` seals a record for
  this node's key; it produces no op and is excluded from snapshots. Do not
  route an encrypted entry through `applyOp`.
