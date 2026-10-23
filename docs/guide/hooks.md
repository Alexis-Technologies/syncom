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
| `beforeWrite(ctx)` | Inside every local write, after the current record is loaded and before the op is stamped and applied | A plain object replaces `data` (`write` and `set` only; a `TypeError` for anything else) | The write is refused: nothing stamped, logged or written |
| `afterWrite(ctx, op)` | After the write is durable — `op` is the op it became, `null` for an encrypted (local) write; not called when the write changed nothing | Ignored | The call rejects, but the op stays committed and is announced |
| `beforeRead({ id })` | Inside `get(id)`, before the read | Ignored | The read is refused |
| `afterRead({ id }, data)` | Inside `get(id)`, after the read | Anything but `undefined` (including `null`) replaces what the caller sees | The read rejects |
| `beforeApply(ctx)` | Inside `applyRemote`, once per op, after the duplicate/gap checks and before the op is applied | `false` skips the op *here* (see below) | The whole batch is aborted before anything is durable |
| `afterApply(batch)` | After a peer's batch is durable, once per `applyRemote` call | Ignored | The call rejects; the batch stays and is announced |

`ctx` for a write is `{ type, id, data?, key?, value?, meta?, current,
encrypted, source, via, from, v, actor }`: `type` is the op type (`write`,
`set`, `inc`, `add`, `remove`, `delete`, `purge`, `merge`), `data` is the whole record for a `write`
and the delta for a `set`, `key`/`value` belong to an `inc` (the amount), an
`add` or a `remove` (the elements), `current` is the
record as it is now (`null` when absent or deleted — read it, do not change
it), `encrypted` says whether the write is sealed for this node, `source` is
the `Record` whose `save()` this is, `v` is this node's schema version and
`actor` who the op will say made it (`null` when nobody). For a remote op it is `{ op, via, peer, current }`,
where `peer` is `{ url, node }` — `url` is `null` when this node is the host.

The order of a local write:

```
load the record → beforeWrite → apply the op → append to the log → chain block
→ record file → afterWrite → Record 'update' → 'change'
```

and of a page from a peer:

```
per op: malformed (shape, id, skew) / duplicate / gap checks → beforeApply → apply
then:   append to the log → persist the records → afterApply → 'apply' → 'change' × n
```

### Reads stay raw where it matters

`afterRead` changes what `get()` — and everything that reads through it: a
`Record`'s live properties, `Collection.get`, a contract's `DataReader` —
hands back. It does not touch the record: `swap()` compares against the raw
data, `snapshot()` replicates the raw data, `getCachedData()` and `has()` are
raw, and so is what a cursor (`select()`) reads. A `Record` that saved a
redacted field would write the redaction back;
it does not, because `save()` writes only the fields that were assigned.

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
the `error` event rather than a hook.

`applyRemote` reports it: `{ applied, skipped, duplicates, gaps, malformed, unsigned, forged, outOfScope }` —
`applied` counts every accepted op, skipped ones included; `applied - skipped`
reached a record; `malformed`, `unsigned` and `forged` were refused before
anything read them, and `outOfScope` (a host's push) because the record they
write is outside the pushing peer's scopes.

A throwing `beforeApply` aborts the batch before anything is durable. The
sender sees a failed push (on the dialing side its `error` event fires, with
`error.url`), keeps its cursor, and offers the page again at the next
handshake.

### Hooks and the queue

Every local write and every peer batch runs through one mutation queue, and
the write and apply hooks run inside it. A hook that awaits something slow
holds every other write for that long. A hook that *writes* would wait for the
queue, which is waiting for the hook — so a write issued from `beforeWrite`,
`afterWrite`, `beforeApply` or `afterApply` is refused with an error rather
than left to deadlock. Reads (`get`, `has`, `record`) are fine from any hook.
The read hooks run outside the queue: a write issued from `beforeRead` or
`afterRead` simply queues, and a slow read hook holds no write.

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
than a throw.

### Storage

| Event | Payload | When |
| --- | --- | --- |
| `change` | `(op, via)` | Every op applied here; `via` is `null` for a local write, otherwise `{ url, node }` of the peer it came from (`url` null on the hosting side) |
| `apply` | `({ via, peer, ops, applied, skipped, duplicates, gaps, malformed, unsigned, forged, outOfScope })` | A peer's batch is durable — `ops` are the accepted ones, skipped included |
| `conflict` | `({ kind: 'unique', entity, fields, id, other, op })` | A peer's op left a unique key shared by two records — see [Queries](./storage#queries) |
| `schema` | `({ kind: 'drift', … })` / `({ kind: 'ahead', op, held })` | A peer runs this node's schema version with another snapshot hash — see [Schemas](./sync#schemas); a peer's op is from a newer version — see [Reading across versions](./storage#reading-across-versions) |
| `error` | `(error)` with `error.code`: `error.op`, and `error.rejected` or `error.entity` + `error.issues`; `error.count` for a signature; `error.ids` for `UNPERSISTED` | A peer's op refused by the field-kind rule (`OP_REFUSED`), skipped as invalid under this node's [schema](./schema#how-a-write-is-validated) (`OP_INVALID`) or because its record's file cannot be read (`OP_UNREADABLE`), stamped beyond `sync.maxSkew` (`SKEW`); a page's ops refused for their signature (`BAD_SIGNATURE`, `UNSIGNED`); logged ops whose record files could not be written (`UNPERSISTED`) |
| `log` | `({ kind: 'roll', sealed, dropped, floor, segments })` | The op log sealed a segment, and compacted `dropped` of them — see [The log](./sync#the-log) |
| `close` | — | After `close()` sealed the log |

A `Record` emits `update` `(data, delta)` on a staged assignment and when the
record changes in storage (`null` data once deleted).

### SyncManager

| Event | Payload | When |
| --- | --- | --- |
| `start` / `stop` | — | Dialling began / every link was closed |
| `node` | `({ url, action })` | The registry changed: `'add'`, `'remove'`, `'enable'`, `'disable'` |
| `connect` | `({ url })` | A link was accepted, before hello |
| `peer` | `({ url, connected, node?, reconnected?, schema? })` | Hello answered (with the host's `node` id and `schema`), the link closed, or it came back |
| `sync` | `({ url, pushed })` / `({ url, received, applied, skipped, duplicates, gaps, malformed, unsigned, forged, outOfScope })` | A push went out / a page came in |
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
