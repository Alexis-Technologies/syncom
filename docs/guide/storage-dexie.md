---
title: Dexie.js
description: Why syncom has no Dexie.js storage, and how its own IndexedDB engine gives you the same browser storage with no dependency.
---

# Dexie.js

<NotInSyncom page="rx-storage-dexie" />

RxDB's Dexie storage stores documents in IndexedDB through Dexie.js, a wrapper library over IndexedDB. It is
RxDB's free IndexedDB option, and it brings Dexie's add-ons, such as Dexie Cloud sync, within reach.

## Why syncom does not have it

syncom has no runtime dependencies, by design: an app ships what it imports, and nothing else to audit or
update. A storage over Dexie would make Dexie one. syncom's IndexedDB engine talks to IndexedDB directly instead,
with one transaction per write and key ranges for every listing, and its queries run over syncom's own catalog,
so nothing of Dexie's query layer would be used. Sync, the other reason to want Dexie's add-ons, is built in
([Sync engine](./replication)).

## Get the same result

Open the database over the [IndexedDB engine](./storage-indexeddb), part of the package:

<<< @/examples/storage-indexeddb.mjs#open

Dexie and syncom can share an origin: give syncom's engine its own IndexedDB database `name`, and keep your
Dexie tables in another.

## Coming from RxDB

A collection that lived in RxDB's Dexie storage moves by exporting it to JSON and inserting the documents into a
syncom collection ([JSON import and export](./import-export)).

<FromRxdb page="rx-storage-dexie" :rows="['indexeddb', 'deps']" />
