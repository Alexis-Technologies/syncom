---
title: localStorage
description: Why syncom ships no localStorage storage, what to use in the browser instead, and a backend of five functions over Web Storage if you need one.
---

# localStorage

<NotInSyncom page="rx-storage-localstorage" />

RxDB's localStorage storage keeps each document as an item of `window.localStorage` and its indexes as JSON
arrays beside them. It needs no setup and adds little to a bundle, which makes it RxDB's suggested start in a
browser.

## Why syncom does not ship one

localStorage holds a few megabytes of strings per origin and answers synchronously on the main thread. A syncom
database writes more than documents (its [operation log](./operation-log) first, then the records, the catalog
and the node's keys), so a small synchronous store fills quickly and blocks the page while it writes. Every
browser that has localStorage also has the two storages syncom ships: [OPFS](./storage-opfs), the default, which
needs no setup either, and [IndexedDB](./storage-indexeddb).

## Get the same result

Open a database with no storage option: in a browser it lands in OPFS. If you need localStorage all the same
(a tiny prototype, an embedded web view without OPFS or IndexedDB), a backend is five functions over a
directory and a file name, and this one passes the backend contract's tests:

<<< @/examples/storage-localstorage.mjs#fsi

<<< @/examples/storage-localstorage.mjs#open

It works with `sessionStorage` or any object with the same calls. Once the quota runs out, a write rejects when
the log cannot take it, or resolves and is held in memory as `UNPERSISTED` when only its record could not be
stored.

## Coming from RxDB

There is nothing to migrate to: start on the default storage, and keep the backend above for the rare place
that has nothing else.

<FromRxdb page="rx-storage-localstorage" :rows="['localStorage', 'customBackend']" />
