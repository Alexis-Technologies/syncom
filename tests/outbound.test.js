'use strict';

// outbound() picks by stream (the log's index) what a receiver lacks: held
// here to the walk over the whole log it replaced, on seeded logs of several
// origins, scopes and bootstrap ops, with compaction moving the floor.

const test = require('node:test');
const assert = require('node:assert');
const { OpLog } = require('../src/log.js');
const { memory } = require('../src/memory/memory.js');
const { outbound } = require('../src/outbound.js');
const { opInScope } = require('../src/scope.js');
const { vectorHas, opKey, isBootstrapOp } = require('../src/vector.js');
const { prng } = require('./utils/mesh.js');

// The walk outbound() was: every retained entry, in log order.
const walked = (log, { exclude, vector, scopes = null, own, allStreams = false }) => {
  const ops = [];
  const first = {};
  for (const { op } of log.scan()) {
    if (op.origin === exclude || op.from === exclude) continue;
    if (!opInScope(op, scopes)) continue;
    if ((allStreams || op.origin === own) && !isBootstrapOp(op)) first[opKey(op)] ??= op.seq;
    if (vectorHas(vector, op)) continue;
    ops.push(op);
  }
  return { ops, first };
};

test('outbound() picks by stream what the walk over the whole log picked, in log order', async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const random = prng(seed);
    const log = await new OpLog('/l', { fsi: memory(), rollAfter: 8, retention: { ops: 120 }, logger: false });
    const origins = ['me', 'peer', 'third'];
    const scopes = [undefined, 'a', 'b'];
    const seqs = new Map();
    let ts = 0;
    for (let i = 0; i < 400; i++) {
      const origin = origins[Math.floor(random() * origins.length)];
      const boot = random() < 0.1;
      const scope = boot ? undefined : scopes[Math.floor(random() * scopes.length)];
      const op = boot
        ? { origin, type: 'merge', id: `r${i % 20}`, from: origins[Math.floor(random() * origins.length)], scope }
        : { origin, type: 'set', id: `r${i % 20}`, data: { i }, scope };
      if (scope === undefined) delete op.scope;
      const key = opKey(op);
      op.seq = (seqs.get(key) ?? 0) + 1;
      seqs.set(key, op.seq);
      op.ts = ++ts;
      await log.append([op]);
    }
    await log.flush();
    assert.ok(log.floor > 1, `seed ${seed}: compacted (floor ${log.floor})`);
    for (let k = 0; k < 30; k++) {
      const vector = {};
      for (const [key, seq] of seqs) if (random() < 0.7) vector[key] = Math.floor(random() * (seq + 2));
      const asked = {
        exclude: random() < 0.5 ? 'peer' : 'nobody',
        vector,
        scopes: random() < 0.5 ? null : [random() < 0.5 ? 'a' : 'b'],
        own: 'me',
        allStreams: random() < 0.3,
      };
      const got = outbound(log, asked);
      const want = walked(log, asked);
      assert.deepStrictEqual(got.first, want.first, `seed ${seed}, ask ${k}: first`);
      assert.strictEqual(got.ops.length, want.ops.length, `seed ${seed}, ask ${k}: count`);
      for (let i = 0; i < want.ops.length; i++) assert.strictEqual(got.ops[i], want.ops[i], `seed ${seed}: op ${i}`);
    }
    await log.close();
  }
});
