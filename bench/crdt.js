/**
 * `diff` / `merge` / `apply` — the pure-JS core of syncom's replication. Every
 * `Record.save()` produces a delta through `diff`, every inbound update lands
 * through `merge`, and a replaying peer walks its whole history through
 * `apply`. None of them touch the filesystem or crypto, so this file is the
 * one place where a change to src/crdt.js shows up as a number instead of
 * being hidden behind I/O.
 *
 * The nested rows matter most: `diff` and `merge` recurse per key, so cost
 * grows with shape, not with byte count.
 *
 * Run with `node bench/crdt.js` or `pnpm bench`.
 */

'use strict';

const { bench } = require('./support/harness.js');
const { diff, merge, apply } = require('../src/crdt.js');

const flat = (n, offset = 0) => {
  const object = {};
  for (let i = 0; i < n; i++) object[`k${i}`] = i + offset;
  return object;
};

const nested = (depth, width) => {
  if (depth === 0) return flat(width);
  const object = {};
  for (let i = 0; i < width; i++) object[`k${i}`] = nested(depth - 1, width);
  return object;
};

const main = async () => {
  console.log(`CRDT benchmark — Node ${process.version}\n`);

  {
    const source = flat(20);
    const target = flat(20, 1);
    await bench('diff — 20 flat keys, all changed', () => diff(source, target));
  }
  {
    const source = flat(20);
    const target = { ...source, k0: 999 };
    await bench('diff — 20 flat keys, one changed', () => diff(source, target));
  }
  {
    const source = nested(3, 4);
    const target = nested(3, 4);
    target.k0.k0.k0.k0 = 999;
    await bench('diff — depth 3, width 4', () => diff(source, target));
  }
  {
    const source = { tags: ['a', 'b', 'c'] };
    const target = { tags: ['c', 'd', 'e'] };
    await bench('diff — array as a grow-only set', () => diff(source, target));
  }

  {
    const source = flat(20);
    const delta = flat(20, 1);
    await bench('merge — 20 flat keys', () => merge(source, delta));
  }
  {
    const source = nested(3, 4);
    const delta = { k0: { k0: { k0: { k0: 1 } } } };
    await bench('merge — depth 3, width 4', () => merge(source, delta));
  }
  {
    const source = { hits: 10 };
    const delta = { hits: 1 };
    // Numbers merge by addition — the counter CRDT, and the hottest single case.
    await bench('merge — numeric counter increment', () => merge(source, delta));
  }

  {
    const history = [];
    for (let i = 0; i < 100; i++) history.push({ type: 'inc', key: 'hits', value: 1 });
    const source = { hits: 0 };
    await bench('apply — 100 inc records', () => apply(source, history));
  }
  {
    const history = [];
    for (let i = 0; i < 100; i++) history.push({ type: 'delta', data: { [`k${i}`]: i } });
    const source = {};
    await bench('apply — 100 delta records', () => apply(source, history));
  }
};

void main();
