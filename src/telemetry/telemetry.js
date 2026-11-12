'use strict';

// OpenTelemetry with no dependency on OpenTelemetry (@alexify/syncom/telemetry).
//
// Nothing here imports anything: the caller injects either the
// `@opentelemetry/api` module or pre-built tracer/meter instances, and every
// one of them is duck-typed. The shape mirrors wrpc's `telemetry` option so a
// host can hand the same object to both packages — and the two then meet in
// one trace: wrpc opens the SERVER span for a `syncom/push` call, and the
// `syncom.apply` span opened inside the handler nests under it through the
// active context. syncom itself never carries trace context: ops are durable
// and traces are not, and wrpc already puts W3C context on every packet.
//
// The `telemetry` plugin builds the writer from `createDatabase({ telemetry })` —
// `{ api }` or `{ tracer, meter }` — and hands it to the core, which records
// through the contract of src/telemetry/writer.js (DISABLED, `traced`). Without the
// plugin `createDatabase({ telemetry: { api } })` is PLUGIN_MISSING; a writer given as
// it is the core takes without the plugin. Every recording path is
// contained — a tracer, meter, span or instrument that throws must never
// break a write.

const {
  DISABLED,
  SCOPE_NAME,
  SPAN_STATUS_ERROR,
  IDENTITY_KEYS,
  hasMethod,
  isWriter,
  writerOf,
  contained,
} = require('./writer.js');

const IDENTITY = new Set(IDENTITY_KEYS);

/**
 * Two injection modes:
 * - `{ api }` — the @opentelemetry/api module, from which syncom derives its
 *   own tracer and meter so spans carry the right instrumentation scope.
 * - `{ tracer, meter }` — pre-built instances; either may be absent, and a
 *   tracer-only or meter-only configuration is fully supported.
 */
const resolveTracerAndMeter = (telemetry) => {
  if (telemetry.api) {
    const { api } = telemetry;
    return {
      tracer: hasMethod(api.trace, 'getTracer') ? api.trace.getTracer(SCOPE_NAME) : null,
      meter: hasMethod(api.metrics, 'getMeter') ? api.metrics.getMeter(SCOPE_NAME) : null,
    };
  }
  return { tracer: telemetry.tracer ?? null, meter: telemetry.meter ?? null };
};

// Opens a span (active when the tracer can, detached otherwise) and invokes
// `fn(handle)` exactly once. Unlike wrpc — where a tracer that never calls
// its callback merely means one RPC does not happen — a skipped callback here
// would be a silently lost write, so the callback's own result is what is
// returned, and a tracer that returned without invoking it gets the work run
// detached.
const startSpanWith = (tracer, name, options, handle, fn) => {
  if (hasMethod(tracer, 'startActiveSpan')) {
    let invoked = false;
    let value;
    try {
      tracer.startActiveSpan(name, options, (span) => {
        if (invoked) return value;
        handle.span = span ?? null;
        invoked = true;
        value = fn(handle);
        return value;
      });
    } catch (error) {
      // An error thrown by `fn` itself must propagate untouched; only a
      // tracer that broke BEFORE running the callback is swallowed.
      if (invoked) throw error;
      return fn(handle);
    }
    return invoked ? value : fn(handle);
  }
  try {
    handle.span = hasMethod(tracer, 'startSpan') ? tracer.startSpan(name, options) : null;
  } catch {
    handle.span = null;
  }
  return fn(handle);
};

const recordSpanError = (handle, error, includeIdentity) => {
  try {
    handle.error = true;
    const span = handle?.span;
    if (!span) return;
    // A message such as "Record <id> is invalid" is identity too: without
    // it, the status says what kind of failure, not whose.
    if (includeIdentity) span.recordException?.(error);
    const message = includeIdentity ? error?.message : String(error?.code ?? error?.name ?? 'error');
    span.setStatus?.({ code: SPAN_STATUS_ERROR, message });
    if (error?.name) span.setAttribute?.('error.type', error.name);
  } catch {
    // Telemetry must never break the write path.
  }
};

