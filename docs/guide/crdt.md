# CRDT deltas

`diff`, `merge` and `apply` are pure functions over plain objects. They have
no dependency on storage, the chain or the filesystem — you can use them on
their own.

```js
const { diff, merge, apply } = require('@alexify/syncom');
```

## `diff(source, target)`

Returns the change that turns `source` into `target`.

```js
diff({ a: 1, b: 2 }, { a: 1, b: 3 });   // { b: 3 }
diff({ a: 1 }, { a: 1, b: 2 });         // { b: 2 }
diff({ a: 1, b: 2 }, { a: 1 });         // { b: undefined }
```

A key that disappeared is reported as `undefined` — that is the deletion
marker `merge` understands.

Nested objects recurse, and only the changed leaves come back:

```js
diff({ user: { name: 'Ada', age: 36 } }, { user: { name: 'Ada', age: 37 } });
// { user: { age: 37 } }
```

Arrays and `Set`s are treated as **grow-only sets** — the diff is what the
target added, never what it removed:

```js
diff({ tags: ['a', 'b'] }, { tags: ['b', 'c'] }); // { tags: ['c'] }
```

## `merge(source, delta)`

Applies a delta. The rules are what make concurrent merges converge:

| Value in delta | Behaviour |
| --- | --- |
| `undefined` | deletes the key |
| array or `Set` | unions with the existing collection |
| object | merges recursively |
| number, where the target is also a number | **adds** — this is the counter CRDT |
| anything else | replaces |

```js
merge({ a: 1 }, { b: 2 });                 // { a: 1, b: 2 }
merge({ a: 1, b: 2 }, { b: undefined });   // { a: 1 }
merge({ tags: ['a'] }, { tags: ['b'] });   // { tags: ['a', 'b'] }
merge({ hits: 10 }, { hits: 1 });          // { hits: 11 }  ← added, not replaced
merge({ user: { a: 1 } }, { user: { b: 2 } }); // { user: { a: 1, b: 2 } }
```

::: warning Numbers add, they do not replace
`merge({ hits: 10 }, { hits: 1 })` is `11`, not `1`. This is deliberate — it is
what lets two peers each increment a counter and converge — but it means a
delta produced by `diff` is **not** interchangeable with a plain object patch
when numeric fields are involved. `diff({ hits: 10 }, { hits: 3 })` yields
`{ hits: 3 }`, and merging that gives `13`.

For absolute numeric values, write them through `Storage.set` rather than
routing them through `merge`.
:::

`merge` never mutates its arguments; it returns a new object (or array).

## `apply(source, history)`

Replays an operation log onto a starting state. Records that are not objects,
or whose `type` is unrecognised, are skipped.

| `type` | Effect |
| --- | --- |
| `write` | replaces the state with `record.data` — a full record write; a bare `write` without data copies the state forward |
| `delta` | `merge(state, record.data)` |
| `delete` | removes `record.key`; without a `key` (Storage's `{ type: 'delete', id }`) the record is gone and the state becomes `{}` |
| `inc` | adds `record.value` to `record.key` |
| `dec` | subtracts `record.value` from `record.key` |

```js
apply({ hits: 0 }, [
  { type: 'inc', key: 'hits', value: 5 },
  { type: 'inc', key: 'hits', value: 3 },
  { type: 'dec', key: 'hits', value: 2 },
]);
// { hits: 6 }
```

## Where storage uses them

Storage does **not** replicate through `merge`. Its writes are typed
operations — `write`, `set`, `inc`, `add`, `remove`, `delete` — applied with
last-writer-wins registers, per-origin counters and observed-remove sets,
because a delta that *adds* numbers cannot tell `hits = 3` from `hits += 3`,
and one that unions arrays can never take an element out. See [Sync](./sync#operations) for that
model. `diff`, `merge` and `apply` remain what they are here: standalone
helpers for plain objects.
