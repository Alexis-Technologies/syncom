---
title: Document
description: Work with a record as one live object, assign fields and save them, use counters and sets through it, and react when it changes here or on another node.
---

# Document

A document is a live object for one record. Each field is a property you read and assign; `save()`
writes what you assigned; and the document follows every change to the record, whether your app made it or
it came from another node. There is one document per record while you hold it, so every part of your app
that asks for the task gets the same object.

`insert()` resolves to the new record's document, and `document(id)` gives you the document of any record:

<<< @/examples/document.mjs#open

## Change fields and save them

Assigning a property stages a change; it is not written yet. `delta()` shows what is staged, and `save()`
writes all of it as one update.

<<< @/examples/document.mjs#save

The tracked properties come from the record's fields. Assigning a field the record does not have yet
sets an ordinary property that `save()` ignores, so write a new field with `db.Task.update(id, { field })`;
the property appears once the write lands.

## Use counters and sets through the document

A document has the database's field methods with the id already filled in: `inc()`, `add()`, `remove()`
and `unset()`, plus the list, text and tree methods when their plugins are loaded. These write at once,
without `save()`.

<<< @/examples/document.mjs#kinds

Assigning a property and saving it writes a plain field, so it only works for fields that are plain values.
A counter, a set, a list, a text or a tree changes through its own methods; saving an assignment to one is
refused with `ALX_ERR_FIELD_KIND`:

<<< @/examples/document.mjs#not-a-register

## React to changes

A document emits `update` with the record as it now reads and the change that caused it. It fires when
you assign a property, and again whenever the record changes anywhere else: another call in your app, a
transaction, or an operation from a peer.

<<< @/examples/document.mjs#events

A change from elsewhere refreshes the properties, while the edits you staged and did not save yet stay on
top of the new data, so a peer's write never wipes out what the user is typing:

<<< @/examples/document.mjs#elsewhere

When the record is deleted, `update` fires with `null` as the data, and `data()` resolves to `null`:

<<< @/examples/document.mjs#delete

## Watch one field

`observe()` calls your listener after every change to the record, or to one field of it, with the changes
in the terms of the write API: a value put, an increment, the elements added to a set, the characters
spliced into a text.

<<< @/examples/document.mjs#observe

Under a path such as `'profile'`, a listener hears changes to that field and to everything under it.
`observe()` returns the function that stops it.

## Why a document is one live object

Some databases hand you a frozen snapshot per revision, and to see a newer value you fetch the record
again. syncom has no revision to fetch: the record is the merge of every operation that reached this node,
so the document is kept current as operations arrive, and two writes to different fields never conflict.
That is why the document can safely hold your unsaved edits over a peer's change, and why there is no
`_rev` to send back with a write.

A document stays in memory as long as your app holds a reference to it, and a document you hold is never
evicted from the cache. When you no longer hold it, it is collected, and the next `document(id)` builds a
fresh one. What `get()` and queries return are plain copies instead; use them when you only want to read.

## More on documents

- A field the schema declares a reference reads as a `Reference` whose `document()` resolves the target
  record: see [Population](./population).
- A collection's `methods` are functions on every one of its documents: see [ORM methods](./orm).
- A field named like a document method (`data`, `save`, `delete`) does not become a property; read it with
  `data()`.

## Limitations

- A save that is refused (by the validator, or with `ALX_ERR_FIELD_KIND`) keeps the staged changes, and there is
  no method to drop them. Assign the old values back, or write through the collection instead.
- Properties exist for the fields the record has. A new field becomes a property once a write that adds it
  lands.
- `data()` resolves to the record as the document holds it; treat it as read-only, and use `get()` for a
  copy you may change.

## Coming from RxDB

An RxDB document is an immutable snapshot of one revision: `patch()` resolves to a new object, and the
old one keeps the old values. A syncom document is updated in place, so there is no `getLatest()`, and
`doc.$` becomes the `update` event. There is no `_rev`, and you never handle a conflict error on save.

::: code-group

<<< @/examples/document.mjs#save [syncom]

<<< @/examples/rxdb/document.mjs#edit [RxDB]

:::

<FromRxdb page="rx-document" :rows="['documentObjects', 'identity', 'documentObservable', 'patch', 'meta']" />

Every method of a document is in the [API reference](../reference/api#document).
