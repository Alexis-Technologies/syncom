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
// The `telemetry` plugin builds the writer from `open({ telemetry })` —
// `{ api }` or `{ tracer, meter }` — and hands it to the core, which records
// through the contract of src/telemetry.js (DISABLED, `traced`). Without the
// plugin `open({ telemetry: { api } })` is PLUGIN_MISSING; a writer given as
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
} = require('../telemetry.js');

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
  let hookDuration = null;
  let lockWait = null;
  let refused = null;
  let presenceRefused = null;
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
      hookDuration = meter.createHistogram('syncom.hook.duration', {
        unit: 'ms',
        description: 'Duration of a storage hook, by hook name',
      });
      lockWait = meter.createHistogram('syncom.lock.wait', {
        unit: 'ms',
        description: 'Time open() spent taking the directory lock',
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
      hookDuration = null;
      lockWait = null;
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

    recordCommit(type, result, elapsed) {
      add(commits, 1, { 'syncom.op.type': type, 'syncom.result': result });
      record(writeDuration, elapsed, PATH_COMMIT);
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

    recordAppend(elapsed) {
      record(appendDuration, elapsed);
    },

    recordHook(name, elapsed) {
      record(hookDuration, elapsed, { 'syncom.hook': name });
    },

    recordLockWait(elapsed) {
      record(lockWait, elapsed);
    },

    recordRefusal(code) {
      add(refused, 1, { 'syncom.code': String(code) });
    },

    recordPresenceRefused(reason, count) {
      add(presenceRefused, count, { 'syncom.reason': reason });
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

/** The plugin: the writer built from `open({ telemetry })`, handed to the core. */
const telemetry = Object.freeze({
  name: 'telemetry',
  setup({ options }) {
    return { telemetry: createTelemetry(options.telemetry) };
  },
});

module.exports = { telemetry, createTelemetry };
