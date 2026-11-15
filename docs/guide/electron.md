---
title: Electron
description: Keep the storage of an Electron app in the main process and open the database in a window over MessageChannelMain, with the remote engine.
---

# Electron

An Electron app has a main process, which is Node.js with the file system and native modules, and windows, which
are web pages that should not get either. The common shape for a local database is to keep the storage in the main
process and open the database in the window. syncom does this with its [remote engine](./storage-remote): the main
process serves an engine over a `MessageChannelMain`, and the window opens the database through the port, as it
would open one over any other engine.

syncom has no Electron-specific helper. The wiring below is the remote engine plus a few lines that adapt Electron's
port, written against Electron's documented API; Electron does not run in this repository's tests, so the same
wiring is proven in Node.js with worker threads at the end of the page.

<div class="sc-steps">

### Serve the engine from the main process

The main process opens the engine, makes a channel, serves the engine on one end and posts the other end to the
window:

<<< @/examples/electron.mjs#main

`MessagePortMain` is a Node.js event emitter whose `message` listeners receive an event object, so `asPort()`
shapes it like a web `MessagePort`, which `serveEngine()` reads. `allow` limits the window to the database paths you
list: a page that loads remote content should never be able to open or delete another database of the app.

### Hand the port to the page

With context isolation on, the preload script receives the port and passes it on to the page:

<<< @/examples/electron.mjs#preload

### Open the database in the window

The page waits for the port, connects to the engine and opens the database:

<<< @/examples/electron.mjs#renderer

The database, with its log, its queries and its sync, runs in the window, and every read and write of storage
crosses to the main process. The window needs no Node.js integration: it imports the package's browser build
through your bundler like any web page.

### Check the wiring without Electron

A Node.js worker thread stands in for the window and a `MessageChannel` for `MessageChannelMain`:

<<< @/examples/electron-threads.mjs#main

<<< @/examples/electron-threads.mjs#renderer

Node.js ports already speak the shape `serveEngine()` reads, so no adapter is needed here.

</div>

## Several windows

A database opened through the main process belongs to one window at a time: a second window that opens the same
path gets `LOCKED`, as a second process would. Give each window its own port and its own `allow` list, and its own
path when the windows hold different data.

When several windows should show the same data, treat them as tabs. Windows that load the same origin in one session
share its IndexedDB as browser tabs do, so they can open one database through [`@alexify/syncom/shared`](./storage-shared-worker), one window
leading and the others following, with [Leader election](./leader-election) deciding which.

## Limitations

- **The database runs in the window.** Only storage moves to the main process. Close the database before the
  window closes, or its last writes wait for the next open to be replayed from the log.
- **One opener per path.** See above; the main process does not share one open database among windows.
- **Your Electron version decides the SQLite driver.** `sqliteEngine()` uses `node:sqlite` by default, which needs a
  Node.js that has it; pass `driver` to use another SQLite library ([SQLite](./storage-sqlite)).
- **An ESM preload needs `sandbox: false`.** Write the preload as CommonJS if your windows are sandboxed.

## Coming from RxDB

RxDB's Electron plugin also keeps the storage in the main process and the database in the renderer, over IPC
helpers, and asks for `nodeIntegration` in the window. syncom uses a `MessageChannelMain` port and the same remote
engine as a worker, and the window runs the browser build without Node.js integration.

<FromRxdb page="electron" :rows="['electron', 'remoteStorage']" />
