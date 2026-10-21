/**
 * Replication between nodes over an in-process link (tests/utils/memory-link.js
 * — JSON across the boundary, like a wrpc client, no socket): how long a
 * write on one node takes to be applied two hops away, what a host pays to
 * serve a snapshot page, what a new node pays to bootstrap from a host with
 * thousands of records, and what the host's live feed costs when every op
 * is another scope's.
 *
 * Writes go to a temp directory that is removed on exit.
 *
 * Run with `node bench/sync.js` or `pnpm bench`.
 */

'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { bench } = require('./support/harness.js');
const { open } = require('../src/storage.js');
const { MemoryLink } = require('../tests/utils/memory-link.js');

const record = { name: 'Example', email: 'example@example.com', hits: 0 };

// Nodes by name; a node dials `mem://<name>` and gets the host's unit.
const createNodes = async (root, names, options = {}) => {
  const units = new Map();
  const connect = (node) => new MemoryLink(units.get(node.url.slice('mem://'.length)));
  const nodes = new Map();
  for (const name of names) {
    const storage = await open({
      path: path.join(root, name),
      logger: false,
      ...options,
      sync: { connect, autoStart: false, ...options.sync },
    });
    nodes.set(name, storage);
    units.set(name, storage.sync.unit({ access: 'public' }));
  }
  return { nodes, units };
};

const applied = (storage) => new Promise((resolve) => storage.once('change', resolve));

const main = async () => {
  console.log(`Sync benchmark — Node ${process.version}\n`);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncom-bench-sync-'));
  try {
    // A → B → C: a write on A is pushed to B and relayed to C.
    const { nodes } = await createNodes(root, ['A', 'B', 'C']);
    const [A, B, C] = ['A', 'B', 'C'].map((name) => nodes.get(name));
    await A.sync.addNode({ url: 'mem://B' });
    await B.sync.addNode({ url: 'mem://C' });
    await A.sync.start();
    await B.sync.start();
    let n = 0;
    await bench(
      'write on A, applied on B (one hop)',
      async () => {
        const seen = applied(B);
        await A.set(`a-${++n}`, record);
        await seen;
      },
      { warmup: 10 },
    );
    await bench(
      'write on A, applied on C (two hops)',
      async () => {
        const seen = applied(C);
        await A.set(`a-${++n}`, record);
        await seen;
      },
      { warmup: 10 },
    );
    await bench(
      'update on A, applied on C (two hops)',
      async () => {
        const seen = applied(C);
        await A.update('a-1', { hits: n++ });
        await seen;
      },
      { warmup: 10 },
    );
    for (const storage of [A, B, C]) await storage.close();

    // A host with thousands of records whose log is compacted — a fresh node
    // cannot resume from it and bootstraps from a snapshot: one page served,
    // and a whole join.
    const many = 2000;
    const { nodes: hosts, units } = await createNodes(root, ['H'], {
      sync: { log: { rollAfter: 50 }, retention: { ops: 200 } },
    });
    const H = hosts.get('H');
    for (let i = 0; i < many; i++) await H.set(`h-${i}`, { ...record, i });
    await bench(`snapshot — one page of 500 out of ${many} (host side)`, () => H.snapshot({ limit: 500 }), {
      warmup: 5,
    });
    let joins = 0;
    await bench(
      `bootstrap — a new node joins a host of ${many} records`,
      async () => {
        const dir = path.join(root, `joiner-${++joins}`);
        const connect = () => new MemoryLink(units.get('H'));
        const joiner = await open({ path: dir, logger: false, sync: { connect, autoStart: false } });
        const done = new Promise((resolve) => joiner.sync.once('bootstrap', resolve));
        await joiner.sync.addNode({ url: 'mem://H' });
        await joiner.sync.start();
        await done;
        await joiner.close();
        await fs.rm(dir, { recursive: true, force: true });
      },
      { warmup: 1, measureMs: 3000 },
    );

    // The live feed under scopes: a subscriber of scope `a` while the host
    // appends ops of scope `b` only — every append wakes the feed, which
    // moves its cursor past the op and sends nothing.
    const scoped = await open({
      path: path.join(root, 'scoped'),
      logger: false,
      sync: { autoStart: false, scope: (id, data) => data.scope ?? '*' },
    });
    const unit = scoped.sync.unit({ access: 'public' });
    const link = new MemoryLink(unit);
    await link.call('syncom/hello', { node: 'listener', version: 1, scopes: ['a'] });
    link.subscribe('syncom/changes', { scopes: ['a'] }, { onData() {} });
    let k = 0;
    await bench(
      "append of another scope's op while a scoped feed listens",
      () => scoped.set(`b-${++k}`, { scope: 'b' }),
      {
        warmup: 20,
      },
    );
    await scoped.close();
    await H.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
