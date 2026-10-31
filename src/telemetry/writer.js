'use strict';

// The telemetry writer the engine records through — the contract, the
// disabled writer, and `traced`, the span bracket every write path uses.
// Nothing here imports anything. The OpenTelemetry adapter that builds a
// writer from the `@opentelemetry/api` module or pre-built tracer/meter
// instances is the telemetry plugin's (src/telemetry/telemetry.js,
// @alexify/syncom/telemetry); the core takes a writer given to
// `open({ telemetry })` (duck-typed: `enabled` and `withSpan`) through
// `writerOf`, which contains it: a method it lacks records nothing, a method
// that throws is swallowed — a writer must never break a write, or hang one
// (a write path that threw after its append once left every write behind it
// waiting). The one thing NOT swallowed is an error thrown by the work the
// span brackets.

// 0 = UNSET, 1 = OK, 2 = ERROR. Frozen by the OTel specification, so
// hardcoding it is what avoids importing @opentelemetry/api for a constant.
const SPAN_STATUS_ERROR = 2;

// Instrumentation scope. The version argument of getTracer/getMeter is
// deliberately omitted: reading it would mean requiring package.json, which
// would drag this file's whole dependency graph into browser bundles.
const SCOPE_NAME = '@alexify/syncom';

// Span attributes that identify a record, a peer or a tenant. They stay off
// the span when `includeIdentity` is false — and so does the text of an
// exception, which names records; they are never metric labels at any
// setting — a record id or a peer url on a label is unbounded cardinality.
const IDENTITY_KEYS = Object.freeze(['syncom.record.id', 'syncom.peer.url', 'syncom.peer.node', 'syncom.scope']);

const hasMethod = (value, name) => typeof value?.[name] === 'function';
const noop = () => {};

// Monotonic where the platform has it; wall-clock otherwise. Only ever read
// when telemetry is on, so the disabled path costs no clock read.
const now = () =>
  typeof performance === 'object' && typeof performance.now === 'function' ? performance.now() : Date.now();

const DISABLED = Object.freeze({
  enabled: false,
  // The lifecycle wrapper still runs its callback — that is what lets a call
  // site bracket a write the same way whether telemetry is on or off.
  withSpan(_name, _attributes, fn) {
    return fn(null);
  },
  recordError: noop,
  endSpan: noop,
  recordCommit: noop,
  recordApply: noop,
  recordMalformed: noop,
  recordRejected: noop,
  recordConflict: noop,
  recordLimited: noop,
  recordLag: noop,
  recordReplay: noop,
  recordPush: noop,
  recordBootstrap: noop,
  recordLogRoll: noop,
  recordAppend: noop,
  recordAppendFailure: noop,
  recordFlush: noop,
  recordHook: noop,
  recordLockWait: noop,
  recordRefusal: noop,
  recordPresenceRefused: noop,
  recordHandleFlush: noop,
  gauges: noop,
});

const isWriter = (value) => typeof value.enabled === 'boolean' && typeof value.withSpan === 'function';

// The recording methods of a writer, beside `enabled` and `withSpan`.
const METHODS = Object.freeze([
  'recordError',
  'endSpan',
  'recordCommit',
  'recordApply',
  'recordMalformed',
  'recordRejected',
  'recordConflict',
  'recordLimited',
  'recordLag',
  'recordReplay',
  'recordPush',
  'recordBootstrap',
  'recordLogRoll',
  'recordAppend',
  'recordAppendFailure',
  'recordFlush',
  'recordHook',
  'recordLockWait',
  'recordRefusal',
  'recordPresenceRefused',
  'recordHandleFlush',
  'gauges',
]);

// Writers that need no wrapping: the disabled one, the OpenTelemetry
// adapter's (contained method by method), and every writer `writerOf` made.
const CONTAINED = new WeakSet([DISABLED]);

/** Marks a writer whose every method is contained already (the adapter's). */
const contained = (writer) => {
  CONTAINED.add(writer);
  return writer;
};

const containMethod = (given, name) => {
  const method = given[name];
  if (typeof method !== 'function') return noop;
  // Four arguments: the widest method's (`recordCommit(type, result, elapsed, path)`).
  return (a, b, c, d) => {
    try {
      return method.call(given, a, b, c, d);
    } catch {
      // A writer that throws records nothing; the write goes on.
      return undefined;
    }
  };
};

// A writer of the application's, contained: `withSpan` runs the work exactly
// once whatever the writer does around it — throws before or after it, never
// calls it, calls it twice — and hands back the work's own result or error;
// a missing or throwing method records nothing.
const contain = (given) => {
  const out = {
    enabled: given.enabled,
    withSpan(name, attributes, fn) {
      // 0: not run, 1: returned `value`, 2: threw `failure`.
      let state = 0;
      let value;
      let failure;
      const once = (handle) => {
        if (state === 0) {
          try {
            value = fn(handle);
            state = 1;
          } catch (error) {
            failure = error;
            state = 2;
          }
        }
        if (state === 2) throw failure;
        return value;
      };
      try {
        given.withSpan(name, attributes, once);
      } catch {
        // The writer's own throw, or the work's rethrown: decided below.
      }
      if (state === 0) return fn(null);
      if (state === 2) throw failure;
      return value;
    },
  };
  for (let i = 0; i < METHODS.length; i++) out[METHODS[i]] = containMethod(given, METHODS[i]);
  return contained(Object.freeze(out));
};

// A writer — the storage hands its own down to the log and the sync manager,
// an application may hand one of its own in — contained, or the disabled
// one. The OpenTelemetry adapter is the telemetry plugin's.
const writerOf = (value) => {
  if (!value || typeof value !== 'object' || !isWriter(value)) return DISABLED;
  return CONTAINED.has(value) ? value : contain(value);
};

/**
 * Runs `task()` inside a span: `attributes` open it, `after(result)` supplies
 * the attributes it ends with, and a throw marks it failed before
 * propagating. What the task returns is returned; timing and metrics stay
 * with the caller, which is the only place that knows what to count.
 */
const traced = (otel, name, attributes, task, after) =>
  otel.withSpan(name, attributes, async (handle) => {
    try {
      const result = await task();
      otel.endSpan(handle, after(result));
      return result;
    } catch (error) {
      otel.recordError(handle, error);
      otel.endSpan(handle);
      throw error;
    }
  });

module.exports = {
  writerOf,
  isWriter,
  contained,
  METHODS,
  traced,
  now,
  DISABLED,
  SCOPE_NAME,
  SPAN_STATUS_ERROR,
  IDENTITY_KEYS,
  hasMethod,
  noop,
};
