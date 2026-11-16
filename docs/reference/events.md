---
title: Events and hooks
description: Every hook syncom runs and every event it emits — when each runs, what it receives, what its return value and a throw do.
---

# Events and hooks

The specification of the hook and event surface of `src/commit.js`, `src/apply.js`, `src/bootstrap.js`,
`src/database.js` and `src/sync/manager.js`. [Hooks and events](../guide/hooks) teaches when to use which;
this page records what each one is handed and what it may do.

A **hook** is one function per name, configured in `createDatabase()` and awaited inside the operation it
belongs to; a throw fails the operation with a [`HookError`](#hookerror). An **event** is what `on()`
subscribes to: any number of listeners, contained, none able to affect the operation. An unknown hook name,
or a value that is not a function, is a `TypeError` at `createDatabase()`.

## Database hooks

`createDatabase({ hooks })`:

| Hook | Runs | Return | Throw |
| --- | --- | --- | --- |
| `beforeWrite(ctx)` | Inside every local write, after the current record is loaded and before the op is stamped and applied — once per op, so once per hunk of `updateText()`, per patch of `applyPatches()`, `restore()` and `compact()`, per op of a schema migration, and per record a bootstrap joins (`merge`); a keystroke of a text handle at its flush | A plain object replaces `data` (`write` and `set` only; a `TypeError` for anything else) | The write is refused: nothing stamped, logged or written |
| `afterWrite(ctx, op)` | After the write is durable — outside the mutation queue, in log order, before the call resolves; `op` is the op it became, `null` for an encrypted (local) write; not called when the write changed nothing (a tree move to where the node already is) or was refused | Ignored | The call rejects, but the op stays committed and is announced |
| `beforeRead({ id, at? })` | Inside `get(id)`, before the read — with `at` for a read at a version (`{ tag }` for `at(name).get(id)`), once with `{ id, history: true }` for `history()` | Ignored | The read is refused |
| `afterRead({ id, at? }, data)` | Inside `get(id)`, after the read — with `at` for a read at a version, and per version of `history()` (its event id) | Anything but `undefined` (including `null`) replaces what the caller sees | The read rejects |
| `beforeApply(ctx)` | Inside `applyRemote`, once per op of any kind, after the signature, duplicate, gap and scope checks and before the op is applied; not for an op held for a newer schema (`ahead: 'hold'`) or one on a record this node keeps sealed | `false` skips the op here (see [Skipping a peer's op](#skipping-a-peer-s-op)) | The whole batch is aborted before anything is durable |
| `afterApply(batch)` | After a peer's batch is durable, once per `applyRemote` call; `batch` is the [apply result](#the-apply-result) with `via`, `peer` and `ops` (every accepted op, the skipped ones included) | Ignored | The call rejects; the batch stays and is announced |

### The write context

`ctx` for a write is `{ type, id, data?, key?, value?, index?, count?, content?, to?, start?, end?, name?,
expand?, many?, off?, node?, parent?, after?, before?, meta?, current, encrypted, source, via, from, v,
actor }`:

- `type` is the op type: `write`, `set`, `unset`, `version`, `inc`, `add`, `remove`, `splice`, `assign`,
  `move`, `mark`, `tree`, `delete`, `purge`, `merge`. A `version` is a schema migration's op (see
  [Versions and the lens](./api#versions-and-the-lens)); a `set` that makes a record reaches the hooks as a
  `set`, whatever op it becomes.
- `data` is the whole record for a `write`, the delta for a `set` and the registers a migration writes for
  a `version`; `value` holds an `unset`'s field names, and the names a `version` removes; `key`/`value`
  belong to an `inc` (the amount), an `add` or a `remove` (the elements);
  `key`/`index`/`count`/`content` (and `vals`, the markers of the embed slots the content holds) to a
  `splice`; `key`/`index`/`value` to an `assign`; `key`/`index`/`to` to a `move`;
  `key`/`start`/`end`/`name`/`value`/`expand`/`many` (or `off`) to a `mark`; `key`/`node`/`parent`/`after`/`before`
  to a `tree` — each the call as the caller made it, save that a `push()` is a `splice` with `index: null`
  (the end), an `unmark()` a `mark` with `value: null` and the reversed expand rule, an `unmarkById()` a
  `mark` with `off`, a `treeRemove()` a `tree` with `parent: '$trash'`, and a `remove` from
  `applyPatches()` carries `removals` or `own` as the patch did.
- An edit made through a text handle (`openText()`) reaches the hooks at its flush, already resolved over
  the handle's reading: its `ctx` says `resolved: true`, carries `key`, `current` and — for a `splice` —
  `content` as above, has no `index`/`count` (the handle's reading may have moved since), and `value` is
  the op's payload as it travels (the run it extends, the cuts, the content). `beforeWrite` may refuse
  such an edit; it replaces nothing.
- `meta` is the joined metadata of a `merge`.
- `current` is the record as it is now, its paths composed (`null` when absent or deleted — read it, do
  not change it); `encrypted` says whether the write is sealed for this node; `source` is the `Document`
  whose `save()` this is or the `source` given to `applyPatches()` (`null` otherwise); `v` is this node's
  schema version; `actor` who the op will say made it (`null` when nobody).

For a remote op `ctx` is `{ op, via, peer, current }`, where `peer` is `{ url, node }` — `url` is `null`
when this node is the host — and `op` is the op as it travels: a `splice`, a `move` or a `tree` names
anchors and places, not the indices of the call that made it ([wire format](./wire#types-and-payloads)).

### The order of a write

A local write:

```
load the record → beforeWrite → stamp → apply the op → validate → append to the log
│ the queue moves on to the next write here; the rest follows, in log order, once the op is on disk
→ chain block → record file → afterWrite → Document 'update' → 'commit' → 'change' → 'transaction'
```

Under `createDatabase({ defer })` — 16 ms by default — the chain block and the record file wait for the
flush, after the events. A page from a peer:

```
the page: signatures checked
per op:   malformed (shape, id, skew) / duplicate / gap checks → the pushing peer's
          scopes (a host) → authorizeWrite (a host) → beforeApply → apply → validate
then:     append to the log → persist the records → afterApply → 'apply' → 'change' × n → 'transaction'
```

### Reads stay raw where it matters

`afterRead` changes what `get()` — and everything that reads through it: `get(id, { at })`,
`at(name).get(id)`, each version `history()` hands out, `Collection.get`, a contract's `DataReader`, a
`Document` as it loads — hands back. It does not touch the record: `swap()` compares against the raw data,
`snapshot()` replicates the raw data, `getCachedData()` and `has()` are raw, and so is what a cursor
(`select()`), `diff()`, `spans()`, `cursor()` and `index()` read. A `Document` reads through `get()` as it
loads and as it follows a change — a write here, an op from a peer: with `beforeRead` or `afterRead` set,
it is refreshed once the write is done, outside the mutation queue (a read hook may write), so a redaction
holds on a live `Document` for good; a `beforeRead` that throws then leaves the `Document` as it was. A
`Document` that saved a redacted field would write the redaction back; it does not, because `save()`
writes only the fields that were assigned.

### Skipping a peer's op

`beforeApply` returning `false` leaves this node's record alone — and nothing else. The op is still
appended to this node's log, still counted in the vector, still relayed to the peers behind this node,
and still announced as a `change`. Sequence numbers run contiguously per origin and scope, so an op
missing from a log is a gap that stops every later op of that stream for everyone who resumes from it,
and a vector that does not move has the sender offer the same page forever. Skipping is a local decision;
peers make their own with their own `beforeApply`. A skipped op is flagged in the log so a reopen's replay
of the unsealed tail leaves it alone too. The same path takes an op that would leave the record invalid
under this node's schema: skipped, logged, relayed, and reported through the `error` event
(`OP_INVALID`) rather than a hook — and a peer's op on a record this node keeps sealed (`encrypted: true`),
which is logged and relayed, never applied.

A throwing `beforeApply` aborts the batch before anything is durable. The sender sees a failed push (on
the dialing side its `error` event fires, with `error.url`), keeps its cursor, and offers the page again
at the next handshake.

### The apply result

`applyRemote` answers, and `afterApply` and the `apply` event carry, `{ applied, skipped, duplicates,
gaps, malformed, unsigned, forged, outOfScope, equivocations }`:

- `applied` counts every accepted op, skipped ones included; `applied - skipped` were applied here. An op
  older than what the record holds, or one the engine refused (`OP_REFUSED`: the field is held by a kind
  that outranks the op's, a bound, a payload it does not admit), leaves the record as it was and is logged
  and relayed all the same, never a gap.
- `skipped`: accepted but not applied here — a `beforeApply` returned `false`, the record would not pass
  its entity's validator, its file could not be read, it is sealed for this node, or the op waits for a
  newer schema version.
- `malformed`, `unsigned` and `forged` were refused before anything read them, neither logged nor relayed;
  `equivocations` because they fork their writer's stream (`EQUIVOCATION` in
  [`SyncomError`](./api#syncomerror)).
- `outOfScope` (a host's push): the record they write is outside the pushing peer's scopes. Each is
  accepted as a withheld scrub — logged skipped without its payload, relayed as a header that applies
  nowhere, so its stream goes on — and counted in `skipped` too; `refused` names it (`reason: 'scope'`, no
  record), beside what `authorizeWrite` refused (`reason: 'rule'`, with the record as the host holds it).

### Hooks and the queue

Every local write and every peer batch runs through one mutation queue, and the write and apply hooks run
inside it. A hook that awaits something slow holds every other write for that long. A hook that writes
would wait for the queue, which is waiting for the hook — so a write issued from `beforeWrite`,
`afterWrite`, `beforeApply` or `afterApply` is refused with a `SyncomError` (`code: 'IN_HOOK'`) rather
than left to deadlock; a hook that awaits it and lets it throw fails with a `HookError` whose `cause` is
that refusal. Reads (`get`, `has`, `record`) are fine from any hook. The read hooks run outside the queue:
a write issued from `beforeRead` or `afterRead` queues, and a slow read hook holds no write.

## Sync hooks

`createDatabase({ sync: { hooks } })`:

| Hook | Runs | Return | Throw |
| --- | --- | --- | --- |
| `beforeConnect(node)` | Before a registered node is dialled — at `start()`, `addNode()` while started, or `enableNode()`. `node` is a copy of the registry entry | `false` leaves it registered but not dialled | Reported through the manager's `error` event, with `error.url` |
| `beforeBootstrap({ url, node })` | When a host's log cannot resume this node and its whole state is about to be joined | `false` refuses: the peer stays connected for pushes but nothing is received from it until the next handshake asks again | Reported through `error` |
| `beforeSend({ op, peer })` | Before an op goes to a peer — a push, a relay, a hosted `changes` page (over a shared log too) | `false` sends it scrubbed: the header alone, a no-op where it lands, no gap in its stream (the log's op is untouched). A snapshot page and a query answer are records, not ops: the scopes rule them | Reported through `error`; the push fails and is tried again |
| `onRevoke({ url, node, scopes })` | A host took scopes back from this node (`REVOKED`); the registry entry is narrower already, the feed is opened again under the new grant after the hook | — | Reported through `error` |

No hook ever withholds an op: seqs run contiguously per origin and scope, so an op missing at one peer is
a gap that stops every later op of that stream at it. `beforeSend` sends the header instead — the op is
logged and relayed everywhere as a no-op (`scrubbed`) — and a host's `authorizeWrite` refuses the same
way. Per-peer visibility is what [scopes](../guide/partial-sync) are for: a scope is its own stream, and a
node only receives the scopes it asked for. Without `onRevoke`, the records of a revoked scope are
forgotten (`forget(id)`: gone here, no op).

## How events are delivered

Every listener is contained: it is invoked at once, never awaited, and if it throws the failure is logged
at `warn` (`{ event: 'listener.error', name }`) and the operation carries on. `error` with nobody listening
is silent rather than a throw. A function is one listener per event — `on()` with it twice throws — and an
event takes at most `createDatabase({ maxListeners })` of them (100 by default) on the database and on its
sync manager; one more throws. The events whose payload is costly to build (`commit`, `transaction`) are
built only while something listens.

## Database events

| Event | Payload | When |
| --- | --- | --- |
| `change` | `(op, via, { changes, seq })` | Every op this node logs — a local write, a peer's accepted op (a skipped one included), a bootstrap's `merge` and `advance`; keystrokes sent without waiting, or typed through a transaction, that continue each other are one op (typed on at the end of their run, or a chain of cuts), announced once with the changes of each in order; `via` is `null` for a local write, otherwise `{ url, node }` of the peer it came from (`url` null on the hosting side); `changes` what the reading shows of the op, in the write API's terms and the reading's indices (`[]` for an `advance`, a skipped op); `seq` the op's position in this node's log (what a hub's relay to a shared log covers it by) |
| `commit` | `({ op, seq, txn, source, before, after, kinds, changes, embeds? })` | A local write is durable — any kind of op made through the write API, `transact()`, `applyPatches()` and a schema migration included; never a peer's op, a bootstrap's `merge`, an encrypted write (it makes no op) or a write that changed nothing. `seq` is its log position, `txn` the seq of the first op of the transaction it was made in (its own for a single write), `changes` its [changes](#changes), `source` the `Document` whose `save()` it was or the `source` given to `transact()`/`applyPatches()` (`null` otherwise), `before`/`after` the record as copies in the op model's terms — every path a field of its own, not composed (`null` when absent or deleted), `kinds` every field's kind (`register`, `counter`, `set`, `list`, `text`, `tree`: as `after` holds it, or as `before` held a field that is gone), `was` the kind `before` held a field as where the op left it of another (a delete whose data lies under a counter's name, a migration that made a counter a register; absent otherwise), `embeds` the markers of a text's embed slots by index on each side, when a side holds any; `op.msg` the transaction's message. It fires after `afterWrite` and the `Document`'s `update`, before `change`; a transaction's fire once it has landed whole, in op order |
| `transaction` | `({ local, via, source, message, ops, changes, ts, eventId })` | One turn's ops durable and announced, after their `change` events: a local write (`ops` one), a `transact()` (its ops, `source` and `message`), a peer's page (`local` false, `via` the peer), a joined snapshot (`local` true, `via` the host) — `changes` every op's, tagged with its record `id`, `ts` the last op's stamp, `eventId` the log position of the turn's last op, where a reader of the turns resumes from (`log.since`) |
| `apply` | `({ via, peer, ops, applied, skipped, duplicates, gaps, malformed, unsigned, forged, outOfScope, equivocations })` | A peer's batch is durable — `ops` are the accepted ones, skipped included; see [the apply result](#the-apply-result) |
| `conflict` | `({ kind: 'unique', entity, fields, id, other, op })` or `({ kind: 'register', id, field, op, winner: { ts, origin, value }, loser: { ts, origin, value } })` | A peer's op left a unique key shared by two records (both kept: the application decides which yields); or a peer's register write (a `set`'s or `write`'s field) was stamped below the one this node holds — both made without seeing the other, the newer stamp won on every node, and the op is applied for its other fields all the same; `winner` is what the field reads as here, `loser` what the op carried. Only the apply path loses: a local write is stamped above everything the node holds |
| `schema` | `({ kind: 'drift', peer, version, hash, local })` / `({ kind: 'ahead', op, held })` | A peer runs this node's schema version with another snapshot hash (reported after hello on both sides; the link stays up); a peer's op is from a newer version — applied as it is (`held` false) or held (`held` true) |
| `error` | `(error)` with `error.code`: `error.op`, and `error.rejected` (`[{ field, reason, detail?, count?, max? }]`) or `error.entity` + `error.issues`; `error.count` for a signature; `error.ids` for `UNPERSISTED` | A peer's op the engine refused (`OP_REFUSED`) — `reason` the kind holding the field when it outranks the op's, `bound` past a limit (`detail`: `pending`, `run`, `field`, `cuts`, `marks`, `moves`, `counter` or `paths`), `malformed` for a payload it does not admit; skipped as invalid under this node's schema (`OP_INVALID`) or because its record's file cannot be read (`OP_UNREADABLE`), stamped beyond `sync.maxSkew` (`SKEW`); a page's ops refused for their signature (`BAD_SIGNATURE`, `UNSIGNED`) or for forking a stream (`EQUIVOCATION`); logged ops whose record files could not be written (`UNPERSISTED`); the engine's lease gone to another instance (`LEASE_LOST`, `path`) or a follower's change stream ended (`FOLLOW_LOST`, `path`: subscribed again, every record read again); a pipeline's handler threw (`PIPELINE_FAILED`); a collection's bulk write whose `afterWrite` hook threw after the rows landed (`HOOK_FAILED`). The fields of each code: [`SyncomError`](./api#syncomerror) |
| `log` | `({ kind: 'roll', sealed, dropped, floor, segments })` | The op log sealed a segment, and compacted `dropped` of them; `floor` is where a resume is still possible ([the log](./wire#the-log)) |
| `lease` | `({ state: 'renewed' \| 'late' \| 'lost', path })` | The engine's lease on the database (MongoDB) was renewed; a renewal failed and is being retried (`late`, once per run of failures); it went to another instance or was given up (`lost`, with the `error` event `LEASE_LOST`) |
| `close` | — | After `close()` sealed the log |
| `local` | `({ key, value })` | A [local document](../guide/local) written (`value`) or deleted (`null`) through `db.local` or a collection's — never an op, so no `change`; the `local` plugin's |

## Changes

Every op announced carries what the reading shows of it — the third argument of `change` (`{ changes }`),
`commit`'s `changes`, `transaction`'s `changes` (each tagged with its record `id`), what `observe()` hands a
listener — in the write API's terms and the reading's indices, one change per thing the op did:

| `action` | Fields | From |
| --- | --- | --- |
| `put` | `field`, `value` | a register written — a field of a `set` or a `write` |
| `unset` | `field` | a field gone: an `unset`, a field a `write` left out, one pruned under a prefix |
| `reset` | `field`, `kind`, `value` | a field changed whole another way: reset by a whole-record write, outranked by another kind, pruned under a prefix, joined from a snapshot — `value` its whole reading |
| `inc` | `field`, `value` | a counter's increment |
| `add`, `remove` | `field`, `elements` | the set elements that came in, or went out |
| `splice` | `field`, `index`, `count`, `content?`, `marks?` | a list or text cut (`count`, in the indices before the op, last first) or insert (`content`, in the indices after; a text's insert with the `marks` it reads with — one it landed inside, one that grew over it) |
| `setAt` | `field`, `index`, `value` | a list element's value, or a text slot's marker |
| `move` | `field`, `from`, `to` | a list element moved |
| `mark` | `field`, `start`, `end`, `name`, `value`, `markId?` | a mark over the indices its anchors fall at, less those a newer mark of its name holds (a peer's older mark arriving late changes what that one leaves) |
| `unmarkById` | `field`, `markId`, `start`, `end`, `name` | a stacking mark switched off |
| `treeMove` | `field`, `node`, `parent`, `after` | a tree node moved: the node, its parent and the sibling before it — and the nodes that followed it where it was and where it is |
| `treeRemove` | `field`, `node` | a tree node removed with its subtree |
| `delete` | `data?` | the record deleted; `data` the fields the tombstone carries |
| `purge` | `type?` | the record purged; `type` the collection it was of |

A slot inserted and its marker changed in one turn reads as the insert of the marker it ends with. Applied
to the reading before the op, in order, the changes give the reading after — what a view or an editor binding
updates itself by without reading the record again. They are computed as the op is applied, from the block it
lands in (a splice's indices in O(log n)), never by diffing two readings; a peer's op reports what it changed
*here*, which is less than it changed where it was made when a concurrent op had already taken part of it.
`toDelta(changes, field)` of the `text` plugin composes a text's changes into one delta (`null` for a change
no delta can say: a `reset`, an `unset` — read the field again then).

## Document events

A `Document` emits `update` `(data, delta)` on a staged assignment and when the record changes in storage
(`null` data once deleted) — once per transaction that changed it, with the delta of all its ops.

## Collection events

A collection (`db.Task`) emits what the catalog decides of its records, once per landing of a record of
its own, on a microtask after the landing: the row is in the catalog by then, a listener never holds the
write, and the write resolves after its listeners ran.

| Event | Payload | When |
| --- | --- | --- |
| `change` | `({ id, action })` | Any of the three below; `action` is `'insert'`, `'update'` or `'remove'` |
| `insert` | `({ id })` | A record joined the collection: written, or revived by a whole-record write (an edit of a field on a deleted record tells nothing: delete wins) |
| `update` | `({ id })` | A record of the collection changed and stayed in it |
| `remove` | `({ id })` | A record left it: deleted, purged, encrypted, or of another collection now |

The catalog's subscription is taken at the first `on()` and let go of with the last listener (an `off()`,
a `once()` that fired).

## Observers

`db.observe(id, path?, listener)` calls `listener(changes, event)` after every turn that changed the
record — with its changes of that turn and the `transaction` event they came in — and, under a `path`,
with the changes of that field, of what hangs under it and of a prefix of it; it returns the function that
stops it. A `Document` has `observe(path?, listener)` too. Observers are fed by one `transaction` listener
taken at the first `observe()` and stand apart from the listener count: a view per record is the intended
scale. A listener that throws is contained like an event listener.

## Sync manager events

`db.sync.on(event, listener)`:

| Event | Payload | When |
| --- | --- | --- |
| `start` / `stop` | — | Dialling began / every link was closed |
| `node` | `({ url, action })` | The registry changed: `'add'`, `'remove'`, `'enable'`, `'disable'` |
| `connect` | `({ url })` | A link was accepted, before hello |
| `peer` | `({ url, connected, node?, reconnected?, schema? })` | Hello answered (with the host's `node` id and `schema`), the link closed, or it came back |
| `sync` | `({ url, pushed })` / `({ url, received, applied, skipped, duplicates, gaps, malformed, unsigned, forged, outOfScope, equivocations })` | A push went out / a page came in |
| `bootstrap` | `({ url, records })` | A host's whole state was joined |
| `error` | `(error)` with `error.url` | A failure on the way to a peer — a refused link, a failed push, a hook that threw, a page that failed (`PAGE_FAILED` with `cursor` and `attempt`, `STUCK` the third in a row), five fresh hellos answered 428 (`HANDSHAKE_LOOP`), a host that holds more of this node's ops than its log (`REWOUND`) or lacks ones its log no longer holds (`UNDELIVERABLE`), scopes taken back (`REVOKED`); a refusal the host answered with comes as the link delivered it, a numeric `code` |
| `hello` | `({ node, scopes, schema })` | Hosting side: a peer greeted this node and was authorized |
| `refused` | `({ node, reason, count, via? })` | Hosting side: what a peer sent was refused — ops `'scope'` (outside the peer's scopes), `'forged'`, `'unsigned'`, `'equivocation'`, `'rule'` (`authorizeWrite` said no); a presence update `'PRESENCE_RATE'`, `'PRESENCE_MALFORMED'`, `'PRESENCE_SCOPE'`, `'PRESENCE_FORGED'`, `'PRESENCE_UNSIGNED'`, `'PRESENCE_UNPROVEN'`, or one before hello (`'HELLO'`, `node` null); `via: 'inbox'` where the ops came through a follower's forward over the shared log, judged by the writer |
| `revoke` | `({ node, scopes, via? })` | Hosting side: `sync.revoke(node, scopes)` took scopes back from a peer; `via: 'shared'` where the revocation came from another hub over the shared log |

## Other emitters

These follow the same delivery rules; their events are declared beside them.

| Emitter | Events | Declared in |
| --- | --- | --- |
| The shared facade (`openShared()`, `@alexify/syncom/shared`) | `leader`, `follower`, `rebind` (`{ path, generation }`), `error` (`PROMOTE_FAILED` and the current instance's) | `src/shared/shared.d.ts` |
| A presence room (`@alexify/syncom/presence`) | `change` (`{ added, updated, removed }`), `update`, `refused` | `src/presence/presence.d.ts` |
| A connector (`replicate()`, `@alexify/syncom/connector`) | `received`, `sent`, `conflict`, `refused`, `error` (`REPLICATION_FAILED`), `active` (a boolean) | `src/connector/connector.d.ts` |
| An undo manager (`@alexify/syncom/undo`) | `push`, `pop`, `change` | `src/undo/undo.d.ts` |
| A text handle (`openText()`) | `error` (`UNLOGGED`), and `observe(listener)` | `index.d.ts` (`TextHandle`) |

## `HookError`

What an operation rejects with when one of its hooks threw: `name` `'HookError'`, `code` `'HOOK_FAILED'`,
`hook` (the hook's name), `cause` (the original error). A `SyncomError`; exported from the package root.

```js
try {
  await db.Task.insert({});
} catch (error) {
  error instanceof HookError; // true
  error.code; // 'HOOK_FAILED'
  error.hook; // 'beforeWrite'
  error.cause.message; // what the hook threw
}
```

For a `before*` hook the operation did not happen. For an `after*` hook it did — the op is committed and
announced; only the caller's promise rejects. A collection's bulk write whose `afterWrite` failed after
the rows landed answers its verdicts instead, logs `hook.failed` at warn and hands the `HookError` to the
database's `error` event.
