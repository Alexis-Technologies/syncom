import { expectType } from 'tsd';
import {
  createMesh,
  settle,
  waitUntil,
  sameVectors,
  prng,
  withDatabase,
  memoryEngine,
  MemoryLink,
} from '../src/testing/testing.js';
import type { Mesh, MemoryEngine, SyncedDatabase } from '../src/testing/testing.js';
import { createDatabase } from '../src/all/all.js';

const engine = memoryEngine();
expectType<MemoryEngine>(engine);
const mesh = await createMesh(['A', 'B'], [['A', 'B']], {
  // `/all`'s createDatabase over a spread of StorageOptions (`plugins?: Plugin<any>[]`) answers `any`: the node's
  // type is said here, as an application's factory would.
  createStorage: (name, options): Promise<SyncedDatabase> =>
    createDatabase({ ...options, path: name, engine, lock: false, logger: false }),
  link: { latency: 1, drop: () => false, duplicate: (page) => page === null },
  unit: { access: 'public' },
  scopes: { A: ['*'] },
});
const a = mesh.get('A');
expectType<string>(a.nodeId);
expectType<Map<string, MemoryLink>>(mesh.links);
await settle(mesh.storages);
await settle([a, mesh.get('B')], { timeout: 1000, step: 5 });
expectType<boolean>(sameVectors(mesh.storages));
await waitUntil(() => a.stats().queue === 0, { timeout: 100 });
expectType<number>(prng(7)());
const link = new MemoryLink(mesh.units.get('A')!, { latency: 5 });
link.disconnect();
await link.reconnect({ freshClient: false });
expectType<string[]>(link.calls);
expectType<boolean>(link.down);
expectType<unknown>(await link.call('syncom/hello', {}));
const count = await withDatabase(
  () => createDatabase({ engine, path: 'solo', lock: false }),
  async (db) => (await db.list()).length,
);
expectType<number>(count);
await mesh.close();
expectType<Mesh<SyncedDatabase>>(mesh);
expectType<SyncedDatabase>(a);
