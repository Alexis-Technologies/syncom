/**
 * Several tabs (src/shared/shared.js) over the memory engine, with the fake
 * locks and the in-process port of the tests: what a follower's write costs
 * through the leader (one round trip, the call kept for a retry), what a
 * recorded transaction costs, and how long a failover takes — the leader
 * closes, the follower is elected and opens as the leader (review №7, E6).
 *
 * Run with `node bench/tabs.js` or `pnpm bench`.
 */

'use strict';

const { bench } = require('./support/harness.js');
const { createDatabase, memoryEngine } = require('../src/all/all.js');
const { openShared } = require('../src/shared/shared.js');
const { createFakeLocks } = require('../tests/utils/fake-locks.js');
const { createLeaderPort } = require('../tests/utils/fake-port.js');

const schema = { entities: { Task: {} } };

const main = async () => {
  const engine = memoryEngine();
  const locks = createFakeLocks();
  const port = createLeaderPort();
  const open = async () => {
    const shared = await openShared({
      createDatabase,
      engine,
      path: 'bench/tabs',
      logger: false,
      defer: 0,
      schema,
      channel: port.dial,
      election: { locks },
      grace: 20,
      failover: 5000,
    });
    const mount = () => port.mount(shared.serve());
    if (shared.leader) mount();
    shared.on('leader', mount);
    return shared;
  };
  const leader = await open();
  const follower = await open();
  let n = 0;
  await bench(
    'forward — a follower’s set() carried to the leader and answered (the call kept for a retry)',
    () => follower.set(`t${n++ % 1000}`, { title: 'from the follower' }),
    { warmup: 50, measureMs: 1500 },
  );
  await bench(
    'transact — a follower’s recorded transaction of 10 sets, carried whole',
    () =>
      follower.transact(async (tx) => {
        for (let i = 0; i < 10; i++) await tx.set(`x${i}`, { n: i });
      }),
    { warmup: 20, measureMs: 1500, opsPerIteration: 10 },
  );
  await bench('read — a follower’s get() of what the leader wrote (its own instance)', () => follower.get('t1'));

  port.mount(null);
  const started = performance.now();
  await leader.close();
  await follower.waitForLeadership({ signal: AbortSignal.timeout(10_000) });
  const ms = performance.now() - started;
  console.log(`failover — the leader closed, the follower elected and open as the leader: ${ms.toFixed(0)} ms`);
  await follower.close();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
