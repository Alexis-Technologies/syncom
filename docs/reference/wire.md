# Wire format

What travels between two nodes and what lies on disk, byte by byte: the op
and its nineteen slots, the payload of every type, what a signature covers,
the per-stream chain, the log and record files, the four procedures and the
presence event, the bounds a node holds a peer to, and what may change
without breaking a peer.
Every example on this page was run against the package as it is
(`@alexify/syncom/all` over `memory()`); node ids, signatures and digests
are shortened to fit. The concepts are in [Sync](../guide/sync); this page
is the shape.

## The op

Every write is one op, a plain JSON object:

```
{ origin, seq, ts, type, id?, scope?, data?, meta?, key?, value?, vector?, from?, v?, actor?, sig?, digest?, nonce?, msg?, prev? }
```

| Field | Type | Meaning |
| --- | --- | --- |
| `origin` | string | The node that made it — its Ed25519 public key (43 base64url characters, canonical last character; a point of small order or a y past the prime is no key — no one holds its private half — and an op signed under one is forged) when the node signs, else its `getId()` id; a stream name: 1 to 128 characters, no `@`, no control character |
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
| `digest` | string | 43 base64url characters (canonical last character): SHA-256 of the nonce and the canonical payload |
| `nonce` | string | 16 to 64 base64url characters (a UUID, as written); gone with the payload when the op is scrubbed |
| `msg` | string | A transaction's message, at most 1 024 characters, on every op of the transaction, signed |
| `prev` | string | 43 base64url characters: the [fingerprint](#the-per-stream-chain) of the op before it in its stream, signed; absent on a stream's first op, and where the writer holds no op before it |

`origin`, `seq`, `ts`, `type`, `scope`, `v`, `id` (or an `advance`'s
`vector`), `sig`, `digest`, `nonce`, `msg` and `prev` are checked by shape, and every
field by how deep it nests (80 levels, `MAX_WIRE_DEPTH`), before a peer's op
is read at all — its signature included (`wellFormed` in `src/shape.js`); one
that fails is `malformed` — counted, not logged, not relayed, a gap in its
stream. A stamp more than `sync.maxSkew` (24 hours) ahead of the receiver's
clock — the op's `ts`, or any stamp a `merge`'s `meta` holds — is refused the
same way (`SKEW`). The payload fields are checked where they land: an op the
engine does not admit changes nothing, is reported as `OP_REFUSED` with
`reason: 'malformed'`, and is still logged and relayed.

### Types and payloads

| `type` | Code | Carries | Payload |
| --- | --- | --- | --- |
| `write` | `w` | `data` | The whole record; fields not written are gone |
| `set` | `s` | `data` | The fields to set; last writer wins per field by `(ts, origin)` |
| `unset` | `u` | `value` | `string[]` — the fields to remove, as names or paths |
| `inc` | `i` | `key`, `value` | A finite number to add to the counter |
| `add` | `+` | `key`, `value` | `unknown[]` — the elements to add to the set |
| `remove` | `-` | `key`, `value` | `[element, { origin: addStamp }][]` — each element with the add stamps this node had seen for it |
| `splice` | `/` | `key`, `value` | `{ cut?, at \| run + from, content, vals? }` — `run + from` extends the writer's own run, never a move's position run (malformed); see [What travels](../guide/lists#what-travels) |
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
{"seq":1,"op":{"origin":"VLH7Ywu…","seq":1,"ts":1793087684840,"type":"write","id":"p1","v":1,"data":{"$type":"Post","title":"Draft","note":"tmp"},"nonce":"55b902dd-…","digest":"pNpYxfs6…","sig":"YE3frhE…"},"fp":"SmNVKTkH…"}
{"seq":2,"op":{"origin":"VLH7Ywu…","seq":2,"ts":1793087684846,"type":"set","id":"p1","v":1,"data":{"title":"Final"},"prev":"SmNVKTkH…","nonce":"1258f80d-…","digest":"CY61ahM3…","sig":"hEvgr7g…"},"fp":"3GmlODml…"}
{"seq":3,"op":{"origin":"VLH7Ywu…","seq":3,"ts":1793087684849,"type":"unset","id":"p1","v":1,"value":["note"],"prev":"3GmlODml…","nonce":"5813af09-…","digest":"aW5z0E8A…","sig":"1wiJRzm…"},"fp":"UuNQx9vT…"}
{"seq":4,"op":{"origin":"VLH7Ywu…","seq":4,"ts":1793087684852,"type":"inc","id":"p1","v":1,"key":"views","value":1,"prev":"UuNQx9vT…","nonce":"00a3ef68-…","digest":"4nQUrOQo…","sig":"se88RPf…"},"fp":"VY9jdnUE…"}
{"seq":5,"op":{"origin":"VLH7Ywu…","seq":5,"ts":1793087684855,"type":"add","id":"p1","v":1,"key":"tags","value":["bug"],"prev":"VY9jdnUE…","nonce":"3887133a-…","digest":"vDdi0F3k…","sig":"us6GHE9…"},"fp":"q49yF0IJ…"}
{"seq":6,"op":{"origin":"VLH7Ywu…","seq":6,"ts":1793087684858,"type":"remove","id":"p1","v":1,"key":"tags","value":[["bug",{"VLH7Ywu…":1793087684855}]],"prev":"q49yF0IJ…","nonce":"6556dcfe-…","digest":"SjDF-Rzq…","sig":"WXfaw6w…"},"fp":"9z2V-22e…"}
{"seq":7,"op":{"origin":"VLH7Ywu…","seq":7,"ts":1793087684861,"type":"splice","id":"p1","v":1,"key":"body","value":{"content":"hello","at":"^"},"prev":"9z2V-22e…","nonce":"0438623a-…","digest":"e8xPy71S…","sig":"fldcPee…"},"fp":"HEbXDRV7…"}
{"seq":8,"op":{"origin":"VLH7Ywu…","seq":8,"ts":1793087684866,"type":"splice","id":"p1","v":1,"key":"items","value":{"content":[1,2],"at":"^"},"prev":"HEbXDRV7…","nonce":"be90dd02-…","digest":"rRDJp_Dt…","sig":"IUE0qCZ…"},"fp":"guFO1EOS…"}
{"seq":9,"op":{"origin":"VLH7Ywu…","seq":9,"ts":1793087684869,"type":"assign","id":"p1","v":1,"key":"items","value":{"elem":"1793087684866:0:VLH7Ywu…","value":9},"prev":"guFO1EOS…","nonce":"94a8f651-…","digest":"lpwSpgyW…","sig":"LUGj4mI…"},"fp":"chF-Ks1c…"}
{"seq":10,"op":{"origin":"VLH7Ywu…","seq":10,"ts":1793087684872,"type":"move","id":"p1","v":1,"key":"items","value":{"elem":"1793087684866:0:VLH7Ywu…","cut":["1793087684866:VLH7Ywu…",0,1],"at":">1793087684866:1:VLH7Ywu…","value":9},"prev":"chF-Ks1c…","nonce":"a7e7a486-…","digest":"pn6qODgP…","sig":"3n9P52d…"},"fp":"MqBO8DgA…"}
{"seq":11,"op":{"origin":"VLH7Ywu…","seq":11,"ts":1793087684876,"type":"mark","id":"p1","v":1,"key":"body","value":{"start":"<1793087684861:0:VLH7Ywu…","end":"$","key":"bold","value":true},"prev":"MqBO8DgA…","nonce":"13602c95-…","digest":"aU9shwrn…","sig":"Njs14Zx…"},"fp":"HhhOhsgk…"}
{"seq":12,"op":{"origin":"VLH7Ywu…","seq":12,"ts":1793087684879,"type":"tree","id":"p1","v":1,"key":"outline","value":{"node":"n1","parent":null,"fi":"V"},"prev":"HhhOhsgk…","nonce":"a70b7608-…","digest":"jII5zyZ1…","sig":"DqM2boN…"},"fp":"7vowLgJ6…"}
{"seq":13,"op":{"origin":"VLH7Ywu…","seq":13,"ts":1793087684884,"type":"set","id":"p1","v":1,"actor":"ada","data":{"n":1},"msg":"one more","prev":"7vowLgJ6…","nonce":"7b4cf045-…","digest":"Y-MlFI9f…","sig":"YG0eHAr…"},"fp":"PjeIYmkg…"}
{"seq":14,"op":{"origin":"VLH7Ywu…","seq":14,"ts":1793087684887,"type":"delete","id":"p1","v":1,"prev":"PjeIYmkg…","sig":"yUCV5eu…"},"fp":"ATQP-EcP…"}
{"seq":15,"op":{"origin":"VLH7Ywu…","seq":15,"ts":1793087684890,"type":"write","id":"p2","v":1,"prev":"ATQP-EcP…","digest":"4mS7e6Hf…","sig":"-JJKGYi…"},"fp":"DtsVxUAd…","scrubbed":true}
{"seq":16,"op":{"origin":"VLH7Ywu…","seq":16,"ts":1793087684892,"type":"purge","id":"p2","v":1,"prev":"DtsVxUAd…","sig":"UkSuqji…"},"fp":"vP8rexFG…","scrubbed":true}
```

Each op names the fingerprint of the one before it (`prev`), and the log
keeps each op's own beside it (`fp`): the stream is a hash chain, whole
after the scrub — see [The per-stream chain](#the-per-stream-chain).

An element's name is `ts:offset:origin` — the run it was inserted in and
its offset there — and a run's `ts:origin`; an anchor is `^` (the head),
`$` (the end, in a mark), `>e` or `<e` (the right or left child of element
`e`); a cut is `[run, offset, length]`. A `remove`'s add stamp is the `ts`
of the `add` this node had seen, per origin.

### Packed: the nineteen slots

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
| | | | | 19 | `prev` |

The ops above, packed (`packOps` in `src/wire.js`; `unpackOps` is the way
back, and takes a row of fewer than five slots as nothing):

```json
["VLH7Ywu…",1,1793087684840,"w","p1",null,{"$type":"Post","title":"Draft","note":"tmp"},null,null,null,null,null,1,null,"YE3frhE…","pNpYxfs6…","55b902dd-…",null,null]
["VLH7Ywu…",4,1793087684852,"i","p1",null,null,null,"views",1,null,null,1,null,"se88RPf…","4nQUrOQo…","00a3ef68-…",null,"UuNQx9vT…"]
["VLH7Ywu…",7,1793087684861,"/","p1",null,null,null,"body",{"content":"hello","at":"^"},null,null,1,null,"fldcPee…","e8xPy71S…","0438623a-…",null,"9z2V-22e…"]
["VLH7Ywu…",13,1793087684884,"s","p1",null,{"n":1},null,null,null,null,null,1,"ada","YG0eHAr…","Y-MlFI9f…","7b4cf045-…","one more","7vowLgJ6…"]
["VLH7Ywu…",14,1793087684887,"d","p1",null,null,null,null,null,null,null,1,null,"yUCV5eu…",null,null,null,"PjeIYmkg…"]
["VLH7Ywu…",16,1793087684892,"p","p2",null,null,null,null,null,null,null,1,null,"UkSuqji…",null,null,null,"DtsVxUAd…"]
```

Slots were appended in this order — `v` was the thirteenth, `actor` the
fourteenth, the signature's three the fifteenth to seventeenth, `msg` the
eighteenth, `prev` the nineteenth — and are never reordered: a reader of
fewer slots ignores the rest, a reader of more takes an absent slot as
`null`. The log itself keeps the keyed form; packing is for the wire.

## What a signature covers

Every node links its own ops into their streams before the append (`prev`,
signing or not — `src/header.js`), and a signing node (the `signing` plugin,
registered by `@alexify/syncom/all`) signs them, in three parts:

1. **The payload** — `data`, `meta`, `key`, `value`, `vector`, whichever the
   op carries, as one object — serialized canonically (every object's keys
   sorted at every depth, `canonical` in `src/shape.js`), salted with a
   fresh `nonce` and hashed: `digest = sha256(nonce + "\n" + canonical)`
   (the hash of that text as a JSON string, as 43 base64url characters). An op without a payload (a
   `delete`, a `purge`) has no digest and no nonce.
2. **The header** — a positional JSON array under a version number, `null`
   for an absent field:
   `[1, origin, seq, ts, type, id, scope, from, v, actor, digest, msg, prev]`.
3. **The signature** — Ed25519 over the header's text, as 86 base64url
   characters in `sig`. The key is the origin: the node id *is* the public
   key.

The `set` op above, taken apart:

```
header     [1,"VLH7Ywu…",2,1793087684846,"set","p1",null,null,1,null,"CY61ahM3kCZRiP8NjcNFOKsUj8haWFXCsRxfU8zRjeI",null,"SmNVKTkHmv5uaHCQYAlseskUcAzpyIPphUrGPIcSbZc"]
canonical  {"data":{"title":"Final"}}
nonce      1258f80d-6064-41cb-8e78-cafc70f87074
digest     CY61ahM3kCZRiP8NjcNFOKsUj8haWFXCsRxfU8zRjeI
```

A receiver verifies before it applies: an origin that is no key, a payload
its digest does not match, a digest with no nonce, a nonce with no payload,
or a signature that does not verify is `forged` and a gap in the stream;
an unsigned op is taken under `sync.signatures: 'verify'` (the default) and
refused under `'require'`. The split is what lets a `purge` scrub the
payload and the nonce and leave an op whose header still verifies — the
`write` of `p2` above — and the nonce is what keeps a scrubbed digest from
giving a short payload away by brute force. A signature binds authorship,
content and the op's place in its stream to the origin's key through any
relay; it proves nothing about delivery, and `actor` stays the origin's
claim.

## The per-stream chain

An op's **fingerprint** is the SHA-256 of its header's text, as 43 base64url
characters — `fp` of the `set` above is `3GmlODml…`. It is the same on
every node, signing or not, and whole after a scrub: the header keeps the
digest. A signed op's header carries the digest, so its fingerprint covers
the payload too; an unsigned op's covers the header alone — its stamp, seq,
type and record — so two unsigned ops that differ in payload alone are one
op to it. Every op names the fingerprint of the op before it in its
**stream** (`origin`, `origin@scope`, or `origin@~` for the `merge` and
`advance` ops a bootstrap makes) as `prev` — the `set`'s `prev` is the
`write`'s fingerprint, `SmNVKTkH…` — so a fingerprint covers the whole
stream up to its op: a hash chain per stream, under the signature. A
stream's first op names none, and so does an op whose writer holds no op
at the seq before it.

A node keeps the fingerprint of every op its log retains (`fp`, beside the
op) and, per stream, of the newest op it ever held (`heads` in the
[index](#the-log)), and holds what it is handed to them, after the shape and
the signature:

| A peer's op | Verdict |
| --- | --- |
| at a seq this node holds, with another fingerprint | `EQUIVOCATION`, `reason: 'seq'` |
| the next of its stream, naming another `prev` than the fingerprint held at the seq before it — or none, when it is signed | `EQUIVOCATION`, `reason: 'chain'` |
| the next of its stream, unsigned and naming none — a hand-made op, an older writer's | taken |
| the next of its stream where this node holds no op before it — the stream starts there, or this node joined it by a [snapshot](#snapshot) | taken; the chain is held from it |

An op refused as `EQUIVOCATION` is neither logged nor relayed and the vector
does not move: like a forged op, it is a gap for its stream. It is counted
(`equivocations` in the apply result, `syncom.ops.rejected` with `reason`
`equivocation` or `chain`) and reported once per page — the storage's
`error` event with the op, `origin`, `scope`, `seq`, `reason`, `held` (the
fingerprint this node holds: at the op's seq, or at the one before it) and
`received` (the op's own, or the `prev` it names), and `count`.

What it gives: a writer that made two ops at one seq — a directory restored
from an older copy, a second instance under one identity, a key holder that
lies — is caught at the first node that holds one and is handed the other,
or the next op of the other branch; each node keeps the branch it took
first, and none mixes the two. Under signatures `prev` cannot be changed or
stripped (the op is then `forged`). What it does not: heal the fork — the
nodes that took different branches stay apart, and report it every time they
meet — or check what a node never held: a node that joined a stream by a
snapshot takes its next op as given.

## The log

Under `<path>/log/`, over the backend's five functions (whole-file read and
write, no rename):

| File | Holds |
| --- | --- |
| `open/<seq>-<token>.jsonl` | A journal, where the backend has `append`: one log file per line, a line per group of appends; named by its first seq (ten digits zero-padded) and a token unique to the open and the journal; begun again at every roll and after a failed append, removed once every group in it is sealed, rewritten only by a scrub |
| `open/<seq>.json` | A group in a file of its own, where the backend has no `append`; named by its first seq |
| `seg-<from>.json` | A sealed segment: the open groups rolled together once 64 of them accumulate (`log.rollAfter`) |
| `index.json` | `{ epoch, floor, next, vector, heads, segments, droppedHeld, latestTs, droppedTs }` — a summary; the files are the truth, and what the index lacks is rebuilt from a listing |

Every log file is `{ "entries": [...], "hash": "<xxh32>" }` — the
entries' JSON and its xxHash32 as eight hex characters, computed over the
same text. A file whose hash does not match is unreadable at open
(`log.segment.unreadable`, `reason: 'checksum'`, counted in
`stats().log.corrupt`, its entries lost — `droppedTs`); an open group file
that fails its checksum was whole once, so it is moved to `log/corrupt/`
as the evidence, never deleted; one that does not parse was torn by its
own write, never acknowledged, and is dropped (`log.open.torn`). A file
without a hash, from before checksums, is taken as it is. A file that is
there and cannot be read at all — an I/O error, not a missing file — fails
`open()` with `CORRUPT`: an open that went on without it could hand its
seqs out again.

A journal is read line by line, each line a log file of its own. Its last
line is the one a crash can tear — its group was never acknowledged — and is
left out (`log.open.torn`); a line before it that does not read was
acknowledged once and is lost (`log.open.unreadable`, counted in `droppedTs`).
The open files are read newest name first, and the first copy of a seq read
is the one kept: a group whose append failed after its line landed gave its
seqs back, and the group that took them went to a newer journal. A later open
never appends to an older journal.

```json
{"entries":[{"seq":2,"op":{"origin":"VLH7Ywu…","seq":2,"ts":1793087684846,"type":"set","id":"p1","v":1,"data":{"title":"Final"},"prev":"SmNVKTkH…","nonce":"1258f80d-…","digest":"CY61ahM3…","sig":"hEvgr7g…"},"fp":"3GmlODml…"}],"hash":"9722285a"}
```

An entry is `{ seq, op, fp }` — `fp` the op's [fingerprint](#the-per-stream-chain),
taken when it was logged — plus `skipped: true` for a peer's op a
`beforeApply` hook or a validator declined (accepted into the log, never
applied here, so a reopen does not apply it either), `held: <version>` for
an op of a newer schema version kept for the node that runs it, and
`scrubbed: true` once a purge took its payload. An entry without `fp` is
read; its op is then nothing a chain is held to. The index after a clean
close, with the sixteen ops sealed into one segment — `heads` the stream's
newest op and its fingerprint, kept once the op itself is compacted away:

```json
{"epoch":"mvqe40dinmi2cx","floor":1,"next":17,"vector":{"VLH7Ywu…":16},"heads":{"VLH7Ywu…":[16,"vP8rexFGNozvq4vFd4wYEitJ9-7aoVUnJYyLenq1g8o"]},"segments":[{"name":"seg-0000000001.json","from":1,"to":16,"count":16}],"droppedHeld":0,"latestTs":1793087684892,"droppedTs":0}
```

An **event id** is `<epoch>.<seq>` — `mvqe40dinmi2cx.16` — the epoch
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
| `counters` | Per field, per stream — the op's vector key, `origin` or `origin@scope`, since seqs run per stream — `[seq, sum, ts]`: the stream's running sum, within ±2⁵³; a slot keyed by the bare origin is the global stream's |
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
← { node, vector, epoch, version: 1, schema, kinds, duplicate?, proof? }
```

`vector` is the caller's whole version vector; `scopes` the scopes it
asks to be held to (`['*']` for all); `token` its registered credential,
for the host's `authorize`; `schema` `{ version, hash }` or `null`; `kinds`
the names of the kind plugins it runs.

`proof` is there only when the caller's node id is a signing key and the
host's `vector` holds more of one of the caller's own streams (`node`,
`node@scope`, `node@~`) than the caller's `vector` says — a directory
restored from an older copy. It is the newest op of each such stream the
host's log still retains, packed in the [nineteen slots](#packed-the-nineteen-slots):
the caller's own op at the seq the host claims, signed by the caller's key.
The caller moves a stream past the host's (`REWOUND`) only when that op is
well formed, its origin, stream and seq are the claim's and its signature
verifies under the caller's own key — or under `sync.rewind: 'adopt'`
without it. A host can claim, never prove, what it did not receive. A proven
op's fingerprint is the stream's head from then on: what the caller's next
op of it names as `prev`. The answer, from the run above:

```json
{"node":"VLH7Ywu…","vector":{"VLH7Ywu…":16},"epoch":"mvqe40dinmi2cx","version":1,"schema":{"version":1,"hash":null},"kinds":["text","tree"]}
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
← { vector, applied, skipped, duplicates, gaps, malformed, unsigned, forged, outOfScope, equivocations }
```

`vector` carries the keys the page touched, not the host's whole vector.
An op outside the scopes hello granted is refused before anything reads it
(`outOfScope`), and so is one whose record the host reads as outside them;
one that [equivocates](#the-per-stream-chain) is refused too
(`equivocations`, the host's `refused` event with `reason: 'equivocation'`).

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
| Stamp ahead of the receiver | `sync.maxSkew`, 24 hours — an op's `ts`, every stamp a `merge`'s `meta` holds | `SKEW` |
| How deep a field of an op, or a snapshot record's `data` or `meta`, nests | 80 levels (`MAX_WIRE_DEPTH`; every object or array on the deepest path a level) | `malformed`; a snapshot record left out |
| How deep what a local write takes nests | 64 levels (`MAX_JSON_DEPTH`): the 16 between leave room for what an op and a meta wrap around a value | `TypeError` |
| A seq taken for a node's own stream from a host (`REWOUND`) | 2⁵³ − 1 − 2³² | not taken |
| A counter's sum per stream | ±2⁵³ − 1 | `OP_REFUSED` `detail: 'counter'` |
| A run's length | 2²⁰ elements | `OP_REFUSED` `detail: 'run'` |
| Pending ops per block | `sync.pendingMax`, 4 096 | `OP_REFUSED` `detail: 'pending'` |
| A tree's depth read, a fractional index | 512 levels, 1 024 characters | the deeper levels unread; `malformed` |
| The fold's walk up from a move's parent (`MAX_WALK`) | 512 ancestors | the move is moot, like one that would make a cycle — the same on every node |
| A tree field's moves (`MAX_MOVES`), every node's together | 65 536 | `OP_REFUSED` `detail: 'moves'`; a snapshot block past it is not taken; a join keeps the oldest in the fold's order |
| Ops per push, bytes per push, ops per second | `unit({ limits })`, none by default | 413, 429 |
| Records per snapshot page, ops per `changes` page | `unit({ pageSize })`, 500 | — |
| Presence state | 16 KiB, 64 keys, 8 deep; a stamp no more than 60 s ahead; 1 024 entries per update; 20 updates a second (kept across a repeated hello) | refused — by the receiver and by the host, which keeps and relays nothing it would refuse |
| Scopes a hello asks for | 256, each a stream name or `*`, each once | `BAD_HELLO` |

## Compatibility

`hello` carries `version: 1` both ways, and a host answers another version
with 400 `PROTOCOL`. Version 1 is the wire as the first publication will
have it: the fifteen types and the nineteen slots above, the header under
its version number `1` with `prev` in it, the log file with its hash, the
index with every field it is written with, the `enc1:` ciphertext bound to
its file name, the presence format `p: 1`. Nothing reads a shape from
before that publication: a log file without a hash is unreadable, an index
with a field missing is no index (a new epoch). Before the publication the
shapes on this page may change without a bump; after it:

- **A slot is appended, never reordered or removed.** A reader of fewer
  slots ignores the rest; a reader of more takes an absent slot as `null`.
  A new slot an older reader could not take as `null` is a new version.
- **A new op type is a new version.** An older reader counts an unknown
  type as `malformed`, and the stream that carries it stops there.
- **A new field of an op, a procedure's argument or answer, or a presence
  entry is optional** — absent reads as before.
- **A file format gains fields, never loses them**: a field added after
  version 1 is optional to its reader — a file written without it is read.
- **The header's version number** (`1`), the digest's construction and
  the fingerprint's change only with a new version.
- **A version bump is a major release** of the package; an appended slot
  or an optional field is a minor one.

The symbols of the transport — the `tracked` shape, streams, rooms — are
wrpc's frozen wire protocol, not this page's.
