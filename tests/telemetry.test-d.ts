import { expectAssignable, expectType } from 'tsd';
import { telemetry, createTelemetry } from '../src/telemetry/telemetry.js';
import type { Plugin, SyncomTelemetryWriter } from '../src/telemetry/telemetry.js';
import { open } from '../index.js';
import type { StorageOptions } from '../index.js';

expectType<Plugin>(telemetry);
const writer = createTelemetry({ api: {} });
expectType<SyncomTelemetryWriter>(writer);
expectType<boolean>(writer.enabled);
expectType<number>(writer.withSpan('syncom.commit', {}, () => 1));
expectType<void | undefined>(writer.recordCommit?.('set', 'applied', 1, 'fast'));
expectType<void | undefined>(writer.recordHandleFlush?.('ok'));
expectAssignable<StorageOptions>({ telemetry: writer });
expectAssignable<StorageOptions>({ plugins: [telemetry], telemetry: { api: {} } });
await open({ plugins: [telemetry], telemetry: { includeIdentity: false } });
