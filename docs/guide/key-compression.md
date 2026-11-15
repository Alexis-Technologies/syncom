---
title: Key compression
description: Why syncom does not shorten field names on disk like RxDB's key compression, and how to make data smaller instead.
---

# Key compression

<NotInSyncom page="key-compression" />

RxDB's key compression replaces the field names of every stored document with short tokens derived from
the collection's JSON schema, so that `{ "firstName": "Ada" }` is stored as something like `{ "|a": "Ada" }`.
It saves disk space for documents with many long field names, at the cost of a schema that must be known
to read the data back.

## Why syncom does not do this

A syncom collection does not need a schema, and the nodes of one deployment do not have to run the same
schema version at the same time ([Schema migration](./migration-schema) explains how peers on different
versions keep syncing). A key table derived from a schema would have to be identical on every node and in
every op of the log, which is exactly the coupling syncom avoids. Field names stay as you wrote them, on
disk and in the operations that travel between nodes, so any node can read any record it receives.

## Make data smaller another way

- **On the wire**: wrpc, the transport syncom syncs over, can [compress every message](https://wrpc.vercel.app/guide/compression)
  (deflate, Brotli or zstd). This shrinks replication traffic, where long field names repeat the most.
- **Large binary values**: store them as [attachments](./attachments), which can be gzip- or
  deflate-compressed and are fetched from a peer only when read.
- **On disk**: choose a [storage](./storage) that compresses by itself. MongoDB's default storage engine
  compresses collections; files, IndexedDB and SQLite store the JSON as it is.
- **Short names by choice**: nothing stops you from naming fields `t` and `d`. Most apps should not, because
  readable records are worth more than the bytes.

## Coming from RxDB

If you used key compression to fit more documents into IndexedDB, check the actual size first with
[`quota()`](./health): syncom stores one JSON value per record, and browsers grant far more space than the
old limits suggest. If replication traffic was the concern, compress the transport.

<FromRxdb page="key-compression" :rows="['compression', 'onDiskFormat']" />
