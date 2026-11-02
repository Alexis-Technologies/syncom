# Local documents

`@alexify/syncom/local` keeps values beside the records that never become an op — not logged, not in the
catalog or a snapshot, never at a peer: the window's layout, a draft, a filter, what one node keeps for
itself. Register the plugin and the database has `db.local`.

```js
const { createDatabase } = require('@alexify/syncom');
const { local } = require('@alexify/syncom/local');

const db = await createDatabase({ path: 'data', plugins: [local] });
await db.local.set('layout', { panel: 320 }); // { panel: 320 }
await db.local.get('layout');                 // { panel: 320 }
await db.local.list();                        // ['layout']
await db.local.delete('layout');
```

A value is JSON; a key is a kv key — a text of at most 255 characters without `/`. `@alexify/syncom/all`
registers the plugin.

## A collection's store

`collection.local` is the same store under the collection's prefix: `db.Post.local.set('filter', 'open')`
writes the key `Post.filter`, and `db.Post.local.list()` lists the keys of that prefix without it.

## Following a value

`observe(key, listener)` calls the listener after every `set` and `delete` of the key in this instance
(`null` once deleted) and returns the stop; the database emits `local` (`{ key, value }`, the full key) on
every write. `toStore(db.local, key)` of `@alexify/syncom/store` is a store of the value, for a framework.

```js
const stop = db.local.observe('layout', (value) => render(value));
db.on('local', ({ key, value }) => console.log(key, value));
```

Another instance over one engine hears nothing: a local document is one node's. A follower
(`readOnly: true`) cannot write one.

## What it is not

A local document is kept across a reopen and swept by `drop()`, and `copyEngine()` carries the `local`
namespace along; it is never replicated, never validated, never versioned. For state several nodes share,
use a record — or [app state](./database#app-state) over one.
