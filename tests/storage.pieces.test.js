'use strict';

// A large block is written in pieces (src/entries.js, the text plugin's
// `pieces`): its runs in files of their own beside the record file, a
// keystroke writing one of them, a read assembling the block whole.

const test = require('node:test');
const assert = require('node:assert');
const { open } = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const S = require('../src/text/sequence.js');

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
  assert.strictEqual(body.parts.length, 32);
  const named = body.parts.filter((name) => name !== null);
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
  assert.ok(pieces.length >= 1 && pieces.length <= 2, `a keystroke writes one piece or two (${pieces})`);
  assert.ok(writes.includes(`${id}.json`));
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
