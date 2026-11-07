# src/attachments/CLAUDE.md — Attachments

Bytes beside a record: in the engine's blobs store by digest, named on the record, fetched on demand. The rules of the core are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/attachments/attachments.js @alexify/syncom/attachments — attachments({ compression }): the plugin, db.attachments (put, get, has, list, remove)
                          over the engine's blobs store and the record's `_attachments/<name>` register; the bytes fetched through
                          sync.fetchBlob where this node lacks them; prepare() and field() for a follower of /shared; sweep(), the
                          mark-and-sweep over the store — requires errors.js, blobs.js, symbols.js, crypto/digest.js only
```

## Rules

- **The name is a field; the bytes are content.** `put` writes the blob first (`blobs.put(digest, bytes)`: content-addressed,
  idempotent, outside the write set — the same bytes are the same blob whoever names them) and then the register
  `_attachments/<name>` through the database's own `update`: logged, replicated, tagged, undone like any field. `remove` is an
  `unset` of the register; the bytes stay (another name, another record may share them — there is no reference count) until
  `sweep({ dryRun, tags })`: a mark-and-sweep through the `[SOURCE]` seam — `guard('a sweep')` first (CLOSED, READ_ONLY on a
  follower), the live rows (`all()` minus `gone`) read `SWEEP_PAGE` at a time through `loadMany` (a sealed record's data as
  the key here opens it), every valid register's digest marked; with `tags` the copies of every tag in `tags.json` and of
  `.pending` (the engine's `copies`, the record file's `data`; a sealed copy reads as none), the puts in flight (`#pending`:
  a count per digest between the blob's put and the register's landing) marked too — then `blobs.list()` minus the marks
  removed. The log is NOT marked (a restored register's bytes come from a peer or are `BLOB_NOT_FOUND`), and a follower's
  put in flight is not the leader's to see — said in the guide. A sealed record (`row.encrypted`) takes no attachment:
  `put` is `ENCRYPTED` before the blob is stored — the store holds bytes the record's key does not cover. Nothing of a
  blob is an op, and a peer's op never carries bytes.
- **Bytes are believed by digest alone, and a register only as far as it is one.** A node that reads a register whose
  bytes it lacks asks the connected peers (`sync.fetchBlob(digest, { id, name })`, `syncom/blob { digest, id, name }` — a
  host serves a digest only where a live record in the peer's scopes names it, src/sync/reads.js `blobNamed`; a digest
  alone only under `allow.blob: 'any'`), hashes what it got and keeps it only when the
  hash is the digest (`sync.blob.mismatch` otherwise, the next peer asked); the host answers a wrpc stream where
  `client.binary` is not false, base64 on a text transport (`toBase64` of crypto/pem.js — the one base64), and 404
  `BLOB_NOT_FOUND` for what it lacks; a peer's answer past MAX_BLOB_BYTES (64 MiB, `src/blobs.js` — the one cap, every
  store's `put` and `attachments.put` refuse past it as `BLOB_TOO_LARGE`) is refused. A register is a peer's word:
  `#entry` takes it only where `validEntry` holds (`isDigest` — 64 lowercase hex, never a path: a digest is the files
  engine's file name — a `type`, a safe `length` within the cap, a known `encoding`), `ATTACHMENT_INVALID` from
  `get`/`has`, left out of `list` with one `attachments.register.invalid`; every engine's store checks the digest at its
  own door too (`checkDigest`). The bytes read are what the register says or `BLOB_MISMATCH` (`#mismatch`: a plain
  blob of another `length`, a compressed one that inflates past `length` — `inflate` counts the chunks and cancels the
  reader there, nothing inflated whole on a register's word — or to another length). A fetched blob is kept ONCE: the
  dialer's `fetchBlob` puts it (a store that refuses is `sync.blob.keep.failed`, the bytes answered all the same), the
  plugin never puts what it fetched. `get(id, name, { fetch: false })` asks nobody. The bytes are never pushed ahead of a
  read: an attachment reaches a node when that node reads it.
- **The store is the engine's; the plugin refuses an engine without one.** Every shipped engine keeps `blobs` (memory: a Map;
  IndexedDB: a seventh store, VERSION 2; files: `blobs/<digest>` as base64 text; SQLite: a table; MongoDB: a collection) and
  says so in `capabilities.blobs`; the read-only wrapper reads them, the at-rest wrapper seals them as text at the blob's
  place (the digest a name, in the clear), the remote engine proxies them (a Uint8Array crosses the port), `copyEngine`
  copies them one by one. `setup()` throws a TypeError where `db.blobs` is absent — the plugin is not in `/all`, so a
  database over an engine without blobs opens as before.
- **Compression is the plugin's, said on the register.** `attachments({ compression })` stores the compressed bytes, whose
  digest is the blob's, with `encoding` on the register and `length` the plain length; `get` inflates by what the register
  says — and only as far as it says (`inflate(stored, encoding, limit)`) — so a node without the option reads what a node
  with it wrote, and a register cannot make a node inflate past its own word.
