'use strict';

// A large block is written in pieces (src/entries.js, the text plugin's
// `pieces`): its runs in files of their own beside the record file, a
// keystroke writing one of them, a read assembling the block whole.

const test = require('node:test');
const assert = require('node:assert');
const { open } = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const S = require('../src/text/sequence.js');
const { SOURCE } = require('../src/symbols.js');

// A text of more than PIECES_MIN runs: inserts at scattered places.
const grow = async (storage, id, runs) => {
  await storage.splice(id, 'body', 0, 0, 'x'.repeat(200));
  let seed = 7;
  for (let i = 0; i < runs; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const length = (await storage.get(id)).body.length;
    await storage.splice(id, 'body', seed % length, 0, 'ab');
  }
};

const piecesOf = async (fsi, id) => (await fsi.list('/p/data')).filter((name) => name.startsWith(`${id}~`));

test('a large text is written in pieces: one a keystroke, the rest kept; read whole, copied whole', async () => {
  const fsi = memory();
  const options = { path: '/p', fsi, logger: false, defer: 0 };
  let storage = await open({ ...options });
  const id = await storage.insert({});
  await grow(storage, id, S.PIECES_MIN * 2);
  const file = JSON.parse(await fsi.read('/p/data', `${id}.json`));
  const body = file.meta.blocks.body;
  assert.strictEqual(body.runs, undefined, 'the runs are not in the record file');
  const named = body.parts.filter((name) => name !== null);
  assert.ok(named.length >= 2, 'the runs by their numbers, PIECE_RUNS a piece');
  for (const name of named) {
    const runs = Object.keys(JSON.parse(await fsi.read('/p/data', name))).length;
    assert.ok(runs > 0 && runs <= S.PIECE_RUNS, `a piece holds PIECE_RUNS runs at most (${runs})`);
  }
  assert.deepStrictEqual((await piecesOf(fsi, id)).sort(), [...named].sort(), 'the pieces on disk are the ones named');
  assert.ok(Number.isSafeInteger(file.gen) && file.gen >= named.length);
  // One keystroke: one piece written (and the record file), the old one gone.
  const writes = [];
  const write = fsi.write.bind(fsi);
  fsi.write = (dir, name, text, o) => {
    if (dir === '/p/data') writes.push(name);
    return write(dir, name, text, o);
  };
  const before = (await storage.get(id)).body;
  await storage.splice(id, 'body', 5, 0, 'Z');
  const pieces = writes.filter((name) => name.includes('~'));
  assert.strictEqual(pieces.length, 1, `a keystroke writes one piece (${pieces})`);
  assert.ok(writes.includes(`${id}.json`));
  const after = JSON.parse(await fsi.read('/p/data', `${id}.json`)).meta.blocks.body.parts;
  assert.deepStrictEqual(after.slice(0, -1), body.parts.slice(0, -1), 'the newest piece written, every other kept');
  assert.strictEqual((await piecesOf(fsi, id)).length, named.length, 'as many pieces as before: the old ones removed');
  fsi.write = write;
  // A tag keeps the record as it was, whole: its copy names no piece.
  await storage.tag('t1');
  await storage.splice(id, 'body', 0, 0, 'Y');
  const copied = (await fsi.list('/p/tags/t1/data')).filter((name) => name.endsWith('.json'));
  assert.deepStrictEqual(copied, [`${id}.json`]);
  assert.ok(!(await fsi.read('/p/tags/t1/data', `${id}.json`)).includes('"parts":'));
  const text = (await storage.get(id)).body;
  assert.strictEqual(text, `Y${before.slice(0, 5)}Z${before.slice(5)}`);
  assert.strictEqual((await storage.at('t1').get(id)).body, text.slice(1), 'the tag reads as it was');
  await storage.close();
  // Reopened: the block read whole from its pieces, the next edit as cheap.
  storage = await open({ ...options });
  assert.strictEqual((await storage.get(id)).body, text);
  await storage.splice(id, 'body', 0, 1, '');
  assert.strictEqual((await storage.get(id)).body, text.slice(1));
  // A rebuilt catalog takes the record files alone, never their pieces.
  assert.deepStrictEqual(await storage.list(), [id]);
  await storage.close();
  await fsi.remove('/p/index', 'catalog.json');
  storage = await open({ ...options });
  assert.deepStrictEqual(await storage.list(), [id]);
  await storage.close();
  // A piece gone: the record is unreadable, never read in part.
  const [gone] = await piecesOf(fsi, id);
  await fsi.remove('/p/data', gone);
  storage = await open({ ...options });
  await assert.rejects(() => storage.get(id), { code: 'INTEGRITY' });
  await storage.close();
});

