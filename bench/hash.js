/**
 * `calculateHash` — on the write path twice per record: once over the stored
 * entry, once over the block that commits it (src/storage.js `saveData`), and
 * once per block again on every `Blockchain.validate()` walk. It is
 * `JSON.stringify` followed by SHA-256, so the stringify half dominates at
 * small sizes and the digest half takes over as records grow — which is why
 * the rows below scale the payload rather than repeating one shape.
 *
 * Run with `node bench/hash.js` or `pnpm bench`.
 */

'use strict';

const { bench } = require('./support/harness.js');
const { calculateHash } = require('../src/signing/ed25519.js');

const record = (fields, valueLength) => {
  const object = {};
  const value = 'x'.repeat(valueLength);
  for (let i = 0; i < fields; i++) object[`field${i}`] = value;
  return object;
};

const main = async () => {
  console.log(`Hash benchmark — Node ${process.version}\n`);

  {
    const block = { prev: '0', timestamp: Date.now(), data: {} };
    await bench('calculateHash — empty genesis block', () => calculateHash(block));
  }
  {
    const data = record(5, 16);
    await bench('calculateHash — small record (5 x 16 B)', () => calculateHash(data));
  }
  {
    const data = record(50, 64);
    await bench('calculateHash — medium record (50 x 64 B)', () => calculateHash(data));
  }
  {
    const data = record(200, 256);
    await bench('calculateHash — large record (200 x 256 B)', () => calculateHash(data));
  }
  {
    // Deep nesting costs the stringify half, not the digest half.
    const data = { a: { b: { c: { d: { e: record(10, 32) } } } } };
    await bench('calculateHash — deeply nested record', () => calculateHash(data));
  }
};

void main();
