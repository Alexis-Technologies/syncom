# Wire format

What travels between two nodes and what lies on disk, byte by byte: the op
and its eighteen slots, the payload of every type, what a signature covers,
the log and record files, the four procedures and the presence event, the
bounds a node holds a peer to, and what may change without breaking a peer.
Every example on this page was run against the package as it is
(`@alexify/syncom/all` over `memory()`); node ids, signatures and digests
are shortened to fit. The concepts are in [Sync](../guide/sync); this page
is the shape.

## The op

Every write is one op, a plain JSON object:

```
{ origin, seq, ts, type, id?, scope?, data?, meta?, key?, value?, vector?, from?, v?, actor?, sig?, digest?, nonce?, msg? }
```

| Field | Type | Meaning |
| --- | --- | --- |
| `origin` | string | The node that made it — its Ed25519 public key (43 base64url characters, canonical last character) when the node signs, else its `getId()` id; a stream name: 1 to 128 characters, no `@`, no control character |
| `seq` | integer ≥ 1 | Its sequence number on that origin, per scope: the vector key is `origin@scope` (`origin` alone for the global scope `*`), and the ops born of a snapshot run in `origin@~` |
| `ts` | integer ≥ 1 | `Date.now()` when made, never below a stamp the node had seen |
| `type` | string | One of the fifteen below |
| `id` | string | The record, `[A-Za-z0-9_@-][A-Za-z0-9._@-]{0,127}` — a file name on three platforms; every type but `advance` has one |
| `scope` | string | The record's scope as the writer read it; absent in the global scope |
| `data` | object | A `write`'s or `set`'s fields; a `merge`'s record data |
| `meta` | object | A `merge`'s metadata (the shape under [The record file](#the-record-file)) |
| `key` | string | A field op's field — a name, or a path of names joined by `/` (at most 16 segments, 512 characters) |
| `value` | any | A field op's argument, by type |
| `vector` | object | An `advance`'s version vector |
| `from` | string | The node whose snapshot a `merge`/`advance` joined — a claim, carried as is |
| `v` | integer ≥ 1 | The writer's schema version; absent without a schema and on `merge`/`advance` |
| `actor` | string | Who made it, as the writer claims — signed, never verified |
| `sig` | string | 86 base64url characters: the Ed25519 signature of the [header](#what-a-signature-covers) |
| `digest` | string | 64 hex characters: sha256 of the nonce and the canonical payload |
| `nonce` | string | 16 to 64 base64url characters (a UUID, as written); gone with the payload when the op is scrubbed |
| `msg` | string | A transaction's message, at most 1 024 characters, on every op of the transaction, signed |

`origin`, `seq`, `ts`, `type`, `scope`, `v`, `id` (or an `advance`'s
`vector`), `sig`, `digest`, `nonce` and `msg` are checked by shape before a
peer's op is read at all (`wellFormed` in `src/shape.js`); one that fails
is `malformed` — counted, not logged, not relayed, a gap in its stream. A
stamp more than `sync.maxSkew` (24 hours) ahead of the receiver's clock is
refused the same way (`SKEW`). The payload fields are checked where they
land: an op the engine does not admit changes nothing, is reported as
`OP_REFUSED` with `reason: 'malformed'`, and is still logged and relayed.

### Types and payloads

| `type` | Code | Carries | Payload |
| --- | --- | --- | --- |
| `write` | `w` | `data` | The whole record; fields not written are gone |
| `set` | `s` | `data` | The fields to set; last writer wins per field by `(ts, origin)` |
| `unset` | `u` | `value` | `string[]` — the fields to remove, as names or paths |
| `inc` | `i` | `key`, `value` | A finite number to add to the counter |
| `add` | `+` | `key`, `value` | `unknown[]` — the elements to add to the set |
| `remove` | `-` | `key`, `value` | `[element, { origin: addStamp }][]` — each element with the add stamps this node had seen for it |
| `splice` | `/` | `key`, `value` | `{ cut?, at \| run + from, content, vals? }` — see [What travels](../guide/lists#what-travels) |
| `assign` | `=` | `key`, `value` | `{ elem, value, k? }` — `k: 't'` when the element is a text's embed slot |
| `move` | `^` | `key`, `value` | `{ elem, cut, at, value }` |
| `mark` | `*` | `key`, `value` | `{ start, end, key, value, many? }` or `{ off }` |
| `tree` | `~` | `key`, `value` | `{ node, parent, fi }` — `parent` `null` at the root, `$trash` removed; `fi` a fractional index |
| `delete` | `d` | — | A tombstone; a newer write revives the record |
| `purge` | `p` | — | Wins at any stamp; every entry of the id is scrubbed |
| `merge` | `m` | `data`, `meta`, `from` | A snapshot record joined |
| `advance` | `a` | `vector`, `from` | Which ops the joined state covers |

The codes are the protocol's, not a plugin's: a node without the text or
tree plugin still reads, logs and relays a `/` or a `~`. One op of each,
as the log keeps them (the `write` and the `purge` of `p2` are scrubbed —
the payload and the nonce gone, the header and its signature kept):

```json
{"seq":1,"op":{"origin":"-PlUD3E…","seq":1,"ts":1792951837466,"type":"write","id":"p1","v":1,"data":{"title":"Draft","note":"tmp","$type":"Post"},"nonce":"718f22bc-…","digest":"e06a7085…","sig":"TwB74Pp…"}}
{"seq":2,"op":{"origin":"-PlUD3E…","seq":2,"ts":1792951837469,"type":"set","id":"p1","v":1,"data":{"title":"Final"},"nonce":"d2baa276-…","digest":"08631891…","sig":"0Ee9Kg2…"}}
{"seq":3,"op":{"origin":"-PlUD3E…","seq":3,"ts":1792951837470,"type":"unset","id":"p1","v":1,"value":["note"],"nonce":"dcfd2b33-…","digest":"685fba58…","sig":"LmGK0_t…"}}
{"seq":4,"op":{"origin":"-PlUD3E…","seq":4,"ts":1792951837471,"type":"inc","id":"p1","v":1,"key":"views","value":1,"nonce":"ac56d761-…","digest":"d4171987…","sig":"aPqM54G…"}}
{"seq":5,"op":{"origin":"-PlUD3E…","seq":5,"ts":1792951837472,"type":"add","id":"p1","v":1,"key":"tags","value":["bug"],"nonce":"e024f81c-…","digest":"33bd5500…","sig":"aAzk3Ls…"}}
{"seq":6,"op":{"origin":"-PlUD3E…","seq":6,"ts":1792951837473,"type":"remove","id":"p1","v":1,"key":"tags","value":[["bug",{"-PlUD3E…":1792951837472}]],"nonce":"ead127da-…","digest":"9efaa838…","sig":"5GpYEPv…"}}
{"seq":7,"op":{"origin":"-PlUD3E…","seq":7,"ts":1792951837474,"type":"splice","id":"p1","v":1,"key":"body","value":{"content":"hello","at":"^"},"nonce":"831b7f99-…","digest":"ef743b75…","sig":"5bA9z39…"}}
{"seq":8,"op":{"origin":"-PlUD3E…","seq":8,"ts":1792951837475,"type":"splice","id":"p1","v":1,"key":"items","value":{"content":[1,2],"at":"^"},"nonce":"f108f26b-…","digest":"2ec8be5f…","sig":"UCF0DuJ…"}}
{"seq":9,"op":{"origin":"-PlUD3E…","seq":9,"ts":1792951837476,"type":"assign","id":"p1","v":1,"key":"items","value":{"elem":"1792951837475:0:-PlUD3E…","value":9},"nonce":"5d134186-…","digest":"4111c993…","sig":"itDHNzN…"}}
{"seq":10,"op":{"origin":"-PlUD3E…","seq":10,"ts":1792951837477,"type":"move","id":"p1","v":1,"key":"items","value":{"elem":"1792951837475:0:-PlUD3E…","cut":["1792951837475:-PlUD3E…",0,1],"at":">1792951837475:1:-PlUD3E…","value":9},"nonce":"8c6bf9a5-…","digest":"c741b2be…","sig":"MUz3ZG8…"}}
{"seq":11,"op":{"origin":"-PlUD3E…","seq":11,"ts":1792951837478,"type":"mark","id":"p1","v":1,"key":"body","value":{"start":"<1792951837474:0:-PlUD3E…","end":"$","key":"bold","value":true},"nonce":"e7fe7c62-…","digest":"1d0798d6…","sig":"nmWkL0k…"}}
{"seq":12,"op":{"origin":"-PlUD3E…","seq":12,"ts":1792951837479,"type":"tree","id":"p1","v":1,"key":"outline","value":{"node":"n1","parent":null,"fi":"V"},"nonce":"9738cc33-…","digest":"bad306da…","sig":"PSEOFN3…"}}
{"seq":13,"op":{"origin":"-PlUD3E…","seq":13,"ts":1792951837480,"type":"set","id":"p1","v":1,"actor":"ada","data":{"n":1},"msg":"one more","nonce":"29fcc8f5-…","digest":"e6755bd6…","sig":"b6QdTUG…"}}
{"seq":14,"op":{"origin":"-PlUD3E…","seq":14,"ts":1792951837481,"type":"delete","id":"p1","v":1,"sig":"IbCEZRb…"}}
{"seq":15,"op":{"origin":"-PlUD3E…","seq":15,"ts":1792951837482,"type":"write","id":"p2","v":1,"digest":"ab6b6659…","sig":"uhwRs9F…"},"scrubbed":true}
{"seq":16,"op":{"origin":"-PlUD3E…","seq":16,"ts":1792951837483,"type":"purge","id":"p2","v":1,"sig":"hw4ptYo…"},"scrubbed":true}
```

An element's name is `ts:offset:origin` — the run it was inserted in and
its offset there — and a run's `ts:origin`; an anchor is `^` (the head),
`$` (the end, in a mark), `>e` or `<e` (the right or left child of element
`e`); a cut is `[run, offset, length]`. A `remove`'s add stamp is the `ts`
of the `add` this node had seen, per origin.

### Packed: the eighteen slots

A push and a `changes` page carry ops packed — one positional array per
op, the type as its code, `null` for an absent field, no key names
repeated per op:

| Slot | Field | Slot | Field | Slot | Field |
| --- | --- | --- | --- | --- | --- |
| 1 | `origin` | 7 | `data` | 13 | `v` |
| 2 | `seq` | 8 | `meta` | 14 | `actor` |
| 3 | `ts` | 9 | `key` | 15 | `sig` |
| 4 | `type` (code) | 10 | `value` | 16 | `digest` |
| 5 | `id` | 11 | `vector` | 17 | `nonce` |
| 6 | `scope` | 12 | `from` | 18 | `msg` |

The ops above, packed (`packOps` in `src/ops.js`; `unpackOps` is the way
back, and takes a row of fewer than five slots as nothing):

```json
["-PlUD3E…",1,1792951837466,"w","p1",null,{"title":"Draft","note":"tmp","$type":"Post"},null,null,null,null,null,1,null,"TwB74Pp…","e06a7085…","718f22bc-…",null]
["-PlUD3E…",4,1792951837471,"i","p1",null,null,null,"views",1,null,null,1,null,"aPqM54G…","d4171987…","ac56d761-…",null]
["-PlUD3E…",7,1792951837474,"/","p1",null,null,null,"body",{"content":"hello","at":"^"},null,null,1,null,"5bA9z39…","ef743b75…","831b7f99-…",null]
["-PlUD3E…",13,1792951837480,"s","p1",null,{"n":1},null,null,null,null,null,1,"ada","b6QdTUG…","e6755bd6…","29fcc8f5-…","one more"]
["-PlUD3E…",14,1792951837481,"d","p1",null,null,null,null,null,null,null,1,null,"IbCEZRb…",null,null,null]
["-PlUD3E…",16,1792951837483,"p","p2",null,null,null,null,null,null,null,1,null,"hw4ptYo…",null,null,null]
```

Slots were appended in this order — `v` was the thirteenth, `actor` the
fourteenth, the signature's three the fifteenth to seventeenth, `msg` the
eighteenth — and are never reordered: a reader of fewer slots ignores the
rest, a reader of more takes an absent slot as `null`. The log itself keeps
the keyed form; packing is for the wire.

## What a signature covers

A signing node (the `signing` plugin, registered by `@alexify/syncom/all`)
signs every op of its own before the append, in three parts:

1. **The payload** — `data`, `meta`, `key`, `value`, `vector`, whichever the
   op carries, as one object — serialized canonically (every object's keys
   sorted at every depth, `canonical` in `src/shape.js`), salted with a
   fresh `nonce` and hashed: `digest = sha256(nonce + "\n" + canonical)`.
   An op without a payload (a `delete`, a `purge`) has no digest and no
   nonce.
2. **The header** — a positional JSON array under a version number, `null`
   for an absent field:
   `[1, origin, seq, ts, type, id, scope, from, v, actor, digest, msg]`.
3. **The signature** — Ed25519 over the header's text, as 86 base64url
   characters in `sig`. The key is the origin: the node id *is* the public
   key.

The `set` op above, taken apart:

```
header     [1,"-PlUD3E…",2,1792951837469,"set","p1",null,null,1,null,"086318918f6cf9a1795b783e3d51f5416cbb559ef9b013a95487643fd7570039",null]
canonical  {"data":{"title":"Final"}}
nonce      d2baa276-c812-4339-9f2e-2158bfdfbbc6
digest     086318918f6cf9a1795b783e3d51f5416cbb559ef9b013a95487643fd7570039
```

A receiver verifies before it applies: an origin that is no key, a payload
its digest does not match, a digest with no nonce, a nonce with no payload,
or a signature that does not verify is `forged` and a gap in the stream;
an unsigned op is taken under `sync.signatures: 'verify'` (the default) and
refused under `'require'`. The split is what lets a `purge` scrub the
payload and the nonce and leave an op whose header still verifies — the
`write` of `p2` above — and the nonce is what keeps a scrubbed digest from
giving a short payload away by brute force. A signature binds authorship
and content to the origin's key through any relay; it proves nothing about
delivery, and `actor` stays the origin's claim.

## The log

Under `<path>/log/`, over the backend's five functions (whole-file read and
write, no rename):

| File | Holds |
| --- | --- |
| `open/<seq>-<token>.jsonl` | A journal, where the backend has `append`: one log file per line, a line per group of appends; named by its first seq (ten digits zero-padded) and a token unique to the open and the journal; begun again at every roll and after a failed append, removed once every group in it is sealed, rewritten only by a scrub |
| `open/<seq>.json` | A group in a file of its own, where the backend has no `append`; named by its first seq |
| `seg-<from>.json` | A sealed segment: the open groups rolled together once 64 of them accumulate (`log.rollAfter`) |
| `index.json` | `{ epoch, floor, next, vector, segments, droppedHeld, latestTs, droppedTs }` — a summary; the files are the truth, and what the index lacks is rebuilt from a listing |

Every log file is `{ "entries": [...], "hash": "<xxh32>" }` — the
entries' JSON and its xxHash32 as eight hex characters, computed over the
same text. A file whose hash does not match is unreadable at open
(`log.segment.unreadable`, `reason: 'checksum'`, counted in
`stats().log.corrupt`); a file without a hash, from before checksums, is
taken as it is.

A journal is read line by line, each line a log file of its own. Its last
line is the one a crash can tear — its group was never acknowledged — and is
left out (`log.open.torn`); a line before it that does not read was
acknowledged once and is lost (`log.open.unreadable`, counted in `droppedTs`).
The open files are read newest name first, and the first copy of a seq read
is the one kept: a group whose append failed after its line landed gave its
seqs back, and the group that took them went to a newer journal. A later open
never appends to an older journal.

```json
{"entries":[{"seq":2,"op":{"origin":"-PlUD3E…","seq":2,"ts":1792951837469,"type":"set","id":"p1","v":1,"data":{"title":"Final"},"nonce":"d2baa276-…","digest":"08631891…","sig":"0Ee9Kg2…"}}],"hash":"38727f2a"}
```

An entry is `{ seq, op }`, plus `skipped: true` for a peer's op a
`beforeApply` hook or a validator declined (accepted into the log, never
applied here, so a reopen does not apply it either), `held: <version>` for
an op of a newer schema version kept for the node that runs it, and
`scrubbed: true` once a purge took its payload. The index after a clean
close, with the sixteen ops sealed into one segment:

```json
{"epoch":"mvo58q1gu75ziu","floor":1,"next":17,"vector":{"W_Ym_o9…":16},"segments":[{"name":"seg-0000000001.json","from":1,"to":16,"count":16}],"droppedHeld":0,"latestTs":1792951855847,"droppedTs":0}
```

An **event id** is `<epoch>.<seq>` — `mvo58q1gu75ziu.16` — the epoch
minted once when the log is created, so a cursor from a wiped or restored
directory is told to bootstrap rather than fed a coincidence. `floor` is
the lowest seq retained: below it, or under another epoch, a resume is
refused. The log keeps at least `sync.retention.ops` ops (10 000; `'all'`
keeps everything) and drops whole segments from the front past that, while
its own unacknowledged ops and the segments a reader pins stay.

## The record file

`<path>/data/<id>.json`, written after the append (or within `defer`
milliseconds of it, 16 by default):

```json
{"data":{"title":"Final","$type":"Post","views":1,"tags":[],"body":"hello","items":[2,9],"outline":[{"id":"n1","children":[]}],"n":1},
 "meta":{"clock":{"title":[1792951855656,"VTwt7hZ…"],"$type":[1792951855653,"VTwt7hZ…"],"n":[1792951855667,"VTwt7hZ…"]},
         "base":[1792951855653,"VTwt7hZ…"],"deleted":null,
         "counters":{"views":{"VTwt7hZ…":[4,1,1792951855658]}},
         "sets":{"tags":{"\"bug\"":{"VTwt7hZ…":[1792951855659,1792951855659]}}},
         "blocks":{"body":{"k":"t","ts":1792951855665,"runs":{"1792951855661:VTwt7hZ…":["^",["hello"]]},"marks":{"1792951855665:VTwt7hZ…":["<1792951855661:0:VTwt7hZ…","$","bold",true,0]}},
                   "items":{"k":"l","ts":1792951855664,"runs":{"1792951855662:VTwt7hZ…":["^",[1,[2]]],"1792951855664:VTwt7hZ…":[">1792951855662:1:VTwt7hZ…",[[9]],"1792951855662:0:VTwt7hZ…"]},"pos":{"1792951855662:0:VTwt7hZ…":[1792951855664,"VTwt7hZ…","1792951855664:VTwt7hZ…"]},"vals":{"1792951855662:0:VTwt7hZ…":[1792951855663,"VTwt7hZ…",9]}},
                   "outline":{"k":"tree","ts":1792951855666,"moves":{"n1":[[1792951855666,"VTwt7hZ…",null,"V"]]}}},
         "gone":{"note":[1792951855657,"VTwt7hZ…"]},"v":1},
 "encrypted":false,"timestamp":1792951855665,"block":"16219399…"}
```

`data` is the record as the op model reads it — a counter as its sum, a
set as its sorted elements, a text as its string, a list as its array, a
tree as nested `{ id, data?, children }` — and `meta` is what makes it
merge:

| `meta` | Shape |
| --- | --- |
| `clock` | Per register field, its stamp `[ts, origin]` |
| `base` | The record's reset watermark: the stamp of its last whole-record write, delete or purge |
| `deleted` | The tombstone's stamp, or `null` |
| `purged` | The purge's stamp, once purged — nothing but another purge or a merge lands after it |
| `counters` | Per field, per origin, `[seq, sum, ts]` — the origin's running sum, within ±2⁵³ |
| `sets` | Per field, per element (its canonical JSON as the key), per origin, `[added, removed]` stamps; live while `added > removed` |
| `blocks` | Per list, text or tree field, the kind plugin's block under its code `k` — `t` text, `l` list, `tree` — with the block's `ts`; a text's or list's `runs` (`[anchor, content, extendedFrom?]` per `ts:origin`), `cuts`, `ext`, `pos`, `vals`, `marks`, `pending`; a tree's `moves` (`[ts, origin, parent, fi]` per node) |
| `gone` | Per field removed by `unset`, the stamp of the removal — a register's tombstone an older `set` loses to |
| `v` | The schema version of the last whole-record write |

A peer's `meta` is never trusted as it comes: a snapshot's is rebuilt into
this shape key by key (`normalizeMeta` in `src/ops.js`), own keys only,
each block through its plugin under the node's bounds, anything else
dropped. The block layouts are the headers of `src/text/sequence.js` and
`src/tree/moves.js`.

`block` names the chain block that committed the write, when the `chain`
plugin runs: under `<path>/blockchain/`, each block is `{ prev, timestamp,
data }` in a file named by its sha256, `prev` the hash of the block before
it (`'0'` for the first), `data` the record's id and the sha256 of its data
as written and `from`, the op's event id (a peer's batch names every record
it touched), and `.blockchain.json` holds `{ tailHash }`:

