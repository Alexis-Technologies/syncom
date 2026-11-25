---
title: Schema validation
description: Check every write with the validator you already use (metaschema, a Standard Schema such as zod, Ajv or a function) and re-check every op a peer sends.
---

# Schema validation

Give a collection a validator and syncom checks every write to it before anything is logged. The validator sees
the record as the write would leave it; a refusal throws and stores nothing, and what the validator returns, with
its defaults filled in and its values cleaned up, is what gets stored and replicated. syncom ships no validation
library: you bring the one you use, and every node runs it again on the ops it receives from peers.

The validator is part of a collection's definition. [Schema](./schema) shows how to define entities, their indexes
and their versions; this page is about what happens on a write.

## Validate a collection

Put the validator under the entity's `schema` key. This one is a [metaschema](https://metaschema.vercel.app)
`Schema`, which describes the task board's fields once for the client and the server:

<<< @/examples/schema-validation.mjs#validate

The insert did not name `done`, and the stored record has `done: false`: the validator filled in its default, and
syncom stored the validator's output rather than the data you passed. The validator sees the record without
`$type`, the field syncom adds to name the collection.

Validation is the `schema` plugin's job. `@alexify/syncom/all` registers it; with the lean core, add `schema` from
`@alexify/syncom/schema` to `plugins`, or `createDatabase({ schema })` rejects with `ALX_ERR_PLUGIN_MISSING`
([Installation](./install#pick-only-the-plugins-you-need) shows the lean setup).

## Handle a refused write

A write the validator refuses rejects with a `ValidationError`:

<<< @/examples/schema-validation.mjs#refused

`error.issues` lists every problem as `{ path, message, code }`, whatever validator produced it: syncom reads a
Standard Schema's issues and Ajv's errors (`instancePath`, `keyword`) into the same shape, and keeps the original
error as `error.cause` when your validator threw one of its own. Nothing was stamped, logged or written, so there
is nothing to undo; show the issues next to the form fields and let the user try again.

## Every write is checked, not only inserts

The validator runs on every write that changes a record: `insert()`, `set()`, `update()`, a document's `save()`,
`inc()`, `add()`, `remove()`, and every list, text and tree edit. Each time it sees the whole record as the write
leaves it, so an `update()` that names one field is checked together with the fields the record already has:

<<< @/examples/schema-validation.mjs#every-write

A counter is checked as the number it adds up to, and a set as the array of its elements. A key the schema does
not know is refused too: metaschema rejects unknown keys unless the schema says otherwise. `delete()` and `purge()`
are not validated.

An `update()` stays an update. Of what the validator returns, syncom writes only the keys you named (in their
validated form) and the keys the record did not have yet, such as a default. It never turns your update into a
whole-record write, because that would erase what other nodes changed in the same record at the same time. So
write a field by its own name: an update under an alias of a field the record already has changes nothing.

## Check data without writing it

`check()` runs a collection's validator exactly as a write would and resolves to the validated value, without
writing anything:

<<< @/examples/schema-validation.mjs#check

Use it to validate a form before the user submits it, or to clean up data you are about to import.

## Bring your own validator

An entity's `schema` takes any of three shapes, and the package requires none of them:

- a **Standard Schema**: anything with a [`~standard`](https://standardschema.dev) property, such as a zod v4,
  valibot or arktype schema, or a metaschema `Schema`;
- a **function** that throws on a bad value and returns the value, or nothing, on a good one; an Ajv-compiled
  validator (returning `false` with `fn.errors`) fits too;
- a **plain object**, such as a JSON Schema, compiled by the `validator` you pass to `createDatabase()`.

What `~standard` asks for is one `validate()` that answers `{ value }` or `{ issues }`:

<<< @/examples/schema-validation.mjs#standard

A function validator can also transform the record. Whatever it returns is stored:

<<< @/examples/schema-validation.mjs#function

A plain object needs a compiler. `createDatabase({ validator })` calls its `compile(schema, { entity })` once per
entity and uses the function it returns; an Ajv instance has exactly that method:

<<< @/examples/schema-validation.mjs#compile

The record's id is handed to the validator under an id field: `id` when the schema shows an `id` field or shows no
fields at all (a function, a JSON Schema), `taskId` (metaschema's convention for an entity named `Task`) when it
shows that one, and no id at all when the schema shows its fields and has neither, like the metaschema `Task` at the
top of this page. syncom takes the id out of the validator's output again. Set `idField` on the entity to choose. A
schema you want for its indexes but not run, such as a metaschema definition, takes `validate: false`.

## Validate what peers send

Every node validates the ops it receives against its own schema, so a server re-checks what a client pushes even
when the client runs an old build that validates nothing:

<<< @/examples/schema-validation.mjs#peer

A peer's op is never rewritten. An op that would leave the record invalid is skipped here but still logged and
relayed, so the stream it belongs to has no gap, and the node reports it through its `error` event with
`code: 'ALX_ERR_OP_INVALID'`, `entity` and `issues` (and the `syncom.ops.rejected` metric, reason `validation`, when
[telemetry](./telemetry) is on). The laptop keeps the empty task it wrote: the two nodes now disagree about that
record, and only a new write fixes it. Because the op is not rewritten, a default the server's validator would add
is not added to a peer's record either.

The fix for both is the same: give every node the same schema, for example one metaschema model file shared by the
web app and the server. To refuse a write and tell the writer why, use a host rule instead
(`authorizeWrite`, see [Server](./server)). A peer on another schema version is a different case, covered by
[Schema migration](./migration-schema).

## Check a rule that spans two fields

A task has a `starts` day and a `due` day, and it must not start after it is due. Put that rule in the validator
and two people can break the board without either of them writing anything invalid. The setup is a server and two
nodes, and a helper that edits one task on both nodes while they are offline:

<<< @/examples/schema-validation-order.mjs#nodes

With the rule in every node's validator, the three nodes end up with two different tasks:

<<< @/examples/schema-validation-order.mjs#split

Each edit was valid where it was made: `5..10` on the laptop, `1..3` on the phone. Together they would read
`5..3`, so whichever edit a node receives second is the one its validator skips. The server and the laptop got the
phone's edit second and skipped it. The phone got the laptop's edit second and skipped that one instead. Every
node reported `ALX_ERR_OP_INVALID`, and every node runs the same schema, so sharing the schema does not help here. The
nodes stay apart until someone writes both fields again.

This happens only with a rule whose verdict depends on more than the field being written. A rule about one field
(a type, a length, a range, a pattern) gives the same verdict on every node, because an edit that was valid where
it was made is valid wherever it arrives. So keep validators to rules of that kind, and ask a rule that spans
fields once, at the node every write passes through:

<<< @/examples/schema-validation-order.mjs#rule

The server's `authorizeWrite` sees each pushed op with the record as the op would leave it. It refused the phone's
edit, no node applied it, and the phone was told (`ALX_ERR_WRITE_REFUSED`) and took its `due` back from the server, so all
three nodes read `5..10`. Leave the rule out of the nodes' validators when you do this: a node whose validator
skips the other edit before the server's answer arrives would keep its own `starts`.

Two other ways avoid the problem without a server rule. Write the fields that belong together as one field, such
as `window: { starts, due }`: it is then one [register](./glossary#register), and the later write wins whole
([Fields that merge](./fields)). Or check the rule only on the user's own writes, in a `beforeWrite`
[hook](./hooks), which peers' ops never pass through; the nodes then always agree, but a record two people edited
at once can break the rule, and your app has to show that.

## Limitations

- **A rule over several fields can leave nodes apart.** Two edits that are each valid can be invalid together, and
  each node skips the one it received second. Keep such rules out of validators
  ([above](#check-a-rule-that-spans-two-fields)).

- **Every write pays for the validator.** It runs inside the write path and sees the whole record, for every edit
  of a text field of a validated record too. Keep validators of collections that hold long texts cheap.
- **The validator's value is stored as JSON.** A `Date` a decoder produced is stored as the string it serializes to.
- **Validation cannot see other records.** Uniqueness across records is a `unique` index, not a validator rule
  (see [Schema](./schema)).
- **An op from a newer schema version is applied unvalidated by default**, since this node's validator does not
  know its shape; [Schema migration](./migration-schema) explains how to hold such ops instead.

## Coming from RxDB

In RxDB, validation is a wrapper around the storage built on one JSON Schema library, checked against the
collection's JSON schema. In syncom the validator is whatever the entity carries, its output is what gets stored,
and the same check runs on the ops that arrive from other nodes, not only on local writes.

::: code-group

<<< @/examples/schema-validation.mjs#validate [syncom]

<<< @/examples/rxdb/schema-validation.mjs#validate [RxDB]

:::

<FromRxdb page="schema-validation" :rows="['validators', 'validatorOutput', 'checkOnly', 'serverValidation', 'peerValidation']" />

The full list of entity options is in the [API reference](../reference/api#schema-subpath), and the error's fields
under [`ValidationError`](../reference/api#validationerror).