test('a purge takes the pieces with the payload: no file of the record’s runs is left', async () => {
  const fsi = memory();
  const storage = await open({ path: '/p', fsi, logger: false, defer: 0 });
  const id = await storage.insert({});
  await grow(storage, id, S.PIECES_MIN * 2);
  assert.ok((await piecesOf(fsi, id)).length > 0);
  await storage.purge(id);
  assert.deepStrictEqual(await piecesOf(fsi, id), []);
  assert.ok(!(await fsi.read('/p/data', `${id}.json`)).includes('"parts":'));
  await storage.close();
});

// A text of `runs` runs typed at its start, one keystroke each, after `head` typed at once.
const prepended = async (storage, id, head, runs) => {
  await storage.splice(id, 'body', 0, 0, head);
  for (let i = 0; i < runs; i++) await storage.splice(id, 'body', 0, 0, 'x');
};

test('a text typed anywhere rewrites its newest piece alone, through a handle too: a run grows while it is new, an old one is left', async () => {
  const fsi = memory();
  const storage = await open({ path: '/p', fsi, logger: false, defer: 0 });
  const id = await storage.insert({});
  // `abc` the first run, then more than PIECE_RUNS runs before it.
  await prepended(storage, id, 'abc', S.PIECE_RUNS * 3);
  const ops = [];
  storage.on('change', (op) => ops.push(op.value));
  const writes = [];
  const write = fsi.write.bind(fsi);
  fsi.write = (dir, name, text, o) => {
    if (dir === '/p/data' && name.includes('~')) writes.push(name);
    return write(dir, name, text, o);
  };
  const length = (await storage.get(id)).body.length;
  // Typed on after `c`, the end of a run of this node's that is no longer new: a run of its own.
  await storage.splice(id, 'body', length, 0, 'd');
  assert.strictEqual(ops[0].run, undefined, 'the old run is not grown');
  assert.ok(typeof ops[0].at === 'string' && ops[0].at.startsWith('>'), 'a new run after its last element');
  // Typed on after `d`: the new run grows.
  await storage.splice(id, 'body', length + 1, 0, 'e');
  assert.strictEqual(typeof ops[1].run, 'number', 'a new run grows');
  // Typed between old runs, here and there: one piece a keystroke, the newest.
  let seed = 11;
  for (let i = 0; i < 40; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    await storage.splice(id, 'body', seed % length, 0, 'y');
  }
  assert.strictEqual(writes.length, 42, 'one piece a keystroke');
  assert.ok(new Set(writes).size === writes.length);
  // Through a handle, its keystrokes made before the window writes the block they follow: still the
  // newest piece alone, a flush each.
  const handle = await storage.openText(id, 'body', { window: 60_000 });
  writes.length = 0;
  for (let flush = 0; flush < 5; flush++) {
    for (let i = 0; i < 10; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      handle.insert(seed % length, 'h');
    }
    await handle.flush();
  }
  assert.strictEqual(writes.length, 5, `one piece a flush (${writes.length})`);
  await handle.close();
  const text = (await storage.get(id)).body;
  await storage.close();
  // Reopened under a window: the handle's keystrokes made ahead of the write of the block they follow.
  const reopened = await open({ path: '/p', fsi, logger: false, defer: 5 });
  assert.strictEqual((await reopened.get(id)).body, text, 'read back whole');
  const ahead = await reopened.openText(id, 'body', { window: 60_000 });
  const typed = () => {
    for (let i = 0; i < 10; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      ahead.insert(seed % length, 'w');
    }
  };
  const windowed = () => new Promise((resolve) => setTimeout(resolve, 40));
  typed();
  await ahead.flush();
  typed();
  await windowed();
  // The pieces each write of the record file came with.
  const windows = [];
  let pieces = 0;
  fsi.write = (dir, name, file, o) => {
    if (dir === '/p/data' && name.includes('~')) pieces++;
    else if (dir === '/p/data' && name === `${id}.json`) {
      windows.push(pieces);
      pieces = 0;
    }
    return write(dir, name, file, o);
  };
  for (let round = 0; round < 4; round++) {
    await ahead.flush();
    typed();
    await windowed();
  }
  assert.ok(windows.length > 0);
  assert.ok(
    windows.every((n) => n === 1),
    `the newest piece a window, though typed ahead of it (${windows})`,
  );
  fsi.write = write;
  await ahead.close();
  await reopened.close();
});

