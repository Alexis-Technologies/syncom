---
layout: home

title: syncom
titleTemplate: Distributed data sync engine for Node.js and the browser

hero:
  name: syncom
  text: Distributed Data Sync Engine
  tagline: Replicate application data between servers, browsers and peers. Every write is an op in a persisted log, so peers resume where they stopped, newcomers bootstrap from a snapshot, and every replica converges without a coordinator. Storage, schema and queries are included, and there are no runtime dependencies.
  image:
    src: /logo-mark.svg
    alt: syncom
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Why syncom?
      link: /guide/why
    - theme: alt
      text: Compare with alternatives
      link: /guide/comparison

features:
  - icon: 🔄
    title: Ops that converge
    details: "Every write is an op: last-writer-wins per field, counters whose increments add up across nodes, tombstones that a newer write revives. Applied in any order, any number of times, every node ends up with the same records."
    link: /guide/sync#registers-and-counters
    linkText: Registers and counters
  - icon: ⏯️
    title: Resume and bootstrap
    details: "A peer that reconnects picks up from the last event id it saw. One that was away longer than the host keeps its log, or a new one, joins from a streamed snapshot, a page at a time."
    link: /guide/sync#bootstrap
    linkText: Bootstrap
  - icon: 🕸️
    title: Mesh, hubs, WebRTC
    details: "Every node can dial and host: a hub on a server, a tab that dials it, browsers that reach each other over WebRTC, hubs in several regions that dial each other. There is no coordinator and no service to run."
    link: /guide/scaling
    linkText: Scaling
  - icon: 🎯
    title: Scopes the host enforces
    details: "Partial replication: a record belongs to a scope and a peer is granted scopes. The host drops the ops a peer may not write, and its feed and snapshots serve only what that peer may read."
    link: /guide/sync#scopes
    linkText: Scopes
  - icon: 🔌
    title: wrpc as the transport
    details: "Mount storage.sync.unit() on a wrpc server and dial it with a WrpcClient, over WebSocket or a WebRTC peer link. Reconnects, resumable subscriptions, binary snapshot streams and rate limits come from wrpc."
    link: /guide/wrpc
    linkText: wrpc transport
  - icon: 💾
    title: Storage with schema and queries
    details: "Records on node:fs, OPFS, IndexedDB or memory. A metaschema, Standard Schema or ajv validator runs on every write and on every hub, versions ride on ops, and Mango queries come with indexes, unique keys and watch()."
    link: /guide/storage
    linkText: Storage
  - icon: 🔗
    title: A log you can verify and purge
    details: "Writes can be committed to a hash-linked chain that reads re-check, so corruption surfaces as an error, not as data. purge() scrubs a payload out of the op log, and repair(id) rebuilds a record from it."
    link: /guide/chain
    linkText: Blockchain log
  - icon: 📈
    title: Observable and hookable
    details: "Hooks run your code inside a write, a read or a peer's batch, and events can never break one. OpenTelemetry spans and metrics come from what you inject, and every failure is a SyncomError with a code."
    link: /guide/telemetry
    linkText: OpenTelemetry
  - icon: 📦
    title: Zero dependencies, about 37 KB
    details: "Nothing is installed with it. The same API on Node.js and in the browser, picked by the browser export condition, and about 37 KB min+gzip for the browser, held to a budget in CI."
    link: /guide/browser
    linkText: Browser
---

<script setup>
import BenchCompare from './.vitepress/theme/components/BenchCompare.vue';
</script>

## Benchmarks

syncom is measured against Yjs, Automerge, Loro, TinyBase, PouchDB, RxDB, Fireproof, GUN and
OrbitDB on the same scenarios, in memory and on disk. Each library runs in a fresh process, is used
the way its documentation shows, and is checked to give the right answer before it is timed. The
chart shows an empty replica pulling a store of 1,000 records; pick another scenario or storage.
syncom replicates in memory as fast as Yjs and Loro, has the fastest cold start (34 ms), and
serves about a million reads a second from its cache. Its writes cost more, because each one is
logged, filed, catalogued and chained: on disk about 1,500 a second, where the LevelDB-backed
libraries do about 20,000.

<BenchCompare kind="sync" line="memory" />

[Every scenario, the method, the cold start, the bundle sizes and syncom's own benchmarks →](/guide/benchmarks)