const endSpanHandle = (handle, attributes, includeIdentity) => {
  try {
    const span = handle?.span;
    if (!span) return;
    if (attributes) {
      const keys = Object.keys(attributes);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const value = attributes[key];
        if (value === undefined || value === null) continue;
        if (!includeIdentity && IDENTITY.has(key)) continue;
        span.setAttribute?.(key, value);
      }
    }
    span.end();
  } catch {}
};

// What the gauges read: one callback per instrument, each contained.
const GAUGES = Object.freeze([
  ['syncom.outbox.size', 'outbox', 'Ops queued for peers, over every dialed peer'],
  ['syncom.queue.depth', 'queue', 'Writes waiting on, or running in, the mutation queue'],
  ['syncom.cache.size', 'cache', 'Entries in the record cache'],
  ['syncom.catalog.size', 'catalog', 'Rows in the record catalog, tombstones included'],
  ['syncom.log.length', 'log', 'Entries retained in the operation log'],
  ['syncom.inflight', 'inflight', 'Local ops appended and not landed yet'],
  ['syncom.deferred', 'deferred', 'Records whose files wait for the deferred window'],
  ['syncom.held', 'held', 'Records held in memory after a file write failed'],
]);

// Label sets for the fixed-attribute samples, built once: they ride on every
// write when metrics are on.
const PATH_COMMIT = Object.freeze({ 'syncom.path': 'commit' });
const PATH_APPLY = Object.freeze({ 'syncom.path': 'apply' });
const PATH_REPLAY = Object.freeze({ 'syncom.path': 'replay' });
const OUTCOME_APPLIED = Object.freeze({ 'syncom.outcome': 'applied' });
const OUTCOME_SKIPPED = Object.freeze({ 'syncom.outcome': 'skipped' });
const OUTCOME_DUPLICATE = Object.freeze({ 'syncom.outcome': 'duplicate' });
const OUTCOME_GAP = Object.freeze({ 'syncom.outcome': 'gap' });
const OUTCOME_MALFORMED = Object.freeze({ 'syncom.outcome': 'malformed' });
const OUTCOME_REFUSED = Object.freeze({ 'syncom.outcome': 'refused' });
const SEGMENT_SEALED = Object.freeze({ 'syncom.log.event': 'sealed' });
const SEGMENT_DROPPED = Object.freeze({ 'syncom.log.event': 'dropped' });

/**
 * Builds the writer once from the `telemetry` option. Idempotent on a writer:
 * Storage builds its own and hands that same object to OpLog and SyncManager.
 */
