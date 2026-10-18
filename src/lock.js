'use strict';

// Exclusive open. Two storages over one directory would both read the log's
// vector and both mint the next `origin:seq` — the same number for two
// different ops, which a peer drops as a duplicate and nothing ever
// reconciles. So a directory is held by one instance at a time: through the
// Web Locks API where there is one (the browser releases it when the tab
// dies), through `<path>/lock.json` otherwise. No requires: shared code.

const LOCK_FILE = 'lock.json';
const DEFAULT_STALE = 30 * 60 * 1000;

const locked = (path) =>
  Object.assign(new Error(`Storage at ${path} is locked by another instance`), { code: 'LOCKED' });

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

const readLock = async (fsi, path) => {
  if (!(await fsi.exists(path, LOCK_FILE))) return null;
  try {
    const lock = JSON.parse(await fsi.read(path, LOCK_FILE));
    return typeof lock === 'object' && lock !== null ? lock : null;
  } catch {
    return null;
  }
};

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
 * (poll until it is free or stale).
 */
const acquireLock = async ({ fsi, path, mode, staleAfter = DEFAULT_STALE, poll = 100 }) => {
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
  for (;;) {
    const current = await readLock(fsi, path);
    if (current === null || stale(current, staleAfter)) {
      await fsi.write(path, LOCK_FILE, JSON.stringify({ pid, id, since: Date.now() }));
      // Two openers racing for a stale lock: the one whose write landed last
      // owns it, the other tries again.
      const written = await readLock(fsi, path);
      if (written?.id === id) {
        return {
          release: async () => {
            const now = await readLock(fsi, path);
            if (now?.id === id) await fsi.remove(path, LOCK_FILE);
          },
        };
      }
    } else if (mode === 'fail') {
      throw locked(path);
    }
    await sleep(poll);
  }
};

module.exports = { acquireLock, LOCK_FILE };
