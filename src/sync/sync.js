'use strict';

// The sync of ops as a plugin (@alexify/syncom/sync): `open({ plugins: [sync] })`
// gives the storage its `sync` — the SyncManager (./manager.js): the dialing
// side, which pushes what a peer lacks and subscribes to its feed, and
// `unit()`, the hosting side (./hosting.js) a wrpc server mounts. The
// transport is injected (`sync.connect`, a SyncLink — `@alexify/syncom/wrpc`
// wraps a WrpcClient into one). Without the plugin `storage.sync` is
// PLUGIN_MISSING, and the core still takes a peer's page through
// `applyRemote` and selects what a peer lacks with `outbound` — the updates
// API a transport of the application's own carries. The hook the core
// takes: `sync` — the manager, built once the log is open.

const { SyncManager } = require('./manager.js');
const { isSyncLink } = require('../link.js');

const sync = Object.freeze({
  name: 'sync',
  async open({ storage, options }) {
    const manager = await new SyncManager(storage, { ...(options.sync ?? {}), maxListeners: options.maxListeners });
    return { sync: manager };
  },
});

module.exports = { sync, SyncManager, isSyncLink };
