# TypeScript

The package ships hand-written types (`index.d.ts`, `browser.d.ts`, one
`.d.ts` beside every subpath), checked by `tsd` against every signature
this page shows. A storage is typed by what `open()` is given: a collection
per entity of the `schema`, the methods of every plugin in `plugins` — both
inferred, no type arguments to pass. The records of a collection are typed
by the schema too, two ways.

## From a Standard Schema

An entity whose `schema` is a [Standard Schema](https://standardschema.dev)
(zod, valibot, arktype, metaschema) declares its types in `~standard.types`,
and the collection takes them: what the validator returns is what a record
reads as, what it accepts is what a write takes.

```ts
import { z } from 'zod';
import { open } from '@alexify/syncom/all';

const Post = z.object({ title: z.string(), likes: z.number().default(0), tags: z.array(z.string()).default([]) });

const storage = await open({ path: 'data', schema: { entities: { Post: { schema: Post, index: ['title'] } } } });

const post = await storage.Post.get(id); // { title: string; likes: number; tags: string[] } | null
await storage.Post.insert({ title: 'Hello' }); // likes and tags have defaults: the input type
await storage.Post.update(id, { likes: 2 }); // Partial of the input
await storage.Post.update(id, { title: 5 }); // error: title is a string
const rows = await storage.Post.select({ likes: { $gt: 1 }, tags: 'news' }).order('title').fetch();
rows[0].likes; // number — a row is the record under its id
const record = await storage.Post.record(id);
record.title; // string — one property per field
```

The two types are `SchemaOutput<S>` and `SchemaInput<S>`; a schema that
declares no types (a JSON Schema object, an ajv function) gives
`RecordData` — `Record<string, unknown>`, the type everywhere the schema
says no more.

## Declared: `Schema<Shapes>`

For an entity whose validator declares no types, or none at all, the schema
carries the record types itself. `Schema<{ Post: Post }>` is a plain
annotation; `shapes` is a phantom property the types alone read — nothing
reads it at run time.

```ts
import { open, type Schema } from '@alexify/syncom/all';

interface Post {
  title: string;
  likes: number;
}
interface Author {
  name: string;
}

const schema: Schema<{ Post: Post; Author: Author }> = { entities: { Post: { index: ['title'] }, Author: {} } };
const storage = await open({ path: 'data', schema });

storage.Post; // SyncomCollection<Post>
await storage.Author.get(id); // Author | null
storage.Nope; // error
```

A `Shapes` value is an object per entity name; a string or a number is
refused where the schema is annotated.

## What a typed collection gives

| Member | Type |
| --- | --- |
| `get(id, { at }?)` | `Promise<R \| null>` |
| `insert(data)` | `data: I`; resolves to `SyncomRecord<R>` |
| `set(id, data)` | `data: I` |
| `update(id, delta)` | `delta: Partial<I> & PathFields` — the record's own fields, or any by path (`'profile/city'`) |
| `select(query?)`, `count(query?)` | `MangoQuery<R>`: the record's fields, `id`, or any dotted path; a cursor of `QueryRow<R>` (`R & { id }`) |
| `record(id)` | `SyncomRecord<R>`: the methods plus one property per field of `R`; `data()` is `R \| null`, `delta()` a `Partial<R>` |

`R` is the record as it reads, `I` what a write takes — the same type
unless a Standard Schema tells them apart. `MangoQuery<R>` matches a field
against a value, an element (an array field holds a scalar value) or the
operators; a name the record has not is an error, a dotted path is not.
A cursor's `projection()` keeps the row type: a projected row has the named
fields only, whatever the type says.

## The storage's own readers

Outside a collection the storage knows no record type; its readers take one
as an argument, or from the annotation of what they are assigned to.

```ts
const post = await storage.get<Post>(id); // Post | null
const same: Post | null = await storage.get(id);
const record = await storage.record<Post>(id); // SyncomRecord<Post>
record.likes = 3;
await record.save();
storage.getCachedData<Post>(id); // Post | null, no I/O
await storage.at('v1').get<Post>(id); // the versions plugin's tag view
await storage.at('v1').collection<Post>('Post').get(id);
await storage.transact((tx) => tx.get<Post>(id));
```

A write takes `object`: `insert`, `set` and `update` on the storage check
nothing beyond that, as the collection's writes do under `RecordData`.

## Live records

`SyncomRecord<R>` is the record's methods and one getter/setter per field
of `R` — a field named like a method (`data`, `save`, `index`, `block`…)
is never a property; `data()` has it. A string field holding a known record
id reads as a `Reference` at run time, whatever the type says. Under
`RecordData` every name reads as `unknown`.

## The browser

`browser.d.ts` re-exports every type of `index.d.ts` — the records, the
collections, the schema types among them — and overrides only the five
crypto functions that return promises there (see [Browser](./browser)).

## Checking the types

```bash
pnpm test:types
```

runs `tsd` over `tests/*.test-d.ts`; every example on this page is among
them (`tests/index.test-d.ts`, `tests/schema.test-d.ts`,
`tests/all.test-d.ts`). A `.d.ts` change lands with its test.