```json
{"prev":"4eaa96b4…","timestamp":1792951855843,"data":{"id":"p1","hash":"44136fa3…","from":"mvo58q1gu75ziu.14"}}
```

A cold read of a record file is checked against its block; a mismatch is
an integrity failure, never repaired on read.

The rest of a directory: `node.json` `{ id, plugins }` (the node's id and
the kind plugins it was opened with), `keys/sign-public.pem` and
`keys/sign-private.pem` (the Ed25519 pair the id is), `keys/public.pem` and
`keys/private.pem` (the RSA pair that seals an encrypted record),
`schema.json`, `lock.json`, `index/catalog.json` (`{ format: 3, indexes,
stamp, rows }` — derived, rebuilt when stale), `tags/`.

## The procedures

A host mounts `storage.sync.unit()` as a wrpc router unit named `syncom`;
a dialer calls `syncom/hello`, `syncom/push`, `syncom/snapshot` and
subscribes to `syncom/changes`. Arguments and answers are JSON. A refusal
is an error with a numeric `code` (what wrpc carries) and a `reason`
naming the check.

### `hello`

```
→ { node, version: 1, vector, scopes, token?, schema, kinds }
← { node, vector, epoch, version: 1, schema, kinds, duplicate? }
```

`vector` is the caller's whole version vector; `scopes` the scopes it
asks to be held to (`['*']` for all); `token` its registered credential,
for the host's `authorize`; `schema` `{ version, hash }` or `null`; `kinds`
the names of the kind plugins it runs. The answer, from the run above:

