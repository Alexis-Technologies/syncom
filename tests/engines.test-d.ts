import { expectAssignable, expectType } from 'tsd';
import { serveEngine, remoteEngine, connectEngine, copyEngine } from '../src/engines/engines.js';
import type { EnginePort, CopyEngineResult, Engine } from '../src/engines/engines.js';
import { memoryEngine } from '../src/memory/memory.js';
import { createDatabase } from '../index.js';

declare const port: MessagePort;
expectAssignable<EnginePort>(port);
const server = serveEngine(memoryEngine(), port);
expectType<Promise<void>>(server.close());
const engine = remoteEngine(port, { name: 'memory', capabilities: memoryEngine().capabilities });
expectAssignable<Engine>(engine);
expectType<Promise<void>>(engine.close());
await createDatabase({ engine });
const connected = await connectEngine(port);
expectAssignable<Engine>(connected);
const copied = await copyEngine(memoryEngine(), memoryEngine(), { path: 'app', batch: 100 });
expectType<CopyEngineResult>(copied);
expectType<number>(copied.records);
