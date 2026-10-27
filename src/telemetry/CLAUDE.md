# src/telemetry/CLAUDE.md — Telemetry

The injected writer and its contract. The rules of the core — the op model, the write paths, own keys, the log — are in [src/CLAUDE.md](../CLAUDE.md); what holds for the whole repository is in [CLAUDE.md](../../CLAUDE.md).

## Layout

```
src/telemetry/telemetry.js  @alexify/syncom/telemetry — the OpenTelemetry adapter (createTelemetry: { api } | { tracer, meter } → writer,
                          duck-typed; @opentelemetry/* only devDeps) and the plugin whose setup hands the core the writer
```

## Rules

- **Telemetry is injected, never required.** `createTelemetry` in
  `src/telemetry/telemetry.js` (the telemetry plugin's) duck-types whatever
  `open({ telemetry })` was given and returns a writer the plugin's `setup`
  hands the core (`telemetry` hook); the core takes a writer given to it
  (`isWriter`) CONTAINED by `writerOf` — a missing method is a no-op, a
  throwing one is swallowed, `withSpan` runs the work exactly once (a writer
  that threw after an append once hung every write) — and refuses an api or
  a tracer without the plugin; the lock
  wait is measured in `#init` and recorded once the writer is there.
  `DISABLED` (src/telemetry.js) is a frozen null-object whose `withSpan` still
  runs its callback, so call sites bracket work the same way on or off (but
  guard with `otel.enabled` before allocating attributes or reading the
  clock). syncom never puts trace context into ops — `tp`/`ts` are wrpc's,
  ops are durable — and its spans nest under the active context instead.
  Never mint a metric label from a record id, an origin, a peer url or a
  scope. Every `catch {}` in the writer has a hostile-implementation test in
  `tests/telemetry.test.js`; keep it that way or the branch threshold drops.
  The observable gauges are registered once, in `#open`, through
  `otel.gauges(read)`; `includeIdentity: false` strips `IDENTITY_KEYS` (the
  scope among them) at span start AND end and records a failure's `code`
  rather than the exception. A new `event:` name goes into the table in
  `docs/guide/telemetry.md` — the names are a surface.