// A block as its runs, cuts, waiting work, registers and marks, the runs sorted: what two readings of one
// block share whatever order their runs were laid in.
const canonical = (block) => {
  const out = {};
  for (const key of Object.keys(block).sort()) if (key !== 'parts') out[key] = block[key];
  const runs = {};
  for (const key of Object.keys(block.runs).sort()) runs[key] = block.runs[key];
  out.runs = runs;
  return JSON.stringify(out);
};
// The block the storage holds now — its cached entry's, not its file's.
const blockOf = async (storage, id) => (await storage[SOURCE].entry(id)).meta.blocks.body;
// The block as the files hold it, read here and not by the storage — no log laid over it.
const onDisk = async (fsi, dir, id) => {
  const block = JSON.parse(await fsi.read(dir, `${id}.json`)).meta.blocks.body;
  if (block.parts === undefined) return block;
  const runs = {};
  for (const name of block.parts) if (name !== null) Object.assign(runs, JSON.parse(await fsi.read(dir, name)));
  return { ...block, runs };
};

test('a text in pieces is on disk as it was written after any edit: inserts, cuts, marks, embeds, typed backward', async () => {
  for (const defer of [0, 16]) {
    const fsi = memory();
    const options = { path: '/f', fsi, logger: false, defer };
    let storage = await open(options);
    const id = await storage.insert({});
    await prepended(storage, id, 'start', S.PIECES_MIN + 50);
    let seed = 3 + defer;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const same = async (label) => {
      await storage.flush();
      const disk = await onDisk(fsi, '/f/data', id);
      assert.strictEqual(S.render(S.buildIndex(disk)), (await storage.get(id)).body, `${label}: the text`);
      assert.strictEqual(canonical(disk), canonical(await blockOf(storage, id)), `${label}: the block`);
    };
    for (let round = 0; round < 6; round++) {
      const handle = await storage.openText(id, 'body', { window: 0 });
      for (let i = 0; i < 300; i++) {
        const length = handle.length;
        const at = Math.floor(random() * (length + 1));
        const roll = random();
        if (roll < 0.35) handle.insert(at, 'abc'.slice(0, 1 + Math.floor(random() * 3)));
        else if (roll < 0.5) handle.insert(Math.min(at, length), 'q');
        else if (roll < 0.6) for (let k = 0; k < 4; k++) handle.insert(at, String(k));
        else if (roll < 0.75 && length > 10) handle.delete(Math.min(at, length - 5), 1 + Math.floor(random() * 4));
        else if (roll < 0.85 && length > 10) {
          handle.format(Math.min(at, length - 6), 5, { bold: random() < 0.7 ? true : null });
        } else if (roll < 0.9) handle.insertEmbed(at, { type: 'image', attrs: { n: i } });
        else {
          await handle.flush();
          await same(`round ${round}, edit ${i}, defer ${defer}`);
        }
      }
      await handle.close();
      // Typed through the storage too, between the handle's rounds: its own runs, its own cuts.
      const text = (await storage.get(id)).body;
      const at = Math.floor(random() * text.length);
      await storage.splice(id, 'body', at, 0, 'S');
      await same(`round ${round}, defer ${defer}, a run`);
      // Typed on: the run grown, alone in its window.
      await storage.splice(id, 'body', at + 1, 0, 'T');
      await same(`round ${round}, defer ${defer}, the run grown`);
      await storage.splice(id, 'body', 0, 2, '');
      await same(`round ${round}, defer ${defer}`);
      const after = (await storage.get(id)).body;
      await storage.close();
      storage = await open(options);
      assert.strictEqual((await storage.get(id)).body, after, `round ${round}, defer ${defer}: read back`);
    }
    await storage.close();
  }
});
