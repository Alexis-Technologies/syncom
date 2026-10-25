/**
 * The wire: what one keystroke weighs as the op every peer receives — packed
 * (src/ops.js packOps, 17 slots) with and without a signature — and as the
 * line the op log keeps. Bytes, not ops/s: the rows go to
 * bench/results/wire.json under `pnpm bench --save`, next to engine.json.
 *
 * Run with `node bench/wire.js` or `pnpm bench`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { packOps } = require('../src/ops.js');
const { generateSigningKeys } = require('../src/crypto.js');
const { signOp } = require('../src/signing.js');
const { runKey } = require('../src/text/sequence.js');

const OUT = path.join(__dirname, 'results', 'wire.json');

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

const main = async () => {
  console.log(`Wire benchmark — Node ${process.version}\n`);
  const keys = await generateSigningKeys();
  const id = 'd2f0c6a8-3b1e-4f7a-9c2d-5e6f7a8b9c0d';
  // The common keystroke: one character extending the writer's own run.
  const keystroke = {
    origin: keys.id,
    seq: 1234,
    ts: Date.now(),
    type: 'splice',
    id,
    key: 'body',
    value: { run: runKey(Date.now() - 5000, keys.id), from: 4321, content: 'z' },
  };
  const unsigned = { ...keystroke };
  const signed = { ...keystroke };
  await signOp(signed, keys.privateKey);
  const rows = [
    { name: 'keystroke — packed, unsigned', bytes: bytes(packOps([unsigned])) },
    { name: 'keystroke — packed, signed', bytes: bytes(packOps([signed])) },
    { name: 'keystroke — log line, signed', bytes: bytes({ entries: [{ seq: 1234, op: signed }] }) },
    {
      name: 'keystroke — page of 500, signed (per op)',
      bytes: Math.round(bytes(packOps(Array(500).fill(signed))) / 500),
    },
  ];
  for (const row of rows) console.log(`${row.name.padEnd(60)} ${String(row.bytes).padStart(8)} B`);
  if (process.env.SYNCOM_BENCH_OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2)}\n`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
