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
  {
    // What names an op: SHA-256 of its header text (~300 characters) in JavaScript — the browser half's,
    // at once (src/crypto/sha256.js) — and the checksum every log line carries, both halves.
    const { sha256Now } = require('../src/crypto/sha256.js');
    const table = require('../src/crc32.browser.js');
    const zlib = require('../src/crc32.js');
    const key = 'K'.repeat(43);
    const header = JSON.stringify([
      1,
      key,
      12345,
      Date.now(),
      'splice',
      'record-id',
      null,
      null,
      1,
      'ada',
      key,
      null,
      key,
    ]);
    await bench('sha256Now — an op’s header, in JavaScript', () => sha256Now(header));
    const entries = [];
    for (let i = 0; i < 64; i++) entries.push([i + 1, key, header, { content: 'x', run: 12345, from: i }]);
    const line = JSON.stringify(entries);
    await bench('crc32 — a log line of 64 ops, the table half', () => table.crc32(line));
    await bench('crc32 — a log line of 64 ops, zlib’s', () => zlib.crc32(line));
  }
};

void main();
