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
// source is handed over once (`rebuilt`) — a replay or a rebuild PAGE ids
// per batch, one transaction each, the checkpoint written after the last
// page. A handler that throws stops the pipeline BEFORE the turn: the
// checkpoint stays, the database's `error` event carries ALX_ERR_PIPELINE_FAILED,
// and `start()` hands the turn over again — a turn is never skipped. A turn
// that comes while another is handled joins the one waiting (the ids each
// once, the changes in order, the newer position), up to PAGE ids: the
// queue holds one live batch, however slow the handler. A handler's write
// to the source is another turn and is handed over again: derive into
// another collection. Reads of the target are never held up. `leader` —
// what `openShared()` answers, duck-typed (`db`, `isLeader()`, `live()`) —
// runs it on the leading instance alone: followed from the checkpoint in the
// shared engine's kv on the instance a failover makes the leader, let go on
// the one that loses the lead. Requires symbols.js, engine.js, errors.js and
// hooks.js only.

const { SOURCE, DB } = require('../symbols.js');
const { kvNamespace } = require('../engine.js');
const { SyncomError, ArgumentError } = require('../errors.js');
const { notify } = require('../hooks.js');

const NAMESPACE = 'pipeline';
// How many of the handler's errors are kept (the newest).
const MAX_ERRORS = 20;
// How many records a replay or a rebuild hands over per batch, and past how many ids a waiting batch takes no more turns.
const PAGE = 500;

const isDatabase = (value) =>
  value !== null && typeof value === 'object' && typeof value.transact === 'function' && typeof value.on === 'function';

// What `openShared()` answers, as far as a pipeline reads it.
const isLeader = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.live === 'function' &&
  typeof value.isLeader === 'function';

// What the pipeline reads of one database; `gone` once a change of instance let go of it (a failure of its batch in
// flight is then nobody's to tell: the next leader hands the turn over).
const bind = (db) => {
  const seam = db[SOURCE];
  return { db, seam, store: kvNamespace(db[DB].kv, NAMESPACE), otel: seam.otel, logger: db.logger, listener: null };
};

/**
 * A pipeline over `db`: `{ name, source, start(), stop(), idle(), awaitIdle(),
 * checkpoint, rebuilt, stopped, errors }`. `handler(batch, tx)` gets `{ ids, changes,
 * replay, rebuilt, eventId }` — the records of the source collection the
 * turn changed, their changes (null on a replay), and `tx`, the
 * transaction the handler writes through. With `leader` (what `openShared()`
 * answers, `db` its instance) it runs where this instance leads.
 */