```json
{"node":"W_Ym_o9…","vector":{"W_Ym_o9…":16},"epoch":"mvo58q1gu75ziu","version":1,"schema":{"version":1,"hash":null},"kinds":["text","tree"]}
```

| Code | `reason` | When |
| --- | --- | --- |
| 400 | `BAD_HELLO` | No `node` |
| 400 | `PROTOCOL` | `version` is not this host's |
| 409 | `SELF` | The caller's node id is the host's — a copied directory |
| 403 | `UNSIGNED` | The host requires signatures and the node id is no key |
| 403 | `UNAUTHORIZED` | `authorize(context, hello)` said no |

### `push`

```
→ { ops: [packed…] }
← { vector, applied, skipped, duplicates, gaps, malformed, unsigned, forged, outOfScope }
```

`vector` carries the keys the page touched, not the host's whole vector.
An op outside the scopes hello granted is refused before anything reads it
(`outOfScope`), and so is one whose record the host reads as outside them.

| Code | `reason` | When |
| --- | --- | --- |
| 428 | `HELLO_FIRST` | No hello on this connection — the ordinary course of a reconnect |
| 413 | `OPS_PER_PUSH` / `BYTES_PER_PUSH` | Over `unit({ limits })` |
| 429 | `OPS_PER_SECOND` | The peer's token bucket is empty |

