'use strict';

// `dropDatabase(path, { engine | fsi })`: a CLOSED database taken away — every store of it removed from the engine
// under its lock (or the engine's lease), so nothing opens the directory meanwhile; a directory that holds no
// `node.json` but holds anything else is not ours to empty (a TypeError), one that holds nothing is nothing to do.
// `Database#drop()` closes and comes here. Requires engine.js, files/files.js, backend.js, fsi.js, lock.js only.

const { checkEngine, checkEngineDb, kvNamespace } = require('./engine.js');
const { filesEngine } = require('./files/files.js');
const { checkFsi } = require('./backend.js');
const defaultFsi = require('./fsi.js');
const { acquireLock } = require('./lock.js');

const NOOP = () => {};

/**
 * Drops a closed database: every store of it removed from the engine — the
 * one given, or the files engine over `fsi` (the platform's by default).
 * Held while it is taken: another instance's open database is `LOCKED`,
 * never emptied under it. A path that holds nothing is nothing to do; one
 * that holds no database (no identity) is refused.
 */
const dropDatabase = async (path, options = {}) => {
  if (typeof path !== 'string' || path.length === 0) throw new TypeError('dropDatabase() takes a path');
  if (options.engine !== undefined && options.fsi !== undefined) {
    throw new TypeError('dropDatabase({ engine, fsi }): an engine or a backend, not both');
  }
  const engine =
    options.engine !== undefined
      ? checkEngine(options.engine, 'dropDatabase({ engine })')
      : filesEngine(checkFsi(options.fsi === undefined ? defaultFsi : options.fsi, 'dropDatabase({ fsi })'));
  const db = checkEngineDb(await engine.open(path, {}), 'dropDatabase()');
  let lock = null;
  try {
    // A database's directory holds its identity (node.json): a directory without one that holds anything else is
    // not ours to empty, and a path that holds nothing is nothing to do.
    if (!(await db.kv.has('', 'node.json'))) {
      const stray = (await db.kv.list('')).length > 0 || (await db.records.ids({ limit: 1 })).length > 0;
      if (stray) throw new TypeError(`dropDatabase(): no database at ${path}`);
      return;
    }
    const native = db.capabilities.lock === 'native' && typeof db.lock === 'function';
    lock = native
      ? await db.lock({ mode: 'fail', onLost: NOOP })
      : await acquireLock({ store: kvNamespace(db.kv, ''), path, mode: 'fail' });
    await engine.remove(path);
  } finally {
    // The lock went with the rest: its release finds nothing to let go of.
    if (lock !== null) await lock.release().catch(NOOP);
    await db.close();
  }
};

module.exports = { dropDatabase };
