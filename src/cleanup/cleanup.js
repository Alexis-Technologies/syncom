'use strict';

// Tombstone cleanup (@alexify/syncom/cleanup): a deleted record keeps a
// tombstone — its file with the stamps that keep it dead, so a late op from
// a peer stamped below them stays moot and a snapshot hands the deletion
// on. `cleanup(db, options)` folds the FILE of an old tombstone into its
// catalog row (`EntryStore.fold`): the stamps ride on the row, a read of
// the id rebuilds the tombstone from them, and the file and its pieces are
// gone. Only a tombstone deleted `minimumDeletedTime` ago or more (31 days),
// and — with `awaitSync` — only one whose delete this node made that every
// enabled registered node has acknowledged (`node.acked` against the op's
// seq), or that a peer made; a tombstone this node has not delivered yet
// is left as it is. `run({ drop: true })` takes the row too — a late op
// then makes a new record, and a peer that never saw the deletion keeps
// its copy: documented, not the default. `runEach` runs it on a timer.
// `leader` is kept for a database shared by several instances. Requires
// symbols.js and vector.js only.

const { SOURCE } = require('../symbols.js');
const { opKey } = require('../vector.js');

const DAY = 24 * 60 * 60 * 1000;
const MINIMUM_DELETED_TIME = 31 * DAY;
const RUN_EACH = 5 * 60 * 1000;

const isDatabase = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.snapshot === 'function' &&
  typeof value.transact === 'function';

// The delete op of `id` this node made, among the retained entries: the newest, or null (a peer's, or dropped).
const ownDelete = (entries, nodeId) => {
  let found = null;
  for (let i = 0; i < entries.length; i++) {
    const { op } = entries[i];
    if (op.type === 'delete' && op.origin === nodeId) found = op;
  }
  return found;
};

/**
 * `cleanup(db, { minimumDeletedTime, runEach, awaitSync, leader })` →
 * `{ run({ drop }?), start(), stop(), stats }`: `run()` folds every
 * tombstone old enough (and, with `awaitSync`, acknowledged by every
 * enabled registered node where this node made the delete), resolving to
 * `{ folded, dropped, skipped }`; `start()` runs it every `runEach` ms.
 */
const cleanup = (
  db,
  {
    minimumDeletedTime = MINIMUM_DELETED_TIME,
    runEach = RUN_EACH,
    awaitSync = true,
    leader = true,
    now = Date.now,
  } = {},
) => {
  if (!isDatabase(db)) throw new TypeError('cleanup() takes a database');
  if (!Number.isFinite(minimumDeletedTime) || minimumDeletedTime < 0) {
    throw new TypeError('cleanup(): minimumDeletedTime must be a non-negative number of milliseconds');
  }
  if (!Number.isFinite(runEach) || runEach <= 0) {
    throw new TypeError('cleanup(): runEach must be a positive number of milliseconds');
  }
  const seam = db[SOURCE];
  const stats = { runs: 0, folded: 0, dropped: 0, skipped: 0 };
  let timer = null;
  let running = null;

  // Whether every enabled registered node holds this node's delete op of the record.
  const acknowledged = (id) => {
    const op = ownDelete(seam.entriesOf(id), db.nodeId);
    if (op === null) return true;
    const key = opKey(op);
    const nodes = seam.nodes();
    for (let i = 0; i < nodes.length; i++) {
      if (!nodes[i].enabled) continue;
      if (!((nodes[i].acked?.[key] ?? 0) >= op.seq)) return false;
    }
    return true;
  };

  const sweep = async ({ drop = false } = {}) => {
    const counts = { folded: 0, dropped: 0, skipped: 0 };
    const ids = seam.all().slice();
    const horizon = now() - minimumDeletedTime;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const row = seam.row(id);
      if (row === null || !row.gone) continue;
      if (row.folded !== undefined) {
        if (!drop) continue;
        await seam.forget(id);
        counts.dropped++;
        continue;
      }
      const entry = await seam.entry(id);
      if (entry === null || entry.encrypted || entry.meta.deleted === null || entry.meta.purged) continue;
      if (entry.meta.deleted[0] > horizon || (awaitSync && !acknowledged(id))) {
        counts.skipped++;
        continue;
      }
      if (!(await seam.fold(id))) continue;
      counts.folded++;
      if (drop) {
        await seam.forget(id);
        counts.dropped++;
      }
    }
    stats.runs++;
    stats.folded += counts.folded;
    stats.dropped += counts.dropped;
    stats.skipped += counts.skipped;
    return counts;
  };

  const handle = {
    leader,
    stats,
    /** One sweep; `drop: true` takes the folded rows away too. Resolves to `{ folded, dropped, skipped }`. */
    run(options = {}) {
      if (running === null) running = sweep(options).finally(() => void (running = null));
      return running;
    },
    /** Runs a sweep every `runEach` ms until `stop()`; a failed sweep is logged. */
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        handle.run().catch((error) => db.logger.warn({ event: 'cleanup.failed', err: error }));
      }, runEach);
      timer.unref?.();
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
  return handle;
};

module.exports = { cleanup, MINIMUM_DELETED_TIME };