const createPipeline = (db, { name, source, handler, leader = null } = {}) => {
  if (!isDatabase(db)) throw new ArgumentError('createPipeline() takes a database');
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,100}$/.test(name)) {
    throw new ArgumentError('createPipeline() takes a name: letters, digits, _ . -');
  }
  if (typeof source !== 'string' || source.length === 0) {
    throw new ArgumentError('createPipeline() takes a source collection');
  }
  if (typeof handler !== 'function') throw new ArgumentError('createPipeline() takes a handler');
  if (leader !== null && !isLeader(leader)) {
    throw new ArgumentError('createPipeline(): leader is what openShared() answers (live, isLeader)');
  }
  if (leader !== null && leader.db !== db) throw new ArgumentError('createPipeline(): db is leader.db, its instance');
  // Without `leader` the database given, bound once; with it the leading instance, bound at every change of it.
  const own = leader === null ? bind(db) : null;
  const queue = [];
  let running = null;
  let stopped = true;
  let checkpoint = null;
  let rebuilt = false;
  // The binding followed now, or null; the handle's live subscription.
  let bound = null;
  let off = null;
  const waiters = [];
  const errors = [];

  const settle = () => {
    while (waiters.length > 0) waiters.pop()();
  };

  // One batch handled: the handler inside a transaction, the checkpoint after it landed — not after a page of a
  // replay or a rebuild before the last: a position reached only once every page is.
  const handle = async ({ batch, final, binding }) => {
    await binding.db.transact((tx) => handler(batch, tx));
    if (binding.otel.enabled) binding.otel.recordPipeline('handled', batch.ts ?? null);
    if (!final) return;
    checkpoint = batch.eventId;
    await binding.store.put(name, JSON.stringify({ eventId: checkpoint }), { atomic: true });
  };

  // Following one database stopped: its listener off, its batches queued left for the next start (the checkpoint
  // stands).
  const unfollow = (binding) => {
    if (binding.listener !== null) binding.db.off('transaction', binding.listener);
    binding.listener = null;
    if (bound === binding) bound = null;
    let kept = 0;
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].binding !== binding) queue[kept++] = queue[i];
    }
    queue.length = kept;
  };

  // Following stopped until `start()`.
  const halt = () => {
    stopped = true;
    if (bound !== null) unfollow(bound);
    queue.length = 0;
    const live = off;
    off = null;
    live?.();
  };

  // A failed turn stops the pipeline BEFORE it: the checkpoint stays, and `start()` hands the turn over again —
  // never skipped, never moved past.
  const fail = (binding, cause, eventId) => {
    if (errors.length >= MAX_ERRORS) errors.shift();
    errors.push(cause);
    if (binding.otel.enabled) binding.otel.recordPipeline('failed', null);
    halt();
    binding.logger.warn({ event: 'pipeline.failed', name, eventId, err: cause });
    const message = `Pipeline ${name} failed at ${eventId} and stopped before the turn`;
    notify(
      binding.db,
      binding.logger,
      'error',
      new SyncomError('ALX_ERR_PIPELINE_FAILED', message, { pipeline: name, eventId, cause }),
    );
  };

  const drain = async () => {
    for (;;) {
      // `stopped` moves under `stop()` and a failure, between two batches.
      if (queue.length === 0 || stopped) break;
      const item = queue.shift();
      try {
        await handle(item);
      } catch (cause) {
        if (item.binding.gone) continue;
        fail(item.binding, cause, item.batch.eventId);
        break;
      }
    }
    running = null;
    settle();
  };

  // A batch queued; a live turn joins the live batch waiting ahead of it while that one holds under a page of ids.
  const push = (binding, batch, final = true) => {
    const tail = queue.length > 0 ? queue[queue.length - 1] : null;
    const last = tail !== null && tail.binding === binding ? tail.batch : null;
    if (last !== null && !batch.replay && !last.replay && last.ids.length < PAGE) {
      const seen = new Set(last.ids);
      for (let i = 0; i < batch.ids.length; i++) {
        if (seen.has(batch.ids[i])) continue;
        seen.add(batch.ids[i]);
        last.ids.push(batch.ids[i]);
      }
      for (let i = 0; i < batch.changes.length; i++) last.changes.push(batch.changes[i]);
      last.eventId = batch.eventId;
      last.ts = batch.ts;
      return;
    }
    queue.push({ batch, final, binding });
    if (running === null) running = drain();
  };

  // The ids of a replay or a rebuild, PAGE per batch, the checkpoint after the last.
  const paged = (binding, ids, isRebuild, eventId) => {
    for (let at = 0; at < ids.length; at += PAGE) {
      const page = ids.slice(at, at + PAGE);
      const batch = { ids: page, changes: null, replay: true, rebuilt: isRebuild, eventId };
      push(binding, batch, at + PAGE >= ids.length);
    }
  };

  // Of a turn, the records of the source that changed, each once.
  const ofSource = ({ seam }, changes) => {
    const ids = [];
    const seen = new Set();
    const sourceChanges = [];
    for (let i = 0; i < changes.length; i++) {
      const { id } = changes[i];
      // The collection: the row's — a tombstone's row keeps it — or, of a purge (its row is gone), the change's.
      const type = seam.row(id)?.type ?? changes[i].type ?? null;
      if (type !== source) continue;
      sourceChanges.push(changes[i]);
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return { ids, changes: sourceChanges };
  };

  // The turns since the checkpoint, from the log: the ids of the source's records they touched. Where the log cannot
  // resume from the checkpoint: every record of the source, once, a page at a time.
  const replay = (binding) => {
    const { log } = binding.db;
    const entries = checkpoint === null ? null : log.since(checkpoint);
    if (entries === null) {
      rebuilt = true;
      const ids = binding.seam.ids(source);
      binding.logger.info({ event: 'pipeline.rebuild', name, records: ids.length });
      return paged(binding, ids, true, log.lastEventId);
    }
    const ids = [];
    const seen = new Set();
    let last = checkpoint;
    for (let i = 0; i < entries.length; i++) {
      const { op, seq } = entries[i];
      last = log.formatId(seq);
      if (typeof op.id !== 'string' || seen.has(op.id) || binding.seam.row(op.id)?.type !== source) continue;
      seen.add(op.id);
      ids.push(op.id);
    }
    if (ids.length > 0) paged(binding, ids, false, last);
    else if (last !== checkpoint) checkpoint = last;
  };

  // Following one database: the checkpoint read, the turns since it replayed (or a rebuild), the live turns heard.
  const follow = async (binding) => {
    bound = binding;
    rebuilt = false;
    const text = await binding.store.get(name);
    // Stopped, failed or let go of meanwhile: nothing to follow.
    if (bound !== binding) return;
    if (text !== null) {
      try {
        checkpoint = JSON.parse(text).eventId ?? null;
      } catch (cause) {
        // Evidence, not a position: said so, and every record handed over again.
        checkpoint = null;
        binding.logger.warn({ event: 'pipeline.checkpoint.unreadable', name, err: cause });
      }
    }
    binding.listener = (event) => {
      const batch = ofSource(binding, event.changes);
      if (batch.ids.length === 0) return;
      push(binding, { ...batch, replay: false, rebuilt: false, eventId: event.eventId, ts: event.ts ?? null });
    };
    binding.db.on('transaction', binding.listener);
    replay(binding);
  };

  const pipeline = {
    name,
    source,
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
    /**
     * Reads the checkpoint, replays the turns since it (or rebuilds), then follows the turns. With `leader`, on the
     * instance that leads — now, and at every change of instance — and nowhere else.
     */
    async start() {
      if (!stopped) return;
      if (own !== null) {
        stopped = false;
        return follow(own);
      }
      let first = null;
      // A handle that refuses (closed) throws here: nothing started, the pipeline stays stopped.
      off = leader.live((instance) => {
        if (!leader.isLeader()) return null;
        const binding = bind(instance);
        const following = follow(binding).catch((cause) => {
          if (!binding.gone) fail(binding, cause, checkpoint);
        });
        first ??= following;
        return () => {
          binding.gone = true;
          unfollow(binding);
        };
      });
      stopped = false;
      await first;
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
