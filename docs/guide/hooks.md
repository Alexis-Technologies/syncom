# Hooks and events

Two ways to attach code to what a storage does, kept deliberately apart:

- **Hooks** run *inside* an operation. They are configured once, in `open()`,
  one function per name, and awaited where the operation happens — so a hook
  can alter what is written, refuse it, or skip a peer's op. A hook that
  throws fails the operation with a `HookError`; it is never swallowed.
- **Events** are what `on()` subscribes to from the outside, after the fact.
  Any number of listeners, none of which can affect the operation: a listener
  that throws is logged and forgotten, and one that writes back to the storage
  queues behind the write it heard about.

If the code should be able to change the outcome, it is a hook. If it should
only ever watch — metrics, an audit trail, a UI — it is a listener.

```js
const { open, HookError } = require('@alexify/syncom');

const storage = await open({
  path: 'data',
  hooks: {
    beforeWrite: ({ type, data, current }) => {
      if (type === 'delete') return;
      const next = { ...current, ...data };
      if (typeof next.title !== 'string' || next.title.length === 0) {
        throw new Error('title is required');
      }
      // A plain object replaces the data of a write or a set.
      if (type === 'write' || type === 'set') return { ...data, updatedAt: Date.now() };
    },
    afterRead: (ctx, data) => {
      if (data === null || data.ssn === undefined) return;
      return { ...data, ssn: '***' };
    },
  },
  sync: {
    hooks: {
      beforeConnect: (node) => node.url.startsWith('wss://'),
    },
  },
});

storage.on('change', (op, via) => metrics.count('ops', { local: via === null }));
```

An unknown hook name, or a value that is not a function, is a `TypeError` at
`open()` — a hook with a typo that silently never runs is a validation that
silently never runs.

## Storage hooks

| Hook | Runs | Return | Throw |
| --- | --- | --- | --- |
| `beforeWrite(ctx)` | Inside every local write, after the current record is loaded and before the op is stamped and applied — once per op, so once per hunk of `updateText()`, per patch of `applyPatches()`, `restore()` and `compact()`, per op of `migrate()`, and per record a bootstrap joins (`merge`) | A plain object replaces `data` (`write` and `set` only; a `TypeError` for anything else) | The write is refused: nothing stamped, logged or written |
| `afterWrite(ctx, op)` | After the write is durable — outside the mutation queue, in log order, before the call resolves; `op` is the op it became, `null` for an encrypted (local) write; not called when the write changed nothing (a tree move to where the node already is) or was refused | Ignored | The call rejects, but the op stays committed and is announced |
| `beforeRead({ id, at? })` | Inside `get(id)`, before the read — with `at` for a read at a version (`{ tag }` for `at(name).get(id)`), once with `{ id, history: true }` for `history()` | Ignored | The read is refused |
| `afterRead({ id, at? }, data)` | Inside `get(id)`, after the read — with `at` for a read at a version, and per version of `history()` (its event id) | Anything but `undefined` (including `null`) replaces what the caller sees | The read rejects |
| `beforeApply(ctx)` | Inside `applyRemote`, once per op of any kind, after the signature, duplicate, gap and scope checks and before the op is applied; not for an op held for a newer schema (`ahead: 'hold'`) or one on a record this node keeps sealed | `false` skips the op *here* (see below) | The whole batch is aborted before anything is durable |
| `afterApply(batch)` | After a peer's batch is durable, once per `applyRemote` call | Ignored | The call rejects; the batch stays and is announced |

