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
// the database. `leader` — what `openShared()` answers, duck-typed (`db`,
// `isLeader()`, `live()`) — sweeps the leading instance alone: `run()`
// sweeps nothing where this instance follows, and the timer runs while it
// leads, armed again on the instance a failover makes the leader. Requires
// symbols.js, vector.js and telemetry/writer.js only.

const { SOURCE } = require('../symbols.js');
const { opKey } = require('../vector.js');
const { traced } = require('../telemetry/writer.js');
const { ArgumentError } = require('../argument-errors.js');

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

// What `openShared()` answers, as far as a cleanup reads it.
const isLeader = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.live === 'function' &&
  typeof value.isLeader === 'function';

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
 * `{ folded, dropped, skipped }`; `start()` runs it every `runEach` ms. With
 * `leader` (what `openShared()` answers, `db` its instance), on the leading
 * instance alone.
 */
const cleanup = (
  db,
  {
    minimumDeletedTime = MINIMUM_DELETED_TIME,
    runEach = RUN_EACH,
    awaitSync = true,
    leader = null,
    now = Date.now,
  } = {},
) => {
  if (!isDatabase(db)) throw new ArgumentError('cleanup() takes a database');
  if (!Number.isFinite(minimumDeletedTime) || minimumDeletedTime < 0) {
    throw new ArgumentError('cleanup(): minimumDeletedTime must be a non-negative number of milliseconds');
  }
  if (!Number.isFinite(runEach) || runEach <= 0) {
    throw new ArgumentError('cleanup(): runEach must be a positive number of milliseconds');
  }
  if (leader !== null && !isLeader(leader)) {
    throw new ArgumentError('cleanup(): leader is what openShared() answers (live, isLeader)');
  }
  if (leader !== null && leader.db !== db) throw new ArgumentError('cleanup(): db is leader.db, its instance');
  const stats = { runs: 0, folded: 0, dropped: 0, skipped: 0 };
  // What stops the timer: its own, or — with `leader` — the handle's live subscription.
  let stopping = null;
  let running = null;

  // Whether every enabled registered node holds this node's delete op of the
  // record. The op no longer retained: a peer's delete is theirs to deliver;
  // this node's own folds (nothing is lost) and, under `awaitSync`, is never
  // dropped — a node that only hosts cannot prove its compacted delete
  // reached anyone, and a drop is the one irreversible outcome.
  const acknowledged = (target, id, row, forDrop) => {
    const seam = target[SOURCE];
    const op = ownDelete(seam.entriesOf(id), target.nodeId);
    if (op === null) return row.deleted[1] !== target.nodeId || !forDrop;
    const key = opKey(op);
    const nodes = seam.nodes();
    for (let i = 0; i < nodes.length; i++) {
      if (!nodes[i].enabled) continue;
      if (!((nodes[i].acked?.[key] ?? 0) >= op.seq)) return false;
    }
    return true;
  };

  // One sweep over the catalog's rows of `target`: nothing of a record is
  // read here — the stamp and the collection are on the row — and the folds
  // and drops go `BATCH` at a time, one write set and one turn of the queue each.
  const sweep = async (target, { drop = false } = {}) => {
    const seam = target[SOURCE];
    const counts = { folded: 0, dropped: 0, skipped: 0 };
    const horizon = now() - minimumDeletedTime;
    const ids = seam.all().slice();
    let folding = [];
    let dropping = [];
    const flush = async () => {
      if (folding.length > 0) {
        const done = await seam.foldMany(folding);
        counts.folded += done.length;
        if (drop) {
          for (let i = 0; i < done.length; i++) dropping.push(done[i]);
        }
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
        if (!awaitSync || acknowledged(target, id, row, true)) dropping.push(id);
        else counts.skipped++;
      } else if (
        row.deleted === undefined ||
        row.deleted[0] > horizon ||
        (awaitSync && !acknowledged(target, id, row, false))
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

  // A sweep as a span (`syncom.cleanup.sweep`) with its counts, the tombstones it took counted, and a debug line.
  const swept = async (target, options) => {
    const { otel } = target[SOURCE];
    const started = Date.now();
    const run = async () => {
      const counts = await sweep(target, options);
      if (otel.enabled) {
        otel.recordCleanup('folded', counts.folded);
        otel.recordCleanup('dropped', counts.dropped);
      }
      target.logger.debug({ event: 'cleanup.sweep', ...counts, ms: Date.now() - started });
      return counts;
    };
    if (!otel.enabled) return run();
    return traced(otel, 'syncom.cleanup.sweep', {}, run, (counts) => ({
      'syncom.cleanup.folded': counts.folded,
      'syncom.cleanup.dropped': counts.dropped,
      'syncom.cleanup.skipped': counts.skipped,
    }));
  };

  // The timer over one instance: a sweep every `runEach` ms, a failed one logged; answers what stops it.
  const arm = (instance) => {
    const timer = setInterval(() => {
      handle.run().catch((error) => instance.logger.warn({ event: 'cleanup.failed', err: error }));
    }, runEach);
    timer.unref?.();
    return () => clearInterval(timer);
  };

  const handle = {
    stats,
    /**
     * One sweep; `drop: true` takes the folded tombstones away too. Resolves to `{ folded, dropped, skipped }` — with
     * `leader`, all zero where this instance does not lead (nothing swept).
     */
    run(options = {}) {
      let target = db;
      if (leader !== null) target = leader.isLeader() ? leader.db : null;
      if (target === null) return Promise.resolve({ folded: 0, dropped: 0, skipped: 0 });
      if (running === null) running = swept(target, options).finally(() => void (running = null));
      return running;
    },
    /**
     * Runs a sweep every `runEach` ms until `stop()` or the database closes; a failed sweep is logged. With `leader`,
     * while this instance leads: the timer armed on the instance that leads, now and at every change of instance.
     */
    start() {
      if (stopping !== null) return;
      if (leader !== null) {
        stopping = leader.live((instance) => (leader.isLeader() ? arm(instance) : null));
        return;
      }
      stopping = arm(db);
      db.on('close', handle.stop);
    },
    stop() {
      if (stopping === null) return;
      stopping();
      stopping = null;
      db.off('close', handle.stop);
    },
  };
  return handle;
};

module.exports = { cleanup, MINIMUM_DELETED_TIME };
