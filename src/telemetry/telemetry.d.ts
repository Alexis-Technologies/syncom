// Telemetry as a plugin (@alexify/syncom/telemetry): the OpenTelemetry
// adapter. `open({ plugins: [telemetry], telemetry: { api } })` — or
// `{ tracer, meter }` — builds the writer the core records through;
// `createTelemetry()` builds one by hand, to give `open({ telemetry })` as it
// is (a writer the core takes without the plugin, duck-typed), or to share
// with an OpLog opened on its own. The option types are the core's.

import type { Plugin, SyncomTelemetryOptions, SyncomTelemetryWriter } from '../../index.js';

export type { Plugin, SyncomTelemetryOptions, SyncomTelemetryWriter };

/** The plugin: `open({ telemetry })` adapted into the writer the core records through. */
export declare const telemetry: Plugin;

/** The writer for an api module or pre-built instances; the disabled writer for nothing usable; a writer as it is. */
export declare function createTelemetry(
  options?: SyncomTelemetryOptions | SyncomTelemetryWriter | null,
): SyncomTelemetryWriter;
