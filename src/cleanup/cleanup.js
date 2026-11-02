'use strict';

// Tombstone cleanup (@alexify/syncom/cleanup): a deleted record keeps a
// tombstone — its file with the stamps that keep it dead, so a late op from
// a peer stamped below them stays moot and a snapshot hands the deletion
// on. `cleanup(db, options)` folds an old tombstone whole — its collection,
// its data, its meta — into the `tombstones` kv namespace (`EntryStore.foldMany`,
// ONE write set with the file's removal): a read finds it there, the catalog
// row stays, the file and its pieces are gone. Only a tombstone deleted
// `minimumDeletedTime` ago or more (31 days; the stamp is on the catalog
// row, so nothing is read to decide), and — with `awaitSync` — only one
// whose delete this node made that every enabled registered node has
// acknowledged (`node.acked` against the op's seq), or that a peer made; a
// tombstone this node has not delivered yet is left as it is. A delete of
// this node's own that the log no longer retains folds (nothing is lost) but
// is never dropped under `awaitSync`: a node that only hosts cannot prove it
// was delivered. `run({ drop: true })` takes the kv entry and the row too —
// a late op then makes a new record, and a peer that never saw the deletion
// keeps its copy: documented, not the default. Folds and drops go `BATCH`
// ids a turn of the queue. `runEach` runs a sweep on a timer, stopped with
// the database. `leader` is kept for a database shared by several instances.
// Requires symbols.js and vector.js only.

const { SOURCE } = require('../symbols.js');
const { opKey } = require('../vector.js');

const DAY = 24 * 60 * 60 * 1000;
const MINIMUM_DELETED_TIME = 31 * DAY;
const RUN_EACH = 5 * 60 * 1000;
// How many tombstones one write set folds or drops.
const BATCH = 100;

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

  // Whether every enabled registered node holds this node's delete op of the
  // record. The op no longer retained: a peer's delete is theirs to deliver;
  // this node's own folds (nothing is lost) and, under `awaitSync`, is never
  // dropped — a node that only hosts cannot prove its compacted delete
  // reached anyone, and a drop is the one irreversible outcome.
  const acknowledged = (id, row, forDrop) => {
    const op = ownDelete(seam.entriesOf(id), db.nodeId);
    if (op === null) return row.deleted[1] !== db.nodeId || !forDrop;
    const key = opKey(op);
    const nodes = seam.nodes();
    for (let i = 0; i < nodes.length; i++) {
      if (!nodes[i].enabled) continue;
      if (!((nodes[i].acked?.[key] ?? 0) >= op.seq)) return false;
    }
    return true;
  };

  // One sweep over the catalog's rows: nothing of a record is read here —
  // the stamp and the collection are on the row — and the folds and drops go
  // `BATCH` at a time, one write set and one turn of the queue each.
  const sweep = async ({ drop = false } = {}) => {
    const counts = { folded: 0, dropped: 0, skipped: 0 };
    const horizon = now() - minimumDeletedTime;
    const ids = seam.all().slice();
    let folding = [];
    let dropping = [];
    const flush = async () => {
      if (folding.length > 0) {
        const done = await seam.foldMany(folding);
        counts.folded += done.length;
        if (drop) for (let i = 0; i < done.length; i++) dropping.push(done[i]);
        folding = [];
      }
      if (dropping.length > 0) {
        counts.dropped += await seam.forgetMany(dropping);
        dropping = [];
      }
    };
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const row = seam.row(id);
      if (row === null || !row.gone) continue;
      if (seam.folded(id)) {
        if (!drop) continue;
        if (!awaitSync || acknowledged(id, row, true)) dropping.push(id);
        else counts.skipped++;
      } else if (
        row.deleted === undefined ||
        row.deleted[0] > horizon ||
        (awaitSync && !acknowledged(id, row, false))
      ) {
        counts.skipped++;
      } else folding.push(id);
      if (folding.length + dropping.length >= BATCH) await flush();
    }
    await flush();
    stats.runs++;
    stats.folded += counts.folded;
    stats.dropped += counts.dropped;
    stats.skipped += counts.skipped;
    return counts;
  };

  const handle = {
    leader,
    stats,
    /** One sweep; `drop: true` takes the folded tombstones away too. Resolves to `{ folded, dropped, skipped }`. */
    run(options = {}) {
      if (running === null) running = sweep(options).finally(() => void (running = null));
      return running;
    },
    /** Runs a sweep every `runEach` ms until `stop()` or the database closes; a failed sweep is logged. */
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        handle.run().catch((error) => db.logger.warn({ event: 'cleanup.failed', err: error }));
      }, runEach);
      timer.unref?.();
      db.on('close', handle.stop);
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
      db.off('close', handle.stop);
    },
  };
  return handle;
};

module.exports = { cleanup, MINIMUM_DELETED_TIME };
