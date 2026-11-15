---
title: Overview
description: Every page of the syncom guide, grouped from the first steps to the internals.
---

# syncom documentation

**syncom** is a local-first data engine for JavaScript. Your app reads and writes records on the device,
every write goes into an operation log, and other nodes (servers, browsers, peers) replicate that log and
converge on the same records without a central coordinator. It runs in Node.js and in the browser, with no
runtime dependencies.

New here? Start with the [Quickstart](./quickstart), then read [Sync engine](./replication) to see how
nodes stay in step. If you know RxDB, every page ends with a "Coming from RxDB" section, and
[Compared with RxDB](./vs-rxdb) has the whole comparison.

<DocsOverview />

## Coming from RxDB

The sidebar follows the order of RxDB's documentation, and [Compared with RxDB](./vs-rxdb#page-by-page) lists
every RxDB page with the syncom page that answers it. The biggest difference shows up early: syncom replicates
operations that merge field by field, so the pages about conflicts, revisions and conflict handlers become one
page about [transactions and conflicts](./transactions-conflicts).

<FromRxdb page="overview" :rows="['replModel', 'conflictResolve', 'docs']" />
