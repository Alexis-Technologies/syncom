/**
 * `Blockchain` — the integrity log every write goes through. `addBlock` is on
 * the write path of every `Storage.saveData`, and it costs one hash plus TWO
 * file writes (the block, then the rewritten tail pointer), so it is
 * filesystem-bound rather than crypto-bound.
 *
 * `validate` is the read side: it walks the chain backwards re-hashing each
 * block, so its cost is linear in how far back you ask it to go. The `last: N`
 * rows are there to make that slope visible — an unbounded `validate()` over a
 * long chain is the shape to watch out for.
 *
 * Writes go to a temp directory that is removed on exit.
 *
 * Run with `node bench/chain.js` or `pnpm bench`.
 */

'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { bench } = require('./support/harness.js');
const { Blockchain } = require('../src/chain/chain.js');

const makeTemp = () => fs.mkdtemp(path.join(os.tmpdir(), 'syncom-bench-chain-'));

const main = async () => {
  console.log(`Blockchain benchmark — Node ${process.version}\n`);

  const roots = [];
  const newChain = async () => {
    const root = await makeTemp();
    roots.push(root);
    return new Blockchain(root);
  };

  try {
    {
      const chain = await newChain();
      let i = 0;
      await bench('addBlock — small payload', () => chain.addBlock({ id: `r${i++}`, hash: 'x' }));
    }
    {
      const chain = await newChain();
      const data = { blob: 'x'.repeat(4096) };
      await bench('addBlock — 4 KB payload', () => chain.addBlock(data));
    }
    {
      const chain = await newChain();
      const hash = await chain.addBlock({ id: 'r0', hash: 'x' });
      await bench('readBlock — single block', () => chain.readBlock(hash));
    }

    // One chain, deep enough that the `last` rows below differ meaningfully.
    const chain = await newChain();
    for (let i = 0; i < 200; i++) await chain.addBlock({ id: `r${i}`, hash: 'x' });

    await bench('validate — last 1 block', () => chain.validate({ last: 1 }));
    await bench('validate — last 10 blocks', () => chain.validate({ last: 10 }));
    await bench('validate — last 100 blocks', () => chain.validate({ last: 100 }));
    await bench('validate — full 200-block chain', () => chain.validate(), { warmup: 5, measureMs: 500 });
  } finally {
    for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  }
};

void main();
