# Storage

`Storage` is the entry point. `open(options)` returns a promise — key
generation and chain initialisation happen before it resolves. It takes an
options object and nothing else: `open('./data')` is a `TypeError`, as is
any option of the wrong shape, thrown by `open()` itself before anything is
opened.

```js
const { open } = require('@alexify/syncom');

const storage = await open({ path: 'data' });
```

| Option | Default | Meaning |
| --- | --- | --- |
| `path` | `'syncom'` | Directory (or OPFS path) holding keys, chain, data and peers |
| `name` | — | Alias for `path` |
| `fsi` | `node:fs` / OPFS | The backend — any object with `read`, `write`, `exists`, `remove`, `list` (see [Backends](../reference/api#backends)) |
| `durable` | `false` | fsync after every write, where the backend can (`node:fs`); OPFS and memory are as durable as they are |
| `defer` | `16` | Record files may lag the log by this many ms (a non-negative integer; `0` lands every write at once) — the writes of one record within the window coalesce into one file and one block, what typing into a text or a list wants; `flush()` lands them now ([see below](#when-a-record-file-lags-the-log)) |
| `lock` | `'fail'` | One instance per directory: `'fail'` rejects a second `open()` (`code: 'LOCKED'`), `'wait'` waits, `false` leaves it to you ([see below](#one-instance-per-directory)) |
| `cache` | `{ max: 5000 }` | How many entries stay in memory; a live `Record` pins its own ([see below](#the-catalog-and-the-cache)) |
| `integrity` | `'verify'` | `'lazy'` trusts a record file on the cold read instead of re-verifying it against its block |
| `chain` | `true` | `false` keeps no [chain](./chain#through-storage) — a hub that only replicates has nothing to audit; two file writes less per record, reads lazy, `validate()` rejects with `code: 'NO_CHAIN'` |
| `catalog` | `{ flushEvery: 64 }` | The fewest changes between two saves of the record catalog; a large catalog is saved every sixteenth of its size, never more than half the log's retention apart, and the log catches up the rest |
| `actor` | — | Who writes — stamped on every op as `actor`: a string, or a function asked per write ([see Sync](./sync#operations)) |
| `schema` | — | Entity definitions: collections, their validators and indexes ([see below](#collections)); `version` and `snapshot` ([see below](#schema-versions)) |
| `validator` | — | Compiles entity schemas that are plain objects without `~standard` ([see below](#validation)) |
| `search` | — | The text index behind `$text`, asked once per entity with `search` fields — `createSearch()` from `@alexify/syncom/search` ([see Queries](./query#full-text-search)) |
| `getId` | `crypto.randomUUID()` | Id generator for `insert()`; sync or async ([see below](#custom-identifiers)) |
| `logger` | `console` | A Console or pino-shaped logger, or `false` for silence |
| `encrypted` | `false` | Encrypt every record at rest by default ([see below](#encryption-at-rest)) |
| `sync` | — | Replication: `connect`, `scope`, `retention`, `pendingMax`, … — see [Sync](./sync#options) |
| `hooks` | — | `beforeWrite`, `afterRead`, `beforeApply`, … — see [Hooks and events](./hooks) |
| `telemetry` | — | Injected OpenTelemetry: `{ api }` or `{ tracer, meter }` — see [OpenTelemetry](./telemetry) |
| `maxListeners` | `100` | Listeners per event on the storage and its sync manager; one more throws ([see Events](./hooks#events)) |

## The explicit API

Every method addresses a record by its id. `insert()` generates one — a UUID by
default, or whatever `getId` returns.

```js
const id = await storage.insert({ title: 'Draft' });

await storage.has(id);                    // true
await storage.get(id);                    // { title: 'Draft' }
await storage.update(id, { status: 'review' }); // set some fields
await storage.update(id, { status: 'done' }, { actor: 'ada' }); // … and say who
await storage.inc(id, 'views', 1);        // add to a counter field
await storage.add(id, 'tags', ['bug', 'ui']); // add to a set field
await storage.remove(id, 'tags', ['ui']);  // tags is ['bug']
await storage.splice(id, 'body', 0, 0, 'Hello'); // a text field: insert at 0
await storage.push(id, 'items', [1, 2]);   // a list field: append
await storage.treeMove(id, 'outline', 'n1'); // a tree field: node n1 at the root
await storage.set(id, { title: 'Final' }); // replace wholesale — everything but title is gone
await storage.list();                     // every live id
await storage.compact(id);                // rewrite it as the few ops it reads as — see below
await storage.delete(id);
await storage.purge(id);                  // forget it for good — see below
await storage.close();                    // stop replication, seal the log
```

Every write among these is an **operation**: applied here, written to the
[log](./sync#the-log), announced as a `change` event, and replicated to peers
when a transport is configured. Every one of them — and every op from a peer —
also emits an `update` event on any live `Record` for that id. The rest of
the list, text and tree API — `updateText()`, `setAt()`, `move()`, `mark()`,
`spans()`, `cursor()`, `treeRemove()` — is in [Lists, text and trees](./lists).

::: tip Registers, counters, sets, lists, texts and trees
A field written with `insert()`, `set()` or `update()` is a *register* — last
writer wins. A field created with `inc()` is a *counter* — increments add up
across nodes. A field created with `add()` is a *set* — concurrent adds both
keep, and an add a remove did not see survives it; it reads sorted by element
text. A field created with `splice()` or `push()` is a *list* (an array) or a
*text* (a string), edited by position: concurrent inserts both keep, each
writer's run whole. A field created with `treeMove()` is a *tree* (an array of
`{ id, children }`) — see [Lists, text and trees](./lists). A field is one
kind only: a local write of another kind — `update()` or `set()` naming a
counter, `inc()` on a set, `splice()` on a register, `treeMove()` on a list —
throws a `SyncomError` with `code: 'FIELD_KIND'`, `field`, and `kind` the kind
that holds it, before anything is stamped. A `set()` that leaves such a
field out drops it, as it drops every field it does not name; `unset(id,
fields)` removes named fields of any kind — the fields' own reset, which an
older concurrent write of them loses to and a newer one makes them again, as
whatever kind that write is. From a peer the
kinds' precedence decides instead — a register outranks a counter, a counter
a set, then a list, a text, a tree — see [Sync](./sync#registers-counters-sets-lists-and-text).
A nested object written as a value is one register, replaced whole by
whichever write is later; a field named by a *path* — `update(id, { 'profile/city':
'Kyiv' })` — is a field of its own under the prefix, so two nodes that write
different children of one prefix both keep theirs (see [Paths](#paths)).
:::

### Paths

A field name may be a path of stable segments joined by `/` — `profile/city`,
`stats/views`, `profile/geo/lat` — at most 16 segments and 512 characters,
none empty or `__proto__`; `/` is reserved for it (a dot is a plain
character: `update({ 'a.b': 1 })` writes a field named `a.b`). Every path is
a field like any other: a register, a counter, a set, a list, a text or a
tree, with its own clock, merged on its own — two nodes writing different
children of `profile` both keep theirs. A read composes the paths into
nested objects, children laid over the register at their prefix:

```js
const id = await storage.insert({ name: 'ada', profile: { zip: 1 } });
await storage.update(id, { 'profile/city': 'Kyiv' }); // a field of its own
await storage.inc(id, 'stats/views', 1);              // a counter under a prefix
await storage.get(id);
// { name: 'ada', profile: { zip: 1, city: 'Kyiv' }, stats: { views: 1 } }
```

The rules, the same on every node whatever the order the writes arrive in:

- A register written at a prefix — `update(id, { profile: { zip: 2 } })` — is
  a reset of what hangs under it: children stamped below the write go, a
  child written later survives and is read over the object. `unset(id,
  'profile')` takes the subtree the same way.
- A counter, a set, a list, a text or a tree holds its prefix alone: a write
  under it is refused before anything is stamped (`FIELD_KIND`, with
  `prefix` naming it), and where one lands from a peer, what hung under the
  prefix goes.
- A record holds at most 4 096 fields; a write that would add one past that
  is refused (`FIELD_KIND`, `kind: 'bound'`, `detail: 'paths'`), and a
  peer's picture of a record keeps the first 4 096 in sorted order.

The ops, the log, a `snapshot()` and `getCachedData()` keep the paths
apart; `get()`, a `Record`, a query (`'profile.city'` as a dotted path), a
hook's `current` and a validator see them composed. A list's element and a
tree's node can carry fields too — `items/<name>/body`, `outline/<node>/title`
— see [Children of elements and nodes](./lists#children-of-elements-and-nodes). A `Record`'s properties
are the composed top-level fields: `record.profile = { … }` writes the
object whole. A migration (`migrate()`) writes the registers as they read,
composed.

`FIELD_KIND` also refuses a list or text write past a bound — a single
insert over 1 048 576 elements, say — and then `kind` is `'bound'` and
`detail`, `count` and `max` say which ([Costs and
limits](./lists#costs-and-limits)). An index past a list's or a text's length
rejects with `OUT_OF_RANGE`, a tree move under the node's own subtree with
`CYCLE`.

### Compare-and-swap

`swap()` writes only if the fields you name still hold the values you expect,
which is how two writers avoid clobbering each other:

```js
const ok = await storage.swap(id, { hits: 2 }, { hits: 1 });
// ok === false if hits was no longer 1 — nothing was written
```

The comparison runs inside the mutation queue, against the record as it reads
(the lens applied, the read hooks not run), so two concurrent swaps on the same
expectation cannot both pass. An absent record rejects.

### Transactions

Several writes as one: `transact(fn)` runs `fn(tx)` inside the mutation
queue, every write made through `tx` becomes an op, and once `fn` returns
the ops are appended together — all durable or none, one chain block, each
record's file written once, the `commit` events after, in order. A throw
from `fn`, or a write refused (an index out of range, a validator), leaves
nothing appended.

```js
const id = await storage.transact(
  async (tx) => {
    const id = await tx.insert({ title: 'Draft', status: 'new' });
    await tx.inc('stats', 'drafts', 1);
    await tx.push(id, 'body', 'Once upon a time');
    (await tx.get(id)).body; // 'Once upon a time' — tx reads what it wrote
    return id;
  },
  { message: 'new draft', source: editor },
);
```

- **`tx` is the write API** — `insert`, `set`, `update`, `swap`, `delete`,
  `unset`, `inc`, `add`, `remove` and the plugins' methods (`splice`,
  `mark`, `treeMove`, …) — less `purge()`, which scrubs the log and stays on
  the storage; plus `get(id)` and `has(id)`, reading the records as the
  transaction left them, through the lens, without the read hooks (a hook
  that writes would wait for the queue the transaction holds). An encrypted
  write inside is `ENCRYPTED`: it makes no op.
- **Hooks and validators** run as each op is made, inside the turn; what they
  see is the record as the transaction left it. A refusal — theirs, or the
  engine's — throws out of `fn`, and nothing of the transaction is written.
- **`message`** (at most 1 024 characters) rides on every op of the
  transaction — in the signed header, so a peer verifies it with the op —
  and `history()` lists it per version; **`source`** rides on the `commit`
  events, for a listener to tell its own (an undo manager's). A transaction
  with no op makes none and resolves to what `fn` returned.
- **Each record once.** A live `Record` the transaction changed emits one
  `update`, with the delta of all its ops; `commit` and `change` still fire
  per op. The transaction holds each record it touches as its last op left
  it — not a copy per op — unless something listens for `commit`, whose
  events carry every op's `before` and `after` (an undo manager over a
  transaction of thousands of ops on one large record holds them all).
- `applyPatches()`, `restore()` and `compact()` are transactions: a restore
  lands whole or not at all.

### Purge

`delete()` leaves a tombstone, and the record's history stays in the log —
that is what lets a peer that was away catch up. `purge(id)` is the other
thing: the record is gone for good. It is a `purge` op, which wins over
every other op at any stamp (a later write does not revive it, nor does a
concurrent one on another node), and a **scrub** of every entry of the id
in this node's log — their `data`, `meta`, `key`, `value` and the `nonce`
that salted their signature's digest are stripped, in memory and in the
files, with the position, origin, stamp, signature and digest kept so the
vector and a resuming peer are unaffected — and of its copies and catalog
rows in every [tag](./versions#tags). A peer that receives the purge
scrubs its own log the same way, and so does any peer that receives
anything else about that id afterwards, or that learns of the purge from a
snapshot it bootstraps from. The chain keeps hashes only. A
purged record is listed nowhere and reads as `null`, at a tag too; a read at
a version before the purge rejects with `HISTORY_GONE` (`reason:
'scrubbed'`), and a `Record` of it reads `null`.

```js
await storage.purge(id);          // nothing of it left here
await storage.purge(id, { actor: 'dpo' });
```

Two limits. Scrubbing rewrites a log file in place — a journal line by line
— and no backend has a rename, so a crash in the middle tears it, and a peer resuming through it
bootstraps instead; `purge()` is idempotent, so run it again. And what a
peer that never comes back holds is theirs.

### Custom identifiers

Pass `getId` to replace UUIDs with ULIDs, CUID2s, nanoids or ids minted by your
own server. The package has no runtime dependencies, so the generator is yours
to install and supply:

```js
const { ulid } = require('ulid');

const storage = await open({ path: 'data', getId: () => ulid() });
const id = await storage.insert({ title: 'Draft' });
// 01ARZ3NDEKTSV4RRFFQ69G5FAV — lexicographically sortable by creation time
```

The generator takes no arguments and may be asynchronous — `insert()` awaits
it either way:

```js
await open({ path: 'data', getId: async () => (await fetch('/next-id')).text() });
```

`Storage.generateId()` is the default generator, should you want to fall back to
it. A `getId` that is not a function is refused at `open()`.

**Ids are file names.** A record is written to `data/${id}.json`, on every
platform, so an id is letters, digits, `.`, `_`, `-` and `@`, not starting
with a dot, 128 characters at most — UUIDs, ULIDs, CUID2s and nanoids all
qualify. Anything else is refused with a `TypeError` (`code: 'INVALID_ID'`)
before anything is written: from `insert()` (naming `getId`), from `set()` and
the other writers, and from a peer — whose op is then counted as `malformed`
and never logged. `get()` and `has()` answer `null` and `false` for such an id.

One thing the engine does not check for you: **ids are matched against string
fields.** A `Record` turns any string field whose value is a known id into a
[reference](#references). Short, guessable ids raise the odds of an accidental
match; UUIDs, ULIDs and CUID2s do not.

### One instance per directory

Two storages over one directory would both read the log's vector and both
mint the next sequence number — the same number for two different ops, which
every peer drops as a duplicate. So `open()` holds the directory: through the
Web Locks API in the browser (released when the tab dies), through
`<path>/lock.json` with the process id elsewhere (stale once that process is
gone, or after 30 minutes when there is no way to tell). On a backend with
`create` (exclusive create — `node:fs` and the memory backend have it) two
openers racing for a free lock lose deterministically. The knobs are an
object: `lock: { mode: 'wait', timeout: 5000, poll: 50, staleAfter: 60_000 }`
— `timeout` turns a `'wait'` that never ends into `LOCKED`.

```js
const a = await open({ path: 'data' });
await open({ path: 'data' });                   // Error, code 'LOCKED'
await open({ path: 'data', lock: 'wait' });     // resolves once `a` closes
const b = await open({ path: 'data', lock: false }); // yours to coordinate
```

Two browser tabs are two instances: with the default `'fail'` the second tab
sees `LOCKED` and must work through the first (a SharedWorker that owns the
storage, say), or wait for it with `lock: 'wait'`. There is no read-only
open: `lock: false` gives a second instance that writes too (its catalog,
and the log it seals on close), which is yours to coordinate. `close()` releases the lock; a crash releases it
in the browser and leaves a stale file elsewhere, which the next open takes
over. The lock is per machine — on a shared network filesystem, coordinate
yourself and pass `lock: false`.

### The catalog and the cache

`snapshot()` pages over the catalog too — it keeps a row for every entry with a
file, tombstones included, so a bootstrap never lists the data directory.
`list()` and `hasRecord()` answer from the **catalog**: every live record's
id, collection and indexed field values (and, for an entity with
[search fields](./query#full-text-search), the text `$text` searches), in
memory, kept up to date by every
write — local or a peer's — and persisted as `index/catalog.json` stamped
with the log position it reflects: at `close()`, and in between every
`catalog.flushEvery` changes while it is small and every sixteenth of its size
as it grows, so a save costs a write the same share of a row whatever the
store's size, never more than half the log's `retention.ops` apart, so a node
stopped without `close()` finds its stamp still in the log. A reopen reads it back and re-reads only the records the log
changed since the stamp; when the log cannot say — a first open, a stamp
from another epoch or below the retention floor, other indexes — the
catalog is rebuilt from one scan of `data/`. It is derived state: delete the
file and the next open rebuilds it.

The **cache** holds the last `cache.max` entries read or written, evicting
the oldest; a record with a live `Record` is never evicted. What leaves the
storage leaves as a **copy**, as JSON — the value `get()` returns, a cursor's
rows, a `Record`'s data — and what comes in (`set()`, `update()`) is copied the
same way, so editing an object on either side of the call changes nothing in
the cache, the log or the next write's base. `getCachedData()` and `snapshot()`
hand out the raw objects, for callers that know not to touch them. A cold read re-verifies the record against the chain block
that committed it; `integrity: 'lazy'` trusts the file instead — the choice
for a browser rebuilding a large catalog, where that verification is one
hash and two reads per record. `storage.validate(id, data, block)` is still
there for a check on demand.

### When a record file lags the log

A local write is durable once its op is in the log: the record file and its
chain block come after. Two things put that file behind the log, and in both
the cache holds the record — every read sees the write — and the log keeps
the batch unapplied until the file lands, so a crash in between is replayed
onto the file at the next open:

- **`open({ defer })`** — 16 ms, a frame, by default. The file waits up to
  `defer` ms, and the writes of one record within the window land as one
  file and one block. A flush that took longer than `defer` — a large record,
  a slow disk — makes the next window as long as it took, so the files never
  land back to back while the writer waits behind them. `flush()`, `tag()`
  and `close()` land them first, and a peer's write of the record lands it
  whole. `defer: 0` writes every file at
  once — what a process that may be killed between a write and the next
  frame wants, at the price of a file per op.
- **A file write that failed** — a full disk, a quota. The write is not
  undone (it replicates from the log already); the record is held in memory
  until the next open, and the storage's `error` event fires with
  `code: 'UNPERSISTED'` and the `ids`. `tag()` rejects with `UNPERSISTED`
  while such a record is held.

```js
const storage = await open({ path: 'data', defer: 50 });
const id = await storage.insert({ title: 'Notes' });
for (const ch of 'hello') await storage.push(id, 'body', ch);
await storage.get(id);   // { title: 'Notes', body: 'hello' } — six ops logged, no file yet
storage.stats().deferred; // 1 — one record waiting; 0 once the window passed
await storage.flush();    // or now: the file and its block
```

The log itself is written in groups: a write's seq is reserved the moment
its op is built, the mutation queue moves on to the next write at once, and
every op appended while the previous group is being written goes to disk as
one file with the others — what the caller awaits is the landing: the disk,
then the file (or the deferred slot), the `afterWrite` hook and the events,
in log order. The next write of a record builds on the one in flight before
it; a read sees a write once it is durable. `stats().inflight` counts the
writes between the append and the disk.

### Health

`storage.stats()` is what an operator reads at runtime, from memory: whether
the storage is `closed`, how many writes wait on the mutation `queue`, the
`cache` (`size`, `max`, `pinned` by live Records), the `catalog` (`entries`,
tombstones included, and `dirty` puts since the last save), the `tags`
(`count`, and `corrupt` when `tags.json` could not be read at open), the
records whose files lag the log (`held`, the deferred ones among them, and
`deferred`), the writes appended but not on disk yet (`inflight`), the `log`
(`length`, `floor`, `next`, `epoch`, `segments`,
`latestTs`, `droppedTs`, and `pins` — readers holding segments past
retention, an undo stack mostly), the `chain`'s `tail` (or `null` under
`chain: false`) and the `lock`'s `mode` (or `null` under `lock: false`). The
[sync manager](./sync#lifecycle-and-events) adds `peers()` and `hosted()`, the
storage's [`log` event](./hooks#storage) reports the log rolling, and
[telemetry](./telemetry) adds the gauges.

### Repair

A record file that fails its integrity check — its data no longer hashes to
what its chain block recorded, or the file no longer parses (a write torn by
a crash) — rejects every read with `code: 'INTEGRITY'`,
and stays that way: nothing repairs it behind your back, because a file that
changed under the chain is evidence first. When you have looked,
`storage.repair(id)` rebuilds the record from this node's own log: the
retained entries of the id are replayed from the first whole-record op among
them (a `write`, `merge`, `delete` or `purge`), and the result is written the
usual way, with a chain block of its own, back into the catalog and the cache.
What comes out is what a peer replaying this log from that op would hold —
the same fold [`history()` and `get(id, { at })`](./versions) read the past with.

```js
try {
  await storage.get(id);
} catch (error) {
  if (error.code !== 'INTEGRITY') throw error;
  const { ops, alive } = await storage.repair(id); // { ops: 3, alive: true }
}
```

A record the log cannot rebuild — its write compacted away so only `set`s and
`inc`s remain, an id never written here, an encrypted record (which has no
ops) — rejects with `code: 'UNRECOVERABLE'`; a peer that still holds the
record is the way back then (a [bootstrap](./sync#bootstrap) carries it).

### Compact

A record's metadata keeps what its fields merged from: a text typed into
from many places keeps a run per place, a list reordered often keeps its old
slots, a tree keeps every move of every node. `storage.compact(id)` rewrites
the record as the ops it reads as today — a `write` of its registers, then
an `inc` per counter, an `add` per set, one `splice` per list or text and
one move per tree node — so what lay under it goes by the reset rule, on this
node and on every peer the ops reach, and `get()` reads the same:

```js
await storage.compact(id); // how many ops it took; 0 for a record that is not there
```

A text's marks are laid again over the new run, so `spans()` reads the same
too. What it cannot keep is the names of the elements: every
[cursor](./lists#cursors) into a list or a text of the record reads `null`
from then on, and a stacking mark has a new id. A list, a text, a set or a
tree that reads empty is left out: no op makes an empty one. A peer's op stamped
before the rewrite and arriving after it is dropped by the reset, as with
any whole-record write; an encrypted record rejects with `ENCRYPTED`. It is
`applyPatches()` over the record's own reading — see [Versions and
history](./versions#diff-and-restore).

### Encryption at rest

Sealed records are the `encryption` plugin — `@alexify/syncom/encryption`,
registered by `@alexify/syncom/all`; without it `encrypted: true` is
`PLUGIN_MISSING`. Open the storage with `encrypted: true`, or pass the flag
per write:

```js
const { encryption } = require('@alexify/syncom/encryption');

const vault = await open({ path: 'vault', plugins: [encryption], encrypted: true });
await vault.insert({ ssn: '...' });                       // sealed on disk

await storage.insert({ ssn: '...' }, { encrypted: true }); // one record, in a plain storage
await storage.saveData(id, data, { encrypted: true });
```

A record is sealed with a fresh AES-256-GCM key, and that key is wrapped with
the storage's RSA-OAEP (SHA-256) public key — the same envelope on Node.js and
in the browser, so ciphertext and keys move between the two. There is no size
ceiling. Both key pairs live in `<path>/keys/` — the RSA one that seals
records, the Ed25519 one that [signs ops](./sync#signatures) — unprotected:
whoever can read the directory can read the records, and sign as this node.

Encrypted records are **local**. No peer holds this node's private key, so
they produce no operations, never appear in a snapshot, and every field-kind
method on one — `inc()`, `add()`, `remove()`, `splice()`, `push()`,
`treeMove()`… — rejects with `code: 'ENCRYPTED'`, as do `history()`, `diff()`
and `compact()`, which read the log it is not in. `update()`, `set()`,
`delete()` and `purge()` still work; they simply stay here. A record never
changes kind: an encrypted write over a replicated record is refused
(`ENCRYPTED`), and a plain write to an encrypted one seals it again.

A sealed record protects one record from the disk; the log, the catalog and
the other records stay plain. To encrypt the directory whole, wrap the
backend instead — `atRest()` from the same subpath, every file under one
key, the engine none the wiser — see [Encrypted at rest](./backends#encrypted-at-rest).

## Records

`storage.record(id)` returns a live `Record`. It is cached per id, so two
calls for the same record return the same object — and therefore the same
event listeners.

```js
const record = await storage.record(id);

record.on('update', (data, delta) => {
  console.log(delta); // { title: 'Final' }
});

record.title = 'Final';        // stages the change and emits
record.delta();                // { title: 'Final' }
await record.save();           // writes, then clears the delta
await record.inc('views', 1);  // a counter, through the record
await record.add('tags', ['bug']); // a set, through the record
await record.data();           // the full current object
await record.delete();
```

Every field-kind method of the storage is on the record too, without the
id: `record.splice('body', 0, 0, 'Hi')`, `push()`, `updateText()`, `mark()`,
`unmark()`, `unmarkById()`, `spans()`, `cursor()`, `index()`, `setAt()`,
`move()`, `treeMove()`, `treeRemove()`. A field of any kind but a register
changes through those: assigning it and saving is a `set` op on it, which
throws `FIELD_KIND`.

Properties are defined from whatever keys the record had when it was loaded;
`id` is reserved and never becomes a settable property.

A record also follows changes made **elsewhere** — `storage.update()` in the
same process, or an op from a peer: its properties are refreshed, `update`
fires with the delta, and edits staged but not yet saved stay on top. A
record deleted elsewhere reports `update` with `null` data. A record reads
through `get()` — the lens and [`afterRead`](./hooks#reads-stay-raw-where-it-matters)
applied — as it loads and as it follows a change; with the lens or a read
hook in play, the change reaches it once the write is done, in order.

### References

When a stored string happens to be the id of another record that storage
already knows about, reading it back gives you a `Reference` rather than the
raw string. `reference.record()` resolves it:

```js
const post = await storage.record(postId);
const author = await post.author.record();
```

## Collections

Pass a `schema` and every entity name becomes a collection on the storage
object. Records inserted through a collection carry a `$type` field naming it.

```js
const storage = await open({
  path: 'data',
  schema: { entities: { Post: {}, Author: {} } },
});

const post = await storage.Post.insert({ title: 'Hello' });
post.title;                         // 'Hello'
await storage.Post.get(post.id);    // { title: 'Hello', $type: 'Post' }
await storage.Post.update(post.id, { title: 'Hi' });
await storage.Post.delete(post.id);
```

In TypeScript the collection's records are typed by the entity's Standard
Schema or by a `Schema<{ Post: Post }>` annotation — see
[TypeScript](./typescript).

`entities` may be a plain object or a `Map`. Without a schema the storage has
no collections and you address records by id only. An entity named like
something the storage already answers to (`get`, `close`, `log`, `sync`…)
would replace it, so `open()` refuses it with a `TypeError`.

A collection answers for its own records: `get(id)` of a record of another
collection is `null`, and `update()`, `delete()` and `record()` reject with
`code: 'NOT_FOUND'` — the storage's own methods address any record.

An entity definition is `{ schema?, idField?, validate?, index?, unique?, fields?, search? }`;
`{}` is a bare collection. `schema` validates the records ([below](#validation)),
`idField` names the key the id is handed to the validator under, `index` and
`unique` — explicit, or read off a metaschema schema's `indexes` and
`unique: true` fields — are what [queries](#queries) key on, `search` names
the fields `$text` searches, and `fields` is free-form notes kept as given. Anything else is a `TypeError` at
`open()`: a definition with a typo is a validation that silently never runs.

`$type` is the record's collection and never changes. `storage.set()` without
it keeps it, `Collection.set()` stamps its own, a write that would change it
throws, and `Collection.update()` refuses a delta that names it. A record
outside any collection may join one, and a deleted record may be reborn in
another.

```js
await storage.Post.set(post.id, { title: 'Replaced' }); // { title: 'Replaced', $type: 'Post' }
await storage.set(post.id, { title: 'Again' });          // keeps $type: 'Post'
await storage.Author.set(post.id, { name: 'x' });        // TypeError: $type is immutable
```

### Queries

The full guide is [Queries](./query); the shape, in short.
`collection.select(query)` is a cursor: build it, then `fetch()`, `count()`,
`one()`, iterate it, or `watch()` it. The query is Mango-shaped —
`{ field: value }` is equality (a dotted path reaches into the record, an
array field holds a scalar value), `{ field: { $op } }` the operators `$eq`,
`$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`, `$exists`, `$regex`
(with `$options`), `$and` / `$or` / `$not` nest, and `$text` searches an
entity's [search fields](./query#full-text-search). A malformed query is a
`TypeError` at `select()`.

```js
const storage = await open({
  path: 'data',
  schema: { entities: { Project: { index: ['orgId'], unique: ['slug', ['orgId', 'name']] } } },
});

await storage.Project.insert({ orgId: 'o1', name: 'Alioth', slug: 'alioth', stars: 3 });
await storage.Project.insert({ orgId: 'o1', name: 'Vega', slug: 'vega', stars: 7 });

await storage.Project.select({ orgId: 'o1', stars: { $gte: 5 } }).fetch();
// [{ id: '…', orgId: 'o1', name: 'Vega', slug: 'vega', stars: 7, $type: 'Project' }]
await storage.Project.select({ orgId: 'o1' }).order('name').limit(10).offset(0).projection(['name']).fetch();
// [{ id: '…', name: 'Alioth' }, { id: '…', name: 'Vega' }]
await storage.Project.count({ orgId: 'o1' }); // 2
await storage.Project.select({ slug: 'vega' }).one(); // the record, or null

const stop = storage.Project.select({ orgId: 'o1' }).order('name').watch((rows) => render(rows));
```

Rows are the records as they read (the lens applied, `$type` included)
under their `id`; `projection(fields)` keeps only those (a dotted field comes
back under its dotted name), `filter(fn)` takes a predicate over the loaded
row, `order(field)` / `desc(field)` sort by any field — nothing first, then
booleans, numbers, strings — stably, and `offset` / `limit` cut after the
sort. A cursor does not run the read hooks: like `snapshot()` and `swap()`,
it reads the records themselves.

The entity's `index` and `unique` fields are what the catalog keeps: a query
whose fields, order and projection are all indexed — and has no `filter` —
is answered from the catalog alone, with no record read; an equality on an
indexed field narrows every other query to its posting list before the
records are read. `watch(listener)` runs the cursor now and again after
every change to the collection (one run per batch of changes), until the
returned function is called; a failing run goes to `onError` or the logger.

A `unique` key — a field, or a composite — is refused on a local write with
a `ValidationError` whose issue has `code: 'unique'` and `conflict`, the id
holding the key. Two nodes writing the same key at once cannot be refused:
both records arrive, both are kept, and the `conflict` event
`{ kind: 'unique', entity, fields, id, other, op }` names them — the
application decides which yields.

### Validation

The full guide is [Schema and validation](./schema); the shape, in short.
Give an entity a `schema` and every write to its collection but `delete()`
and `purge()` — `insert()`, `set()`, `update()`, a `Record.save()`, `inc()`,
`add()`, `remove()`, and every list, text and tree write — is validated as
the whole record the write leaves behind, before anything is logged or
written.
Three shapes are understood, and the package requires none of them:

- a **Standard Schema** — anything with a `~standard` property: an entity of a
  metaschema `Model`, a zod, valibot or arktype schema;
- a **function** — an ajv-compiled validator (`false` plus `fn.errors`), or any
  function that throws on a bad value and returns the value (or nothing) on a
  good one;
- a **plain object** compiled through `open({ validator })` — a JSON Schema or
  TypeBox object handed to `validator.compile(schema, { entity })`; an Ajv
  instance fits as it is.

```js
const { Model } = require('@alexify/metaschema');

const model = new Model(
  {},
  new Map([
    [
      'Project',
      {
        Registry: {},
        orgId: 'string',
        name: { type: 'string', aliases: ['title'] },
        slug: 'string',
        'desc?': { type: 'string', default: '' },
      },
    ],
  ]),
);

const storage = await open({
  path: 'data',
  schema: { entities: { Project: { schema: model.entities.get('Project') } } },
});

const project = await storage.Project.insert({ title: 'Alioth', slug: 'alioth', orgId: 'org1' });
await storage.get(project.id);
// { name: 'Alioth', slug: 'alioth', orgId: 'org1', desc: '', $type: 'Project' }

await storage.Project.insert({ name: 'x' });
// ValidationError: Project failed validation at orgId: is required (+1 more)
//   error.issues → [{ path: ['orgId'], message: 'is required', code: 'required' }, { path: ['slug'], … }]

await storage.check('Project', { title: 'Alioth', slug: 'alioth', orgId: 'org1' });
// { name: 'Alioth', slug: 'alioth', orgId: 'org1', desc: '' } — validated, nothing written
```

What the validator returns is what is written and replicated: the defaults it
filled, the aliases it resolved (`title` became `name`), the keys it stripped —
taken as JSON, so a `Date` a decoder produced is stored as the string it
serializes to. A failed write rejects with a `ValidationError` — `code:
'VALIDATION_FAILED'`, `entity`, and `issues` as `[{ path, message, code? }]`,
with `cause` when the validator threw something of its own — and leaves nothing
behind. `storage.check(entity, data)` runs the same validator without writing.

The validator sees the record without `$type` and with its id under `idField`:
`id` by default; metaschema's `<entityName>Id` when the schema's fields have
that (an entity of a `Model` needs no configuration); nothing at all (`false`)
for a schema that shows its fields and has neither, such as a metaschema
struct. Set `idField` to override. The id is dropped from the validator's
output again. A schema you only want read, not run — one from
`@alexify/metaschema/definition`, say — takes `validate: false`.

Two things to know about `update()`:

- it is validated as the whole record it leaves, so a required field missing
  from the delta is fine as long as the record has it;
- it stays a `set` op: of what the validator returns, only the keys the delta
  named (in their validated form) and the keys the record did not have (a
  default, an alias target) are written. Write a field by its own name, not an
  alias — a delta under an alias of a field the record already has changes
  nothing, and the alias key an older record holds stays until a whole-record
  write replaces it.

A peer's op is validated here too, but never rewritten: an op that would leave
the record invalid under this node's schema is skipped exactly like a
[`beforeApply` hook returning `false`](./hooks#skipping-a-peers-op) — logged,
relayed, replay-safe — and reported through the `error` event with
`error.entity` and `error.issues`. Give every node the same schema and every
node reaches the same verdict.

### Schema versions

`schema.version` (a positive integer, `1` by default) is stamped on every op
this node makes as `v`, and a record remembers the version of its last
whole-record write as `meta.v` — what tells a node on another version which
shape a record is in. `schema.snapshot` is any JSON that describes the
schema — metaschema's `model.toJSON()`, whose key order is deterministic —
and is hashed:

```js
const storage = await open({
  path: 'data',
  schema: { version: 2, snapshot: model.toJSON(), entities: { /* … */ } },
});

storage.schemaInfo;
// { version: 2, hash: '9f3c…', previous: null, held: null }
```

`schema.json` in the directory remembers the version and hash it last ran.
When they differ at open, `schemaInfo.previous` holds what it was — an
upgrade to run migrations after, a snapshot change of the same version, or a
downgrade (logged as a warning) — and is `null` otherwise. Peers exchange
`{ version, hash }` in [hello](./sync#schemas): the same version with another
hash is reported as drift.

### Reading across versions

Nodes on different versions keep working together. A record written under an
older version is read through a **lens** — nothing is rewritten, the view is
computed once per cached entry — in two steps:

1. the **migrations**: `migrations` is keyed by the version each one migrates
   *to* (`2` takes a record from 1 to 2), either storage-wide `{ up }` or per
   entity `{ Post: { up } }`; `up(data, { entity, id, from, to })` gets the
   record without `$type` and returns it as it is under `to`;
2. the entity's **Standard Schema validator**: its aliases and defaults are a
   rename and a fill for free, so a metaschema entity with
   `name: { aliases: ['title'] }` and `'desc?': { default: '' }` reads a v1
   `{ title }` as `{ name, desc }` with no migration written. A validator that
   refuses the record leaves step 1's result and logs at debug.

`lens` picks the steps: `'both'` (default), `'migrations'`, or `'validate'`
(refused together with `migrations`).

```js
const storage = await open({
  path: 'data',
  schema: {
    version: 2,
    entities: { Post: {} },
    migrations: { 2: { Post: { up: ({ title, ...rest }) => ({ ...rest, name: title }) } } },
  },
});

await storage.get(oldPost); // { name: 'Hello', $type: 'Post' } — on disk it is still { title: 'Hello' }
```

Writes go through the lens too: `update()` validates the record as it reads,
and carries only the keys that changed. `get()`, `swap()`, a cursor and a
`Record` as it loads read the view; `snapshot()` and `getCachedData()` read
the raw data, and so does replication — a peer on the older version sees the
record exactly as it was written.

`migrate()` rewrites what the lens only reads: every record of an older
version becomes a whole-record write of its view (the version with it), with
the fields of other kinds made again after it — an `inc` per counter, an
`add` per set, one `splice` per list or text, one move per tree node. Run it
on one node after an upgrade; peers receive ordinary ops. It is idempotent,
and `{ entities }` limits it to those collections:

```js
if (storage.schemaInfo.previous) {
  await storage.migrate(); // { migrated: 12, counters: 3, sets: 1, lists: 0, texts: 2, trees: 0 }
}
```

The other direction — an op from a **newer** version — is `ahead`:
`'apply'` (default) applies it as it is, unvalidated (registers are
forward-tolerant; the validator does not know the shape), and emits `schema`
`{ kind: 'ahead', op, held: false }`; `'hold'` keeps it in the log, skipped
and flagged with its version, relays it, and applies it at the first open
that runs that version — `schemaInfo.held` is then `{ replayed, lost }`,
`lost` counting held ops that retention dropped before the upgrade. A hold
needs `sync.retention.ops` of 1000 or more (or `0`, keep everything), and a
directory that ran a newer
version cannot be reopened with `'hold'` on an older one.

## On disk

```
data/
├── node.json      { id } — this node's identity: its signing key (see Sync › Signatures)
├── keys/          public.pem, private.pem (RSA, seals records); sign-public.pem, sign-private.pem (Ed25519, signs ops)
├── blockchain/    <hash>.json per block, .blockchain.json holds the tail
├── lock.json      { pid, id, since } — while an instance holds the directory (not with Web Locks)
├── schema.json    { version, migrated, hash } — the schema this directory last ran
├── index/         catalog.json — the record catalog as of a log position, search text included (derived; rebuilt when missing)
├── data/          <id>.json per record: { data, meta, encrypted, timestamp, block, gen? }; a list or text of 1 024 runs or more keeps its runs in <id>~<n>.json beside it, a piece of 32 each
├── log/           the operation log (see Sync)
├── tags.json      { format, tags } — the tags taken here (see Versions and history › Tags); tags.corrupt.json beside it once it could not be read
├── tags/          <name>/index/catalog.json and <name>/data/<id>.json — a tag's catalog and the record files copied before their first change after it; .pending/data/ while tags.json is unreadable
├── branch.json    { format, parent, forkedAt, createdAt } — in a branch only (see Versions and history › Branches)
└── remote/        <url>.json per registered sync node
```

Every record names the block that committed it, which is what makes
[validation](./chain) possible. `meta` is the replication bookkeeping — per
field clocks, the reset watermark, the tombstone, the counters, the sets, a
list's or a text's block, a tree's moves — and is what lets two nodes'
copies merge; a deleted record keeps its file as a tombstone.
