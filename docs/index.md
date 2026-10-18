---
layout: home

hero:
  name: syncom
  text: Distributed data sync engine
  tagline: Local-first storage with a tamper-evident log, CRDT deltas and JavaScript smart contracts — zero runtime dependencies, one API for Node.js and the browser.
  image:
    src: /logo-mark.svg
    alt: syncom
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: API reference
      link: /reference/api
    - theme: alt
      text: GitHub
      link: https://github.com/Alexis-Technologies/syncom

features:
  - icon: 🔗
    title: Tamper-evident by construction
    details: Every write appends a hash-linked block. Reading a record re-derives its hash and checks it against the block that committed it, so silent corruption surfaces as an error instead of bad data.
    link: /guide/chain
    linkText: Blockchain log
  - icon: 🔄
    title: Replication without a coordinator
    details: Every write is an operation — last-writer-wins registers, per-origin counters, tombstones — logged locally and exchanged with peers over an injected transport. Any order, any number of times, same result.
    link: /guide/sync
    linkText: Sync
  - icon: 🔌
    title: wrpc as the transport
    details: Mount storage.sync.unit() on a wrpc server and dial it with a WrpcClient. Reconnects, resumable subscriptions and binary snapshot streams come from wrpc; syncom depends on nothing.
    link: /guide/wrpc
    linkText: wrpc transport
  - icon: 🧩
    title: CRDT deltas
    details: diff, merge and apply operate on plain objects — nested maps merge recursively, arrays behave as grow-only sets, and numbers merge by addition, so counters converge without coordination.
    link: /guide/crdt
    linkText: CRDT deltas
  - icon: 📇
    title: Records and collections
    details: A schema turns entity names into collections. Records expose live properties that track their own delta, emit update events, and persist with a single save().
    link: /guide/storage
    linkText: Storage
  - icon: 📜
    title: JavaScript smart contracts
    details: Store a procedure in the chain by hash, load it back anywhere, and run it against a read-only view of storage. Failures are recorded as blocks.
    link: /guide/contracts
    linkText: Smart contracts
  - icon: 🌐
    title: Node.js and the browser
    details: The same API over node:fs and node:crypto on the server, over OPFS and Web Crypto in the browser — selected by the browser export condition, not by a runtime check.
    link: /guide/browser
    linkText: Browser
  - icon: 📦
    title: Zero runtime dependencies
    details: Nothing is installed alongside it. The browser bundle is under 22 KB min+gzip, and CI fails the build if that budget is exceeded.
---
