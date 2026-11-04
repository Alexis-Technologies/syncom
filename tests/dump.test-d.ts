import { expectError, expectType } from 'tsd';
import { exportJSON, exportPages, importJSON, migrateStorage } from '../src/dump/dump.js';
import type { Dump, DumpRecord } from '../src/dump/dump.js';
import type { Database, Engine } from '../index.js';

declare const db: Database;
declare const engine: Engine;
expectType<Promise<Dump>>(exportJSON(db, { collections: ['Post'], meta: false }));
expectType<AsyncIterableIterator<DumpRecord[]>>(exportPages(db, { limit: 10 }));
expectType<Promise<{ mode: 'merge' | 'insert'; records: number }>>(
  importJSON(db, { records: [{ id: 'x', data: {} }] }, { mode: 'insert' }),
);
expectType<Promise<{ records: number; pieces: number; copies: number; kv: number; entries: number }>>(
  migrateStorage({ from: engine, to: engine, path: 'p' }),
);
expectType<Promise<{ mode: 'merge'; records: number }>>(migrateStorage({ from: db, to: db, mode: 'merge' }));
expectError(importJSON(db, {}));
