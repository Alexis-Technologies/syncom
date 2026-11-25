---
title: Schema
description: Define collections, validate every write with metaschema, zod or your own validator, index and constrain fields, and choose how records get their ids.
---

# Schema

A schema names your collections and, for each one, how its records are checked, indexed and identified.
It is optional: a collection without a validator takes any data, and a database without a schema works by
id alone. syncom has no schema language of its own; it validates through a contract, so a
[metaschema](https://metaschema.vercel.app) model, a [Standard Schema](https://standardschema.dev) such as
zod, or a plain function all work, and none of them is installed with syncom.

The schema is the `schema` plugin, which `@alexify/syncom/all` registers. The smallest schema is a list of
collection names:

<<< @/examples/schema.mjs#bare

## Validate tasks with a metaschema model

metaschema is the first-class fit: one model describes your data for the browser, the server and every
tool between them, and syncom reads everything it needs off each entity. The validator runs on every
write, the `unique` field and the `index` become the catalog's keys, and the id is handed to the validator
under the name the entity expects.

<<< @/examples/schema.mjs#model

What the validator returns is what syncom writes and replicates. Here the alias `name` became `title` and
the default filled in `done`, so every node holds the record in the same shape.

The validator sees each write as the whole record it leaves behind, not only the fields you sent. A
counter or a set is checked as the record reads after the change:

<<< @/examples/schema.mjs#kinds

Fields the model does not name are refused, which is metaschema's default (`unknown: 'reject'`). Declare
every field your app writes, counters and sets included, or give the entity `Registry: { unknown: 'ignore' }`
so that peers on a newer schema can add fields.

## Handle a validation error

A write that fails validation rejects with a `ValidationError` and writes nothing: no operation, no log
entry, nothing sent to peers. Its `issues` say what is wrong, one entry per problem.

<<< @/examples/schema.mjs#error

`code` is `ALX_ERR_VALIDATION_FAILED`, `entity` names the collection, and each issue has a `path`, a `message` and,
where the validator gives one, a `code`. When a validator throws an error of its own, it rides along as
`cause`.

## Check data without writing it

`check()` runs the collection's validator the way a write would and returns the result. Use it to validate
a form before you save, or to see what defaults and aliases will do:

<<< @/examples/schema.mjs#check

## Use zod, valibot or your own validator

An entity's `schema` can be any of three things, and syncom decides which by looking at it:

- a **Standard Schema**: anything with a `~standard` property. zod, valibot, arktype and metaschema schemas
  all are one, so `{ schema: z.object({ name: z.string() }) }` works as it is;
- a **function**: it returns the value to write (or nothing, to write the input as it is) and throws on bad
  input; an ajv-compiled validator, which returns `false` and sets `errors`, fits too;
- a **plain object** such as a JSON Schema, compiled by the `validator` you pass to `createDatabase()`. An
  Ajv instance fits as it is: `createDatabase({ validator: new Ajv(), schema })`.

Here are the first two, written by hand. The Standard Schema trims the name and fills a default role; the
function lowercases a label:

<<< @/examples/schema.mjs#standard

<<< @/examples/schema.mjs#function

<<< @/examples/schema.mjs#validators

Whatever the validator returns is stored as JSON, so a `Date` a decoder produced is stored as the string it
serializes to. A zod or valibot object schema hands syncom its fields too, so the id is passed under `id` if
the schema declares that field; a schema of your own that wants no id gets `idField: false`.

## Index fields for queries

`index` lists the fields and compound keys the catalog keeps sorted, so that [queries](./query) on them
read only what matches. A metaschema model declares them itself; with any other validator, list them on the
entity:

<<< @/examples/schema.mjs#index

A compound key serves queries that match its first fields exactly and range or sort on the next one.
[Query optimizer](./query-optimizer) shows how a query picks an index and how to see the plan.

## Keep a field unique

`unique` lists the fields, or combinations of fields, that no two records of the collection may share. A
metaschema field with `unique: true` declares one; otherwise, name it on the entity
(`unique: ['key', ['board', 'title']]`). A local write that would take a value another record holds is
refused with a `ValidationError` whose issue has `code: 'unique'` and the id of the record that holds it:

<<< @/examples/schema.mjs#unique

Uniqueness holds on one node. Two nodes that write the same key while apart cannot refuse each other's
write, so both records arrive and are kept, and every node that applies the second one emits a `conflict`
event naming both. Your app decides which one yields, and deleting it converges like any other write.

## Choose how records are identified

By default a record's id is minted when you insert it. A collection can take it from the record instead:
`idField` names one field whose value is the id (the field is then left out of the data), and `id` builds
the id from several fields joined by a separator (the fields stay).

<<< @/examples/schema.mjs#ids

An id taken from the data can already be in use. `insert()` then rejects with `ALX_ERR_EXISTS`, decided inside the
database's write queue so that two inserts cannot both pass, while `insertIfAbsent()` returns the record
that is there and `upsert()` overwrites it:

<<< @/examples/schema.mjs#exists

The fields that make a composite id, and a record's collection (`$type`), cannot change once written.

## Know what a peer's write goes through

A write from a peer is validated against this node's schema too, but never rewritten. An operation that
would leave the record invalid here is skipped: it is still logged and passed on to other peers, so each
node judges it for itself, and the database's `error` event reports it with the entity and the issues.
Give every node the same schema and every node reaches the same verdict.

## Evolve the schema

`version` is a positive integer, `1` by default, stamped on every operation the node makes, and `snapshot`
is any JSON that describes the schema (metaschema's `model.toJSON()`). The database remembers the version
it last ran, and `schemaInfo` tells you when it changed:

<<< @/examples/schema.mjs#version

Nodes on different versions keep syncing. A record written under an older version is read through a lens
of migrations you write and the validator's own aliases and defaults; your first write to such a record
migrates it to the new shape, writing only the fields the lens changed, and `migrate()` migrates the rest when
you are ready. [Schema migration](./migration-schema) covers all three.

## Limitations

- A unique key is enforced per node: concurrent writes on two nodes both survive, and you get a `conflict`
  event instead of an error.
- A record written through the database without a collection (`db.insert()` with no `$type`) is not
  validated by any entity's schema.
- Collections added with `addCollections()` are not saved: add them again after every open.

## Coming from RxDB

A collection does not need a JSON schema, a primary key definition or a storage wrapper for validation.
When you do validate, the validator's output is what gets written (defaults, aliases, stripped keys), and
a `unique` key holds for fields other than the id, which RxDB does not offer.

::: code-group

<<< @/examples/schema.mjs#model [syncom]

<<< @/examples/rxdb/schema.mjs#schema [RxDB]

:::

<FromRxdb page="rx-schema" :rows="['schemaless', 'schemaFormat', 'validators', 'validatorOutput', 'unique', 'compositeKey']" />

Every key an entity takes, and the schema's own options, are in the [API reference](../reference/api#schema-subpath).