const createTelemetry = (telemetry) => {
  if (!telemetry || typeof telemetry !== 'object') return DISABLED;
  if (isWriter(telemetry)) return writerOf(telemetry);

  let tracer = null;
  let meter = null;
  try {
    ({ tracer, meter } = resolveTracerAndMeter(telemetry));
  } catch {
    return DISABLED;
  }
  if (!tracer && !meter) return DISABLED;

  const includeIdentity = telemetry.includeIdentity !== false;

  let commits = null;
  let writeDuration = null;
  let opsReceived = null;
  let opsRejected = null;
  let conflicts = null;
  let limited = null;
  let lag = null;
  let pushOps = null;
  let bootstraps = null;
  let logSegments = null;
  let appendDuration = null;
  let groupOps = null;
  let appendFailures = null;
  let flushDuration = null;
  let hookDuration = null;
  let lockWait = null;
  let engineWrite = null;
  let refused = null;
  let presenceRefused = null;
  let handleFlushes = null;
  let queryCache = null;
  let queryLive = null;
  let queryPlans = null;
  let bulkRows = null;
  let pipelineTurns = null;
  let pipelineLag = null;
  let cleanupTombstones = null;
  let dumpPages = null;
  let insertsNamed = null;
  let sharedOps = null;
  let sharedEntries = null;
  let sharedLag = null;
  let revokes = null;
  let reads = null;
  let readRows = null;
  let blobs = null;
  let blobBytes = null;
  let tabsCalls = null;
  let tabsFailovers = null;
  let connectorRows = null;
  let toolCalls = null;
  let gauges = null;

  if (hasMethod(meter, 'createCounter') && hasMethod(meter, 'createHistogram')) {
    try {
      commits = meter.createCounter('syncom.commits', {
        unit: '{op}',
        description: 'Local writes committed, by op type and result',
      });
      writeDuration = meter.createHistogram('syncom.write.duration', {
        unit: 'ms',
        description: 'Duration of a local commit, an applied peer batch or a replayed tail',
      });
      opsReceived = meter.createCounter('syncom.ops.received', {
        unit: '{op}',
        description: 'Peer ops offered to this node, by outcome',
      });
      opsRejected = meter.createCounter('syncom.ops.rejected', {
        unit: '{op}',
        description:
          'Peer ops refused, by reason: a field of another kind, work past a bound, a payload the engine does not admit, invalid, out of scope, unreadable, forged, unsigned',
      });
      conflicts = meter.createCounter('syncom.conflicts', {
        unit: '{conflict}',
        description: 'Constraints a peer op left violated here, by kind (unique)',
      });
      limited = meter.createCounter('syncom.ops.limited', {
        unit: '{push}',
        description: 'Pushes a hosted unit refused by its limits, by reason (ops, bytes, rate)',
      });
      lag = meter.createHistogram('syncom.replication.lag', {
        unit: 'ms',
        description: 'Origin stamp to applied here, for each accepted peer op (clock skew included)',
      });
      pushOps = meter.createHistogram('syncom.push.ops', {
        unit: '{op}',
        description: 'Ops per push to a peer, by reason and result',
      });
      bootstraps = meter.createCounter('syncom.bootstraps', {
        unit: '{bootstrap}',
        description: 'Snapshot bootstraps from a peer, by result',
      });
      logSegments = meter.createCounter('syncom.log.segments', {
        unit: '{segment}',
        description: 'Log segments sealed and dropped',
      });
      appendDuration = meter.createHistogram('syncom.log.append.duration', {
        unit: 'ms',
        description: 'Duration of writing a batch to the open log',
      });
      groupOps = meter.createHistogram('syncom.log.group.ops', {
        unit: '{op}',
        description: 'Ops in one group the log wrote: every append that came while the one before was written',
      });
      appendFailures = meter.createCounter('syncom.log.append.failures', {
        unit: '{group}',
        description: 'Groups the log could not write: their seqs taken back, their writes rejected',
      });
      flushDuration = meter.createHistogram('syncom.defer.flush.duration', {
        unit: 'ms',
        description: 'Duration of landing the deferred window: the records files, one chain block',
      });
      hookDuration = meter.createHistogram('syncom.hook.duration', {
        unit: 'ms',
        description: 'Duration of a storage hook, by hook name',
      });
      lockWait = meter.createHistogram('syncom.lock.wait', {
        unit: 'ms',
        description: 'Time createDatabase() spent taking the directory lock',
      });
      engineWrite = meter.createHistogram('syncom.engine.write', {
        unit: 'ms',
        description: 'A write set of the engine, from the call to its return, by engine',
      });
      refused = meter.createCounter('syncom.hello.refused', {
        unit: '{call}',
        description: 'Calls a hosted unit refused before the handler, by code (400, 403, 409, 428)',
      });
      presenceRefused = meter.createCounter('syncom.presence.refused', {
        unit: '{entry}',
        description:
          'Presence a host or a receiver refused, by reason: hello, rate, malformed, scope, forged, unsigned, invalid',
      });
      handleFlushes = meter.createCounter('syncom.handle.flushes', {
        unit: '{flush}',
        description: 'Text handle flushes (openText), by result: ok, unlogged, error',
      });
      queryCache = meter.createCounter('syncom.query.cache', {
        unit: '{query}',
        description: 'Query results asked of the cache, by result: hit (nothing read), miss (a run)',
      });
      queryLive = meter.createCounter('syncom.query.live', {
        unit: '{change}',
        description: 'Live query changes, by result: reduce (the record placed), rerun (the cursor run again)',
      });
      queryPlans = meter.createCounter('syncom.query.plans', {
        unit: '{plan}',
        description: 'Cursors planned, by scan: index, postings, collection, text',
      });
      bulkRows = meter.createCounter('syncom.bulk.rows', {
        unit: '{row}',
        description: 'Rows of bulk writes, by result: success, error',
      });
      pipelineTurns = meter.createCounter('syncom.pipeline.turns', {
        unit: '{turn}',
        description: 'Pipeline turns handed to a handler, by result: handled, failed',
      });
      pipelineLag = meter.createHistogram('syncom.pipeline.lag', {
        unit: 'ms',
        description: 'From the last op of a turn to its handler done (live turns; a replay has no stamp)',
      });
      cleanupTombstones = meter.createCounter('syncom.cleanup.tombstones', {
        unit: '{tombstone}',
        description: 'Tombstones a cleanup sweep took, by result: folded, dropped',
      });
      dumpPages = meter.createCounter('syncom.dump.pages', {
        unit: '{page}',
        description: 'Pages of a dump, by kind: export, import',
      });
      insertsNamed = meter.createCounter('syncom.insert.named', {
        unit: '{insert}',
        description: 'Inserts under an id the data named, by result: ok, exists',
      });
      sharedOps = meter.createCounter('syncom.shared.ops', {
        unit: '{op}',
        description:
          'Ops through the shared log, by result: relayed (appended to the topic), applied (from the topic or the inbox), forwarded (to the inbox), dropped (an inbox op the writer did not take)',
      });
      sharedEntries = meter.createCounter('syncom.shared.entries', {
        unit: '{entry}',
        description:
          'Entries of the shared log, by result: passed, malformed, hole, failed (an append), retried (an apply tried again), stuck',
      });
      sharedLag = meter.createHistogram('syncom.shared.lag', {
        unit: 'ms',
        description: 'From the newest op of a topic entry (its stamp) to its apply here',
      });
      revokes = meter.createCounter('syncom.revoke', {
        unit: '{revoke}',
        description:
          'Scopes taken back from a node, by via: local (sync.revoke here), shared (folded from the shared log)',
      });
      reads = meter.createCounter('syncom.reads', {
        unit: '{call}',
        description:
          "A thin client's reads served, by procedure (query, count) and result (ok, capped: the read budget ended the walk)",
      });
      readRows = meter.createHistogram('syncom.reads.rows', {
        unit: '{row}',
        description: 'Rows a query answered, or a count counted, by procedure',
      });
      blobs = meter.createCounter('syncom.blobs', {
        unit: '{blob}',
        description: 'Blobs by direction (put, get, served, fetched) and result (ok, mismatch, missing)',
      });
      blobBytes = meter.createCounter('syncom.blob.bytes', {
        unit: 'By',
        description: 'Bytes of the blobs put, read, served to a peer and fetched from one, by direction',
      });
      tabsCalls = meter.createCounter('syncom.tabs.calls', {
        unit: '{call}',
        description:
          "A follower's calls to the leader (@alexify/syncom/shared), by result: ok, retried, lost, answered (a retry the leader answered from what it kept)",
      });
      tabsFailovers = meter.createCounter('syncom.tabs.failovers', {
        unit: '{change}',
        description: 'Changes of role of a shared facade, by kind: promoted, demoted, yielded',
      });
      connectorRows = meter.createCounter('syncom.connector.rows', {
        unit: '{row}',
        description:
          "A connector's documents and rows by direction (pull, push) and result: pulled, applied, pushed, probed, refused, parked, conflict, failed (a handler or a landing, tried again)",
      });
      toolCalls = meter.createCounter('syncom.mcp.calls', {
        unit: '{call}',
        description: "An agent's tool calls by procedure (the verb) and result: ok, refused (an argument's no), error",
      });
      // Observable: read when the SDK collects, through the callbacks
      // `gauges(read)` registers. Optional — a meter without the factory
      // keeps the counters and histograms.
      if (hasMethod(meter, 'createObservableGauge')) {
        const made = [];
        for (let i = 0; i < GAUGES.length; i++) {
          const [name, key, description] = GAUGES[i];
          const unit = key === 'log' || key === 'catalog' ? '{entry}' : '{op}';
          made.push([meter.createObservableGauge(name, { unit, description }), key]);
        }
        gauges = made;
      }
    } catch {
      commits = null;
      writeDuration = null;
      opsReceived = null;
      opsRejected = null;
      conflicts = null;
      limited = null;
      lag = null;
      pushOps = null;
      bootstraps = null;
      logSegments = null;
      appendDuration = null;
      groupOps = null;
      appendFailures = null;
      flushDuration = null;
      hookDuration = null;
      lockWait = null;
      engineWrite = null;
      refused = null;
      gauges = null;
    }
  }

  const add = (instrument, value, attributes) => {
    try {
      instrument?.add(value, attributes);
    } catch {}
  };
  const record = (instrument, value, attributes) => {
    try {
      instrument?.record(value, attributes);
    } catch {}
  };

  return contained({
    enabled: true,

    /**
     * Opens a span around one unit of work and invokes `fn(handle)` exactly
     * once. The handle is mutable — `{ span, error }` — rather than a raw
     * span, because the span is NOT ended here: `endSpan` does that from the
     * caller's `finally`, which is the only place that knows the work is done.
     * `attributes` is a literal built by the call site for this span alone.
     */
    withSpan(name, attributes, fn) {
      const handle = { span: null, error: false };
      if (!tracer) return fn(handle);
      if (!includeIdentity) for (const key of IDENTITY_KEYS) delete attributes[key];
      return startSpanWith(tracer, name, { attributes }, handle, fn);
    },

    recordError(handle, error) {
      recordSpanError(handle, error, includeIdentity);
    },

    endSpan(handle, attributes) {
      endSpanHandle(handle, attributes, includeIdentity);
    },

    // `path`: through the queue, or made at once (src/commit.js commitAtOnce — counted, never spanned); a
    // write folded into the one before it (`coalesced`) has no duration of its own.
    recordCommit(type, result, elapsed, path = 'queue') {
      add(commits, 1, { 'syncom.op.type': type, 'syncom.result': result, 'syncom.path': path });
      if (result !== 'coalesced') record(writeDuration, elapsed, PATH_COMMIT);
    },

    recordApply(result, elapsed) {
      // `applied` counts every accepted op, the skipped ones among them:
      // the two outcomes are told apart here.
      const skipped = result.skipped ?? 0;
      if (result.applied - skipped > 0) add(opsReceived, result.applied - skipped, OUTCOME_APPLIED);
      if (skipped > 0) add(opsReceived, skipped, OUTCOME_SKIPPED);
      if (result.duplicates > 0) add(opsReceived, result.duplicates, OUTCOME_DUPLICATE);
      if (result.gaps > 0) add(opsReceived, result.gaps, OUTCOME_GAP);
      const refused =
        (result.forged ?? 0) + (result.unsigned ?? 0) + (result.outOfScope ?? 0) + (result.equivocations ?? 0);
      if (refused > 0) add(opsReceived, refused, OUTCOME_REFUSED);
      record(writeDuration, elapsed, PATH_APPLY);
    },

    recordMalformed() {
      add(opsReceived, 1, OUTCOME_MALFORMED);
    },

    recordRejected(reason) {
      add(opsRejected, 1, { 'syncom.reason': reason });
    },

    recordConflict(kind) {
      add(conflicts, 1, { 'syncom.kind': kind });
    },

    recordLimited(reason) {
      add(limited, 1, { 'syncom.reason': reason });
    },

    // The op's stamp is the origin's wall clock at commit time
    // (vector.js Clock), so this is skew plus transit plus queueing.
    recordLag(ts) {
      if (typeof ts === 'number') record(lag, Math.max(0, Date.now() - ts));
    },

    recordReplay(elapsed) {
      record(writeDuration, elapsed, PATH_REPLAY);
    },

    recordPush(reason, result, count) {
      record(pushOps, count, { 'syncom.push.reason': reason, 'syncom.result': result });
    },

    recordBootstrap(result) {
      add(bootstraps, 1, { 'syncom.result': result });
    },

    recordLogRoll(sealed, dropped) {
      if (sealed > 0) add(logSegments, 1, SEGMENT_SEALED);
      if (dropped > 0) add(logSegments, dropped, SEGMENT_DROPPED);
    },

    recordAppend(elapsed, ops) {
      record(appendDuration, elapsed);
      if (typeof ops === 'number') record(groupOps, ops);
    },

    recordAppendFailure() {
      add(appendFailures, 1);
    },

    recordFlush(elapsed) {
      record(flushDuration, elapsed);
    },

    recordHook(name, elapsed) {
      record(hookDuration, elapsed, { 'syncom.hook': name });
    },

    recordLockWait(elapsed) {
      record(lockWait, elapsed);
    },

    recordEngineWrite(name, elapsed, ok) {
      record(engineWrite, elapsed, { 'syncom.engine': name, 'syncom.ok': ok });
    },

    recordRefusal(code, reason) {
      add(refused, 1, { 'syncom.code': String(code), 'syncom.reason': String(reason ?? 'unknown') });
    },

    recordPresenceRefused(reason, count) {
      add(presenceRefused, count, { 'syncom.reason': reason });
    },

    recordHandleFlush(result) {
      add(handleFlushes, 1, { 'syncom.result': result });
    },

    recordQueryCache(result) {
      add(queryCache, 1, { 'syncom.result': result });
    },

    recordQueryLive(result) {
      add(queryLive, 1, { 'syncom.result': result });
    },

    recordQueryPlan(scan) {
      add(queryPlans, 1, { 'syncom.scan': scan });
    },

    recordBulk(result, count) {
      if (count > 0) add(bulkRows, count, { 'syncom.result': result });
    },

    // `ts` is the turn's last op's stamp (the origin's clock): the lag is skew plus the handler's wait, a trend.
    recordPipeline(result, ts) {
      add(pipelineTurns, 1, { 'syncom.result': result });
      if (typeof ts === 'number') record(pipelineLag, Math.max(0, Date.now() - ts));
    },

    recordCleanup(result, count) {
      if (count > 0) add(cleanupTombstones, count, { 'syncom.result': result });
    },

    recordDump(kind) {
      add(dumpPages, 1, { 'syncom.kind': kind });
    },

    recordInsertNamed(result) {
      add(insertsNamed, 1, { 'syncom.result': result });
    },

    recordShared(result, count) {
      if (count > 0) add(sharedOps, count, { 'syncom.result': result });
    },

    recordSharedEntry(result) {
      add(sharedEntries, 1, { 'syncom.result': result });
    },

    // The entry's newest op's stamp (the origin's clock) to its apply: skew and the bus's transit, a trend.
    recordSharedLag(ms) {
      record(sharedLag, ms);
    },

    recordRevoke(via) {
      add(revokes, 1, { 'syncom.via': via });
    },

    recordRead(procedure, result, rows) {
      add(reads, 1, { 'syncom.procedure': procedure, 'syncom.result': result });
      record(readRows, rows, { 'syncom.procedure': procedure });
    },

    recordBlob(direction, result, bytes) {
      add(blobs, 1, { 'syncom.direction': direction, 'syncom.result': result });
      if (bytes > 0) add(blobBytes, bytes, { 'syncom.direction': direction });
    },

    recordForward(result) {
      add(tabsCalls, 1, { 'syncom.result': result });
    },

    recordFailover(kind) {
      add(tabsFailovers, 1, { 'syncom.kind': kind });
    },

    recordConnector(direction, result, count) {
      if (count > 0) add(connectorRows, count, { 'syncom.direction': direction, 'syncom.result': result });
    },

    recordTool(verb, result) {
      add(toolCalls, 1, { 'syncom.procedure': verb, 'syncom.result': result });
    },

    /**
     * Registers `read` — `() => ({ outbox, queue, cache, catalog, log })` —
     * behind the observable gauges, which the SDK samples when it collects.
     * One storage per meter for these: two would observe over each other.
     */
    gauges(read) {
      if (!gauges) return;
      for (const [gauge, key] of gauges) {
        try {
          gauge.addCallback((result) => {
            try {
              const value = read()[key];
              if (typeof value === 'number') result.observe(value);
            } catch {}
          });
        } catch {}
      }
    },
  });
};

/** The plugin: the writer built from `createDatabase({ telemetry })`, handed to the core. */
const telemetry = Object.freeze({
  name: 'telemetry',
  setup({ options }) {
    return { telemetry: createTelemetry(options.telemetry) };
  },
});

module.exports = { telemetry, createTelemetry };
