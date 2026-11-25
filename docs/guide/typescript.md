---
title: TypeScript
description: How syncom types a database from its options, records from a Standard Schema or a Schema annotation, and plugin methods from the plugins you pass.
---

# TypeScript

syncom ships hand-written types beside every entry, so there is nothing to install or generate. A
database is typed by what you pass to `createDatabase()`: a collection per entity of the `schema`, the
records of each collection from that entity's validator or from an annotation, and the methods of every
plugin in `plugins`. All of it is inferred; you never pass a type argument to open a database.

## Type records from a Standard Schema

An entity whose `schema` is a [Standard Schema](https://standardschema.dev) declares its types under
`~standard.types`, and the collection takes them. Here the schema is a
[metaschema](https://metaschema.vercel.app) one; a zod, valibot or arktype schema types the collection the
same way.

<<< @/examples/typescript.mts#standard

The collection has two record types. What a write takes is the schema's input, so `done`, which has a
default, is optional in `insert()`. What a read returns is the schema's output, where `done` is always a
boolean. A query row is the record with its `id`.

Mistakes in field names and value types are compile errors. A dotted path is a string the types cannot
follow, so it is let through:

<<< @/examples/typescript.mts#mistakes

The validator still runs at run time: the types catch your mistakes, and the [schema](./schema) catches
the data that arrives from a form, a file or a peer.

## Declare record types with `Schema<Shapes>`

When an entity has no validator, or one that declares no types (a JSON Schema object, an ajv function),
annotate the schema instead. `Schema<{ Task: Task }>` carries the record types for the compiler alone;
nothing reads them at run time.

<<< @/examples/typescript-shapes.mts#shapes

An entity without a validator and without an annotation reads as `RecordData`, which is
`Record<string, unknown>`.

## What a typed collection gives

`R` below is the record as it reads, and `I` what a write takes. They are the same type unless a Standard
Schema tells them apart.

| Member | Type |
| --- | --- |
| `get(id)` | `Promise<R \| null>` |
| `insert(data)`, `upsert(data)`, `insertIfAbsent(data)` | `data: I`; resolves to `SyncomDocument<R>` |
| `set(id, data)` | `data: I` |
| `update(id, delta)` | `delta: Partial<I>`, any field by path (`'profile/city'`), or the update operators |
| `select(query)`, `count(query)` | `MangoQuery<R>`: the record's fields, `id`, or any dotted path; rows are `QueryRow<R>` (`R & { id }`) |
| `document(id)` | `SyncomDocument<R>`: the document's methods plus one property per field of `R` |
| `bulkInsert(rows)` | `rows: I[]`; resolves to `{ success, error }` |

A cursor's `projection()` keeps the row type: a projected row holds only the fields you named, whatever
the type says.

## Type a read outside a collection

The database's own methods work on any record, so they cannot know its type. They take one as a type
argument instead:

<<< @/examples/typescript.mts#readers

A write through the database takes any `object` and checks nothing more, the same as a collection's
writes under `RecordData`.

## Type the methods of your plugins

The methods a plugin adds appear on the database's type only when the plugin is in `plugins`. A call to
a method of a plugin you did not pass is a compile error, as it is a `ALX_ERR_PLUGIN_MISSING` error at run time.
`@alexify/syncom/all` types every method of every plugin it registers.

<<< @/examples/typescript-shapes.mts#plugins

## Live documents

`SyncomDocument<R>` is the document's methods plus a getter and setter per field of `R`. A field named like
a method (`data`, `save`, `delete`) never becomes a property, so read it through `data()`. A field the
entity declares a [reference](./population) reads as a `Reference` at run time, whatever the type says.
Under `RecordData` every property reads as `unknown`.

## In the browser

`browser.d.ts` re-exports every type of the Node.js entry: records, collections and schemas are typed the
same in both builds. What differs is in the subpaths: the hashing, signing and encryption functions of
`@alexify/syncom/signing` and `@alexify/syncom/encryption` return promises in the browser, and their browser
types say so.

## Limitations

- The types follow your declarations, not your data: a record written before a schema change, or by a
  peer on another schema version, can hold fields the types do not know. The validator and the
  [lens](./migration-schema) handle such records at run time.
- A `Map` of entities is opaque to the compiler and adds no collections to the type; use a plain object.

## Coming from RxDB

You do not declare document, collection and database types by hand and pass them back as generics: the
types come from the options you open the database with. The record type comes from your validator or from
one annotation, never from a JSON schema written `as const`.

<FromRxdb page="tutorials/typescript" :rows="['types', 'tsInference', 'typedQueries']" />

The full type surface is in [index.d.ts](https://github.com/Alexis-Technologies/syncom/blob/main/index.d.ts);
[API reference](../reference/api#database) lists every member.