### `snapshot`

```
→ { cursor: null | lastId, scopes? }
← { records: [{ id, data, meta }…], cursor: null | lastId, eventId, vector? }
```

Records in id order, tombstones included, each with its `meta`; `cursor`
is the last id of the page and `null` when the page is the last; `vector`
rides on the first page only. On a binary-capable transport a page under
`pageBytes` (4 MiB) goes as a wrpc stream of NDJSON — one record per line
— and the answer is `{ id, size, cursor, eventId, vector? }`, `id` the
stream to read. `scopes` narrows what hello granted (403 `SCOPES` when
nothing of what is asked was granted).

### `changes`

```
→ { scopes? }   with the subscription's lastEventId
← { ops: [packed…], eventId }   tracked by eventId — or { bootstrap: true }
```

A subscription. Each page is labelled with the host's log position through
wrpc's `tracked` shape (`Symbol.for('wrpc.tracked')`, `{ id, data }`), so a
resume from the last id replays exactly what was missed; the ops are the
host's log from the cursor on, in the scopes asked for, less the
subscriber's own and what came from it. `{ bootstrap: true }` ends the
feed when the cursor cannot be resumed — another epoch, or compacted past
it — and the dialer pages `snapshot` instead.

### The presence event

`syncom/presence` is a fire-and-forget event in both directions — the
unit's `on.presence` inbound, the host's room outbound — never a procedure,
never logged:

