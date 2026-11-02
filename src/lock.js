'use strict';

const { SyncomError } = require('./errors.js');
const { fsiNamespace } = require('./engine.js');
// Exclusive open. Two storages over one directory would both read the log's
// vector and both mint the next `origin:seq` — the same number for two
// different ops, which a peer drops as a duplicate and nothing ever
// reconciles. So a directory is held by one instance at a time: through the
// Web Locks API where there is one (the browser releases it when the tab
// dies), through the `lock.json` key of the database's root namespace
// otherwise. Requires errors.js and engine.js only: shared code.

const LOCK_FILE = 'lock.json';
const DEFAULT_STALE = 30 * 60 * 1000;

const locked = (path, why = 'is locked by another instance') =>
  new SyncomError('LOCKED', `Storage at ${path} ${why}`, { path });

const random = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

// Whether the process that wrote a lockfile is still running: true, false,
// or null when there is no way to tell (no pid, or no `process.kill`).
const alive = (pid) => {
  const kill = globalThis.process?.kill;
  if (!Number.isInteger(pid) || typeof kill !== 'function') return null;
  try {
    kill.call(globalThis.process, pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

// A lockfile is stale when its process is gone, or — when that cannot be
// told — when it is older than `staleAfter`.
const stale = (lock, staleAfter) => {
  const owner = alive(lock.pid);
  if (owner !== null) return !owner;
  return typeof lock.since !== 'number' || Date.now() - lock.since > staleAfter;
};

// The lockfile's text, or null when there is none.
const readRaw = (store) => store.get(LOCK_FILE);

const parseLock = (raw) => {
  if (raw === null) return null;
  try {
    const lock = JSON.parse(raw);
    return typeof lock === 'object' && lock !== null ? lock : null;
  } catch {
    return null;
  }
};

const readLock = async (store) => parseLock(await readRaw(store));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Web Locks: `request` holds the lock for as long as the callback's promise
// is pending; `ifAvailable` answers with `null` instead of waiting.
const webLock = (locks, name, mode) =>
  new Promise((resolve, reject) => {
    let release = null;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const options = mode === 'fail' ? { ifAvailable: true } : {};
    locks
      .request(name, options, (lock) => {
        if (lock === null) return void resolve(null);
        resolve({ release: async () => release() });
        return held;
      })
      .catch(reject);
  });

/**
 * Holds `path` for this instance: `{ release() }`. `mode` is `'fail'` (an
 * `Error` with `code: 'LOCKED'` when another instance holds it) or `'wait'`
 * (poll until it is free or stale — or `timeout` ms have passed, then
 * `LOCKED` too). A store with `create` (exclusive) makes two openers racing
 * for a free lock lose deterministically; without it the last write wins and
 * the other reads it back and tries again. `store` is the database's root
 * namespace (src/engine.js `kvNamespace`); an `fsi` with the `path` as its
 * directory is taken instead where one is given.
 */
const acquireLock = async ({ store, fsi, path, mode, staleAfter = DEFAULT_STALE, poll = 100, timeout = Infinity }) => {
  const lockStore = store ?? fsiNamespace(fsi, path);
  // Web Locks only where a lock outlives nothing but the tab: Node has a
  // `navigator.locks` too, scoped to one process, which is not what two
  // processes over one directory need.
  const inBrowser = typeof globalThis.self !== 'undefined' || typeof globalThis.window !== 'undefined';
  const locks = inBrowser ? globalThis.navigator?.locks : null;
  if (locks && typeof locks.request === 'function') {
    const lock = await webLock(locks, `syncom:${path}`, mode);
    if (lock === null) throw locked(path);
    return lock;
  }
  const id = random();
  const pid = globalThis.process?.pid ?? null;
  const exclusive = typeof lockStore.create === 'function';
  const deadline = Number.isFinite(timeout) ? Date.now() + timeout : Infinity;
  const holder = {
    release: async () => {
      const now = await readLock(lockStore);
      if (now?.id === id) await lockStore.remove(LOCK_FILE);
    },
  };
  for (;;) {
    const raw = await readRaw(lockStore);
    const current = parseLock(raw);
    if (current === null || stale(current, staleAfter)) {
      const body = JSON.stringify({ pid, id, since: Date.now() });
      if (exclusive) {
        // A stale or unreadable file is removed first — if it is still the
        // same file: another opener may have taken the lock meanwhile, and
        // theirs is not ours to remove. Then only one creator succeeds.
        if (raw !== null && (await readRaw(lockStore)) === raw) await lockStore.remove(LOCK_FILE);
        try {
          await lockStore.create(LOCK_FILE, body);
          return holder;
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
        }
      } else {
        await lockStore.put(LOCK_FILE, body);
        // Two openers racing for a free lock: the one whose write landed
        // last owns it, the other reads that back and tries again.
        const written = await readLock(lockStore);
        if (written?.id === id) return holder;
      }
    } else if (mode === 'fail') {
      throw locked(path);
    }
    if (Date.now() >= deadline) throw locked(path, `is still locked after ${timeout} ms`);
    await sleep(poll);
  }
};

module.exports = { acquireLock, LOCK_FILE };