`ctx` for a write is `{ type, id, data?, key?, value?, index?, count?, content?,
to?, start?, end?, name?, expand?, many?, off?, node?, parent?, after?, before?,
meta?, current, encrypted, source, via, from, v, actor }`: `type` is the op
type (`write`, `set`, `inc`, `add`, `remove`, `splice`, `assign`, `move`,
`mark`, `tree`, `delete`, `purge`, `merge`), `data` is the whole record for a
`write` and the delta for a `set`, `key`/`value` belong to an `inc` (the
amount), an `add` or a `remove` (the elements), `key`/`index`/`count`/`content`
(and `vals`, the markers of the embed slots the content holds) to a `splice`,
`key`/`index`/`value` to an `assign`, `key`/`index`/`to` to a
`move`, `key`/`start`/`end`/`name`/`value`/`expand`/`many` (or `off`) to a
`mark`, `key`/`node`/`parent`/`after`/`before` to a `tree` — each the call as
the caller made it, save that a `push()` is a `splice` with `index: null`
(the end), an `unmark()` a `mark` with `value: null` and the reversed expand
rule, an `unmarkById()` a `mark` with `off`, a `treeRemove()` a `tree` with
`parent: '$trash'`, and a `remove` from `applyPatches()` carries `removals`
or `own` as the patch did.
`meta` is the joined metadata of a `merge`. `current` is the
record as it is now (`null` when absent or deleted — read it, do not change
it), `encrypted` says whether the write is sealed for this node, `source` is
the `Record` whose `save()` this is or the `source` given to `applyPatches()`
(`null` otherwise), `v` is this node's schema version and
`actor` who the op will say made it (`null` when nobody). For a remote op it is `{ op, via, peer, current }`,
where `peer` is `{ url, node }` — `url` is `null` when this node is the host —
and `op` is the op as it travels: a `splice`, a `move` or a `tree` names
anchors and places, not the indices of the call that made it (see [What
travels](./lists#what-travels)).

The order of a local write:

```
load the record → beforeWrite → stamp → apply the op → validate → append to the log
│ the queue moves on to the next write here; the rest follows, in log order, once the op is on disk
→ chain block → record file → afterWrite → Record 'update' → 'commit' → 'change'
```

(under [`open({ defer })`](./storage#when-a-record-file-lags-the-log) — 16 ms
by default — the chain block and the record file wait for the flush, after
the events), and of
a page from a peer:

```
the page: signatures checked
per op:   malformed (shape, id, skew) / duplicate / gap checks → the pushing peer's
          scopes (a host) → beforeApply → apply → validate
then:     append to the log → persist the records → afterApply → 'apply' → 'change' × n
```

### Reads stay raw where it matters

`afterRead` changes what `get()` — and everything that reads through it:
`get(id, { at })`, `at(name).get(id)`, each version `history()` hands out,
`Collection.get`, a contract's `DataReader`, a `Record` as it loads — hands
back. It does not touch the record: `swap()` compares against the raw data,
`snapshot()` replicates the raw data, `getCachedData()` and `has()` are raw,
and so is what a cursor (`select()`), `diff()`, `spans()`, `cursor()` and
`index()` read. A `Record` reads through `get()` as it loads and as it follows
a change — a write here, an op from a peer: with `beforeRead` or `afterRead`
set, it is refreshed once the write is done, outside the mutation queue (a
read hook may write), so a redaction holds on a live `Record` for good; a
`beforeRead` that throws then leaves the `Record` as it was. A `Record` that
saved a redacted field would write the redaction back; it does not, because
`save()` writes only the fields that were assigned.

### Skipping a peer's op

`beforeApply` returning `false` leaves *this node's* record alone — and
nothing else. The op is still appended to this node's log, still counted in
the vector, still relayed to the peers behind this node, and still announced
as a `change`. That is not a shortcut: sequence numbers run contiguously per
origin and scope, so an op missing from a log is a gap that stops every later
op of that stream for everyone who resumes from it, and a vector that does not
move has the sender offer the same page forever. Skipping is a local decision;
peers make their own with their own `beforeApply`. A skipped op is flagged in
the log so a reopen's replay of the unsealed tail leaves it alone too. The
same path takes an op that would leave the record invalid under this node's
[schema](./storage#validation): skipped, logged, relayed, and reported through
the `error` event rather than a hook — and a peer's op on a record this node
keeps sealed (`encrypted: true`), which is logged and relayed, never applied.

`applyRemote` reports it: `{ applied, skipped, duplicates, gaps, malformed, unsigned, forged, outOfScope, equivocations }` —
`applied` counts every accepted op, skipped ones included; `applied - skipped`
were applied here — an op older than what the record holds, or one the
engine refused (`OP_REFUSED`: the field is held by a kind that outranks the
op's, a bound, a payload it does not admit), leaves the record as it was and
is logged and relayed all the same, never a gap; `malformed`, `unsigned` and
`forged` were refused before anything read them, `equivocations` because they
fork their writer's stream ([Equivocation](./sync#equivocation)), and
`outOfScope` (a host's push) because the record they write is outside the
pushing peer's scopes.

A throwing `beforeApply` aborts the batch before anything is durable. The
sender sees a failed push (on the dialing side its `error` event fires, with
`error.url`), keeps its cursor, and offers the page again at the next
handshake.

### Hooks and the queue

Every local write and every peer batch runs through one mutation queue, and
the write and apply hooks run inside it. A hook that awaits something slow
holds every other write for that long. A hook that *writes* would wait for the
queue, which is waiting for the hook — so a write issued from `beforeWrite`,
`afterWrite`, `beforeApply` or `afterApply` is refused with a `SyncomError`
(`code: 'IN_HOOK'`) rather than left to deadlock; a hook that awaits it and
lets it throw fails with a `HookError` whose `cause` is that refusal. Reads
(`get`, `has`, `record`) are fine from any hook. The read hooks run outside
the queue: a write issued from `beforeRead` or `afterRead` simply queues, and
a slow read hook holds no write.

## Sync hooks

`open({ sync: { hooks } })`:

| Hook | Runs | Return | Throw |
| --- | --- | --- | --- |
| `beforeConnect(node)` | Before a registered node is dialled — at `start()`, `addNode()` while started, or `enableNode()`. `node` is a copy of the registry entry | `false` leaves it registered but not dialled | Reported through the manager's `error` event, with `error.url` |
| `beforeBootstrap({ url, node })` | When a host's log cannot resume this node and its whole state is about to be joined | `false` refuses: the peer stays connected for pushes but nothing is received from it until the next handshake asks again | Reported through `error` |

There is deliberately no hook on the ops that leave for a peer. Seqs run
contiguously per origin and scope, so an op withheld from one peer is a gap
that stops every later op of that stream at it. Per-peer visibility is what
[scopes](./sync#scopes) are for: a scope is its own stream, and a node only
receives the scopes it asked for.

```js
const storage = await open({
  path: 'data',
  hooks: {
    // Only the admin node may delete anything here.
    beforeApply: ({ op, peer }) => {
      if (op.type === 'delete' && peer?.node !== ADMIN_NODE) return false;
    },
  },
  sync: {
    connect,
    hooks: {
      beforeBootstrap: ({ node }) => trusted.has(node),
    },
  },
});
```

## Events

Every listener is contained: it is invoked at once, never awaited, and if it
throws the failure is logged at `warn` (`{ event: 'listener.error', name }`)
and the operation carries on. `error` with nobody listening is silent rather
than a throw. A function is one listener per event — `on()` with it twice
throws — and an event takes at most `open({ maxListeners })` of them (100 by
default) on the storage and on its sync manager; one more throws.

### Storage

| Event | Payload | When |
| --- | --- | --- |
| `change` | `(op, via, { changes })` | Every op this node logs — a local write, a peer's accepted op (a skipped one included), a bootstrap's `merge` and `advance`; keystrokes sent without waiting that continue each other are one op (typed on at the end of their run, or a chain of cuts), announced once with the changes of each in order; `via` is `null` for a local write, otherwise `{ url, node }` of the peer it came from (`url` null on the hosting side); `changes` what the reading shows of the op, in the write API's terms and the reading's indices (see [Changes](./versions#changes); `[]` for an `advance`, a skipped op) |
| `commit` | `({ op, seq, source, before, after, kinds, embeds? })` | A local write is durable — any kind of op made through the write API, `transact()`, `applyPatches()` and `migrate()` included; never a peer's op, a bootstrap's `merge`, an encrypted write (it makes no op) or a write that changed nothing. `seq` is its log position, `source` the `Record` whose `save()` it was or the `source` given to `transact()`/`applyPatches()` (`null` otherwise), `before`/`after` the record as copies in the op model's terms — every [path](./storage#paths) a field of its own, not composed (`null` when absent or deleted), `kinds` every field's kind before and after (`register`, `counter`, `set`, `list`, `text`, `tree`), `embeds` the markers of a text's [embed slots](./lists#embeds-and-blocks) by index on each side, when a side holds any; `op.msg` the transaction's message — see [The commit event](./versions#the-commit-event); built only while something listens. It fires after `afterWrite` and the `Record`'s `update`, before `change`; a transaction's fire once it has landed whole, in op order |
| `transaction` | `({ local, via, source, message, ops, changes, ts })` | One turn's ops durable and announced, after their `change` events: a local write (`ops` one), a `transact()` (its ops, `source` and `message`), a peer's page (`local` false, `via` the peer), a joined snapshot (`local` true, `via` the host) — `changes` every op's, tagged with its record `id`, `ts` the last op's stamp; built only while something listens |
| `apply` | `({ via, peer, ops, applied, skipped, duplicates, gaps, malformed, unsigned, forged, outOfScope, equivocations })` | A peer's batch is durable — `ops` are the accepted ones, skipped included |
| `conflict` | `({ kind: 'unique', entity, fields, id, other, op })` | A peer's op left a unique key shared by two records — see [Queries](./storage#queries) |
| `schema` | `({ kind: 'drift', … })` / `({ kind: 'ahead', op, held })` | A peer runs this node's schema version with another snapshot hash — see [Schemas](./sync#schemas); a peer's op is from a newer version — see [Reading across versions](./storage#reading-across-versions) |
| `error` | `(error)` with `error.code`: `error.op`, and `error.rejected` (`[{ field, reason, detail?, count?, max? }]`) or `error.entity` + `error.issues`; `error.count` for a signature; `error.ids` for `UNPERSISTED` | A peer's op the engine refused (`OP_REFUSED`) — `reason` the kind holding the field when it outranks the op's, `bound` past a [limit](./lists#costs-and-limits) (`detail`: `pending`, `run` or `field`), `malformed` for a payload it does not admit; skipped as invalid under this node's [schema](./schema#how-a-write-is-validated) (`OP_INVALID`) or because its record's file cannot be read (`OP_UNREADABLE`), stamped beyond `sync.maxSkew` (`SKEW`); a page's ops refused for their signature (`BAD_SIGNATURE`, `UNSIGNED`); logged ops whose record files could not be written (`UNPERSISTED`) |
| `log` | `({ kind: 'roll', sealed, dropped, floor, segments })` | The op log sealed a segment, and compacted `dropped` of them — see [The log](./sync#the-log) |
| `close` | — | After `close()` sealed the log |

A `Record` emits `update` `(data, delta)` on a staged assignment and when the
record changes in storage (`null` data once deleted) — once per transaction
that changed it, with the delta of all its ops.

To follow one record rather than every op, `observe(id, path?, listener)`
calls the listener after every turn that changed the record — with its
[changes](./versions#changes) of that turn and the `transaction` event they
came in — and, under a `path`, with the changes of that field, of what hangs
under it and of a prefix of it; a `Record` has `observe(path?, listener)`
too. Observers stand apart from the listener count: a view per record is
the intended scale.

### SyncManager

| Event | Payload | When |
| --- | --- | --- |
| `start` / `stop` | — | Dialling began / every link was closed |
| `node` | `({ url, action })` | The registry changed: `'add'`, `'remove'`, `'enable'`, `'disable'` |
| `connect` | `({ url })` | A link was accepted, before hello |
| `peer` | `({ url, connected, node?, reconnected?, schema? })` | Hello answered (with the host's `node` id and `schema`), the link closed, or it came back |
| `sync` | `({ url, pushed })` / `({ url, received, applied, skipped, duplicates, gaps, malformed, unsigned, forged, outOfScope, equivocations })` | A push went out / a page came in |
| `bootstrap` | `({ url, records })` | A host's whole state was joined |
| `error` | `(error)` with `error.url` | A failure on the way to a peer — a refused link, a failed push, a hook that threw, a page that failed (`PAGE_FAILED`, `STUCK`), a host that holds more of this node's ops than its log (`REWOUND`) or lacks ones its log no longer holds (`UNDELIVERABLE`) |
| `hello` | `({ node, scopes, schema })` | Hosting side: a peer greeted this node and was authorized |
| `refused` | `({ node, reason, count })` | Hosting side: a push carried ops this node would not take — `'scope'` (outside the peer's scopes), `'forged'`, `'unsigned'` |

## `HookError`

What an operation rejects with when one of its hooks threw:

```js
try {
  await storage.insert({});
} catch (error) {
  error instanceof HookError; // true
  error.code;                 // 'HOOK_FAILED'
  error.hook;                 // 'beforeWrite'
  error.cause.message;        // 'title is required'
}
```

For a `before*` hook the operation did not happen. For an `after*` hook it
did — the op is committed and announced; only the caller's promise rejects.