```json
{"p":1,"scope":"*","s":[["W_Ym_o9…",1,1792951855847,{"name":"ada","cursor":{"id":"p1","field":"body","index":3}},"n4O8uuV…"]]}
```

`p` is the format, `s` one entry per node: `[node, clock, ts, state, sig?]`
— the node's own counter (the newest wins), its stamp, a JSON object (at
most 16 KiB, 64 keys, 8 deep) or `null` for a leave, and the Ed25519
signature of `[1, node, clock, ts, canonical(state)]` when the node signs.
At most 1 024 entries. A host takes an update that is the peer's own
(every entry its node), of a scope it asked for, within `rate` a second
(20), signed under `'require'`; else refuses it — 428 `HELLO`, 429
`PRESENCE_RATE`, 400 `PRESENCE_MALFORMED`, 403 `PRESENCE_SCOPE`,
`PRESENCE_FORGED`, `PRESENCE_UNSIGNED` — counted, announced, never
relayed. What passes goes to the room `syncom:<scope>` but the sender, and
into the host's memory of the room (`max` 1 024 states per scope, for
`timeout` ms, 30 000), which a newcomer is sent at hello.

## Bounds

What a node holds a peer to, on the op path and in a snapshot alike —
a snapshot buys nothing an op could not:

| Bound | Value | Over it |
| --- | --- | --- |
| Record id | 1 to 128 characters of `[A-Za-z0-9._@-]`, not starting with `.` | `malformed` |
| Stream name (`origin`, `scope`) | 1 to 128 characters, no `@`, no control character | `malformed` |
| Field path | 16 segments, 512 characters, no empty segment, no `__proto__` | refused |
| Fields per record | 4 096 paths; the first in sorted order stay | `OP_REFUSED` `detail: 'paths'` |
| `msg` | 1 024 characters | `malformed` |
| Stamp ahead of the receiver | `sync.maxSkew`, 24 hours | `SKEW` |
| A counter's sum per origin | ±2⁵³ − 1 | `OP_REFUSED` `detail: 'counter'` |
| A run's length | 2²⁰ elements | `OP_REFUSED` `detail: 'run'` |
| Pending ops per block | `sync.pendingMax`, 4 096 | `OP_REFUSED` `detail: 'pending'` |
| A tree's depth read, a fractional index | 512 levels, 1 024 characters | the deeper levels unread; `malformed` |
| Ops per push, bytes per push, ops per second | `unit({ limits })`, none by default | 413, 429 |
| Records per snapshot page, ops per `changes` page | `unit({ pageSize })`, 500 | — |
| Presence state | 16 KiB, 64 keys, 8 deep; 1 024 entries per update; 20 updates a second | refused |

## Compatibility

`hello` carries `version: 1` both ways, and a host answers another version
with 400 `PROTOCOL`. Version 1 is the wire as the first publication will
have it: the fifteen types and the eighteen slots above, the header under
its version number `1`, the log file with its hash, the presence format
`p: 1`. Before that publication the shapes on this page may change
without a bump; after it:

- **A slot is appended, never reordered or removed.** A reader of fewer
  slots ignores the rest; a reader of more takes an absent slot as `null`.
  A new slot an older reader could not take as `null` is a new version.
- **A new op type is a new version.** An older reader counts an unknown
  type as `malformed`, and the stream that carries it stops there.
- **A new field of an op, a procedure's argument or answer, or a presence
  entry is optional** — absent reads as before.
- **A file format gains fields, never loses them**: a log file without a
  hash, an index without a field, a record file without a block are read.
- **The header's version number** (`1`) and the digest's construction
  change only with a new version.
- **A version bump is a major release** of the package; an appended slot
  or an optional field is a minor one.

The symbols of the transport — the `tracked` shape, streams, rooms — are
wrpc's frozen wire protocol, not this page's.
