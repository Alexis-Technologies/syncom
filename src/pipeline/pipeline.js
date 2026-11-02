'use strict';

// Pipelines (@alexify/syncom/pipeline): a handler run over every change of
// a collection, in order, at least once — a derived collection, a counter,
// an index kept in another place. `createPipeline(db, { name, source, handler })`
// follows the `transaction` events of the database: of each turn, the
// records of `source` that changed are handed to `handler(batch, tx)` inside
// ONE transaction (the derived writes land whole, or not at all), and the
// turn's log position is then kept as the checkpoint, in the kv namespace
// `pipeline` under `name`, so a reopen resumes where it left: the turns the
// log holds since the checkpoint are replayed first (their ids, no changes
// — a replay reads the records), and where the log cannot resume from it
// (compacted past, another epoch, no checkpoint), every record of the
// source is handed over once (`rebuilt`). A handler that throws stops the
// pipeline BEFORE the turn: the checkpoint stays, the database's `error`
// event carries PIPELINE_FAILED, and `start()` hands the turn over again —
// a turn is never skipped. A handler's write to the source is another turn
// and is handed over again: derive into another collection. Reads of the
// target are never held up. Requires symbols.js, engine.js, errors.js and
// hooks.js only.

const { SOURCE, DB } = require('../symbols.js');
const { kvNamespace } = require('../engine.js');
const { SyncomError } = require('../errors.js');
const { notify } = require('../hooks.js');

const NAMESPACE = 'pipeline';
// How many of the handler's errors are kept (the newest).
const MAX_ERRORS = 20;

const isDatabase = (value) =>
  value !== null && typeof value === 'object' && typeof value.transact === 'function' && typeof value.on === 'function';

/**
 * A pipeline over `db`: `{ name, source, start(), stop(), idle(), awaitIdle(),
 * checkpoint, rebuilt, stopped, errors }`. `handler(batch, tx)` gets `{ ids, changes,
 * replay, rebuilt, eventId }` — the records of the source collection the
 * turn changed, their changes (null on a replay), and `tx`, the
 * transaction the handler writes through. `leader` is kept for a database
 * shared by several instances (the leader runs it); here every instance does.
 */
const createPipeline = (db, { name, source, handler, leader = true } = {}) => {
  if (!isDatabase(db)) throw new TypeError('createPipeline() takes a database');
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,100}$/.test(name)) {
    throw new TypeError('createPipeline() takes a name: letters, digits, _ . -');
  }
  if (typeof source !== 'string' || source.length === 0) {
    throw new TypeError('createPipeline() takes a source collection');
  }
  if (typeof handler !== 'function') throw new TypeError('createPipeline() takes a handler');
  const store = kvNamespace(db[DB].kv, NAMESPACE);
  const seam = db[SOURCE];
  const { logger } = db;
  const queue = [];
  let running = null;
  let stopped = true;
  let checkpoint = null;
  let rebuilt = false;
  let listener = null;
  const waiters = [];
  const errors = [];

  const settle = () => {
    while (waiters.length > 0) waiters.pop()();
  };

  // One batch handled: the handler inside a transaction, the checkpoint after it landed.
  const handle = async (batch) => {
    await db.transact((tx) => handler(batch, tx));
    checkpoint = batch.eventId;
    await store.put(name, JSON.stringify({ eventId: checkpoint }), { atomic: true });
  };

  // Following stopped: the listener off, what is queued left for the next start (the checkpoint stands).
  const halt = () => {
    stopped = true;
    if (listener !== null) db.off('transaction', listener);
    listener = null;
    queue.length = 0;
  };

  const drain = async () => {
    for (;;) {
      // `stopped` moves under `stop()` and a failure, between two batches.
      if (queue.length === 0 || stopped) break;
      const batch = queue.shift();
      try {
        await handle(batch);
      } catch (cause) {
        // A failed turn stops the pipeline BEFORE it: the checkpoint stays, and `start()` hands the turn over
        // again — never skipped, never moved past.
        if (errors.length >= MAX_ERRORS) errors.shift();
        errors.push(cause);
        halt();
        logger.warn({ event: 'pipeline.failed', name, eventId: batch.eventId, err: cause });
        const message = `Pipeline ${name} failed at ${batch.eventId} and stopped before the turn`;
        notify(
          db,
          logger,
          'error',
          new SyncomError('PIPELINE_FAILED', message, { name, eventId: batch.eventId, cause }),
        );
        break;
      }
    }
    running = null;
    settle();
  };

  const push = (batch) => {
    queue.push(batch);
    if (running === null) running = drain();
  };

  // Of a turn, the records of the source that changed, each once.
  const ofSource = (changes) => {
    const ids = [];
    const seen = new Set();
    const own = [];
    for (let i = 0; i < changes.length; i++) {
      const { id } = changes[i];
      // The collection: the row's — a tombstone's row keeps it — or, of a purge (its row is gone), the change's.
      const type = seam.row(id)?.type ?? changes[i].type ?? null;
      if (type !== source) continue;
      own.push(changes[i]);
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return { ids, changes: own };
  };

  // Where the log cannot resume from the checkpoint: every record of the source, once.
  const rebuild = () => {
    rebuilt = true;
    const ids = seam.ids(source).slice();
    if (ids.length === 0) return;
    push({ ids, changes: null, replay: true, rebuilt: true, eventId: db.log.lastEventId });
  };

  // The turns since the checkpoint, from the log: the ids of the source's records they touched.
  const replay = () => {
    const entries = checkpoint === null ? null : db.log.since(checkpoint);
    if (entries === null) return rebuild();
    const ids = [];
    const seen = new Set();
    let last = checkpoint;
    for (let i = 0; i < entries.length; i++) {
      const { op, seq } = entries[i];
      last = db.log.formatId(seq);
      if (typeof op.id !== 'string' || seen.has(op.id) || seam.row(op.id)?.type !== source) continue;
      seen.add(op.id);
      ids.push(op.id);
    }
    if (ids.length > 0) push({ ids, changes: null, replay: true, rebuilt: false, eventId: last });
    else if (last !== checkpoint) checkpoint = last;
  };

  const pipeline = {
    name,
    source,
    leader,
    /** The checkpoint: the log position handled last, or null. */
    get checkpoint() {
      return checkpoint;
    },
    /** Whether the last start handed every record of the source over (no checkpoint to resume from). */
    get rebuilt() {
      return rebuilt;
    },
    /** Whether the pipeline follows nothing now: not started, `stop()`, or a handler that threw. */
    get stopped() {
      return stopped;
    },
    /** What the handler threw, in order — the newest twenty. */
    errors,
    /** Reads the checkpoint, replays the turns since it (or rebuilds), then follows the turns. */
    async start() {
      if (!stopped) return;
      stopped = false;
      const text = await store.get(name);
      if (text !== null) {
        try {
          checkpoint = JSON.parse(text).eventId ?? null;
        } catch {
          checkpoint = null;
        }
      }
      listener = (event) => {
        const batch = ofSource(event.changes);
        if (batch.ids.length === 0) return;
        push({ ...batch, replay: false, rebuilt: false, eventId: event.eventId });
      };
      db.on('transaction', listener);
      replay();
    },
    /** Stops following; what is queued is left for the next start (the checkpoint stands). */
    stop() {
      if (!stopped) halt();
    },
    /** Whether nothing is queued or running. */
    idle() {
      return queue.length === 0 && running === null;
    },
    /** Resolves once nothing is queued or running. */
    awaitIdle() {
      if (pipeline.idle()) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
  return pipeline;
};

module.exports = { createPipeline };
