import { expectAssignable, expectType } from 'tsd';
import { sqliteEngine } from '../src/sqlite/sqlite.js';
import type { SqliteEngine, SqliteDatabase, SqliteDriver, SqliteStatement, Engine } from '../src/sqlite/sqlite.js';
import { createDatabase } from '../index.js';

const engine = sqliteEngine();
expectType<SqliteEngine>(engine);
expectAssignable<Engine>(engine);
expectType<'sqlite'>(engine.name);
expectType<string>(engine.file);
expectType<Promise<void>>(engine.close());
expectType<Promise<void>>(engine.destroy());
await createDatabase({ engine });

sqliteEngine({ file: 'app.sqlite', durable: true });
// A driver is duck-typed: exec and prepare, results awaited.
declare const statement: SqliteStatement;
const database: SqliteDatabase = {
  exec: (sql: string) => sql,
  prepare: async () => statement,
};
const driver: SqliteDriver = { open: () => database };
sqliteEngine({ driver });
sqliteEngine({ database });
