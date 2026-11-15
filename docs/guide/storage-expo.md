---
title: Expo
description: Reach Expo through the SQLite engine with a small expo-sqlite driver, and what an Expo or React Native app should know before it relies on it.
---

# Expo

syncom has no storage over Expo's file system. An Expo app reaches storage through the
[SQLite engine](./storage-sqlite) instead: the engine takes any driver with `exec` and `prepare`, and a dozen
lines put expo-sqlite behind those calls. React Native is not a target syncom builds or tests for, so treat this
page as a starting point you verify in your app, not a supported setup.

<div class="sc-steps">

### Write the driver

The driver opens a database with expo-sqlite's async API and answers the calls the engine makes. expo-sqlite
answers `null` for "no row", which the engine accepts.

<<< @/examples/storage-expo.mjs#driver

### Open a database through it

<<< @/examples/storage-expo.mjs#open

</div>

The example runs in this repository's tests against a stand-in with the same six calls over `node:sqlite`, so
what it proves is the driver and the engine, not Expo itself.

## Before you rely on it

- **The core, not `/all`.** The example opens the core alone. `@alexify/syncom/all` adds the signing and sealing
  plugins, which need Web Crypto's Ed25519 and RSA in the runtime.
- **Ids and hashes.** The browser build mints ids with `crypto.randomUUID()` and hashes large values with
  `crypto.subtle.digest()`. Where the runtime lacks them, pass `getId` to `createDatabase()` (it mints record
  ids and the node id) and provide Web Crypto's digest.
- **A bundler that resolves every `require`.** The SQLite subpath is written for Node: it loads `node:sqlite`
  when no driver is given, and `node:fs/promises` in `destroy()` and in its size report. A bundler that resolves
  every `require` ahead of time must be told to leave those out.
- **No sync tests on devices.** Replication over [WebSocket](./replication-websocket) is the same code as in a
  browser, but nobody has run it on a phone.

## Coming from RxDB

RxDB has a Premium storage over Expo's file system and reaches expo-sqlite through its SQLite storage. syncom
has only the second route, through a driver you write, and no tested React Native support.

<FromRxdb page="rx-storage-filesystem-expo" :rows="['expo', 'expoFs', 'reactNative']" />
