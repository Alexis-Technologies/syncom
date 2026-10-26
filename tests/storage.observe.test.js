'use strict';

// observe(): one record's changes a turn at a time (EVT-2); the text
// plugin's deltas (toDelta / applyDelta) and cursor positions.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { compose, spansToDelta } = require('../src/editor/editor.js');
const { openGroups } = require('./utils/groups.js');

const open = async (t, options = {}) => {
  const storage = await syncom.open({ path: '/o', fsi: memory(), logger: false, ...options });
  t.after(() => storage.close().catch(() => {}));
  return storage;
};

// Quill's form applied to a string: what a delta promises.
const applyQuill = (text, delta) => {
  let at = 0;
  let out = text;
  for (const op of delta) {
    if (op.delete !== undefined) out = out.slice(0, at) + out.slice(at + op.delete);
    else if (op.retain !== undefined) at += op.retain;
    else {
      const inserted = typeof op.insert === 'string' ? op.insert : '￼';
      out = out.slice(0, at) + inserted + out.slice(at);
      at += inserted.length;
    }
  }
  return out;
};

test('observe and deltas', async (t) => {
  await t.test(
    'observe() hands a record’s changes a turn at a time, under a path or whole, local and a peer’s, until stopped',
    async (t2) => {
      const storage = await open(t2, { defer: 0 });
      const peer = await syncom.open({ path: '/p', fsi: memory(), logger: false, defer: 0 });
      t2.after(() => peer.close().catch(() => {}));
      const id = await storage.insert({ title: 'a', profile: { n: 1 } });
      const other = await storage.insert({ n: 0 });
      const whole = [];
      const city = [];
      const profile = [];
      const stop = storage.observe(id, (changes, event) =>
        whole.push([event.local, changes.map((c) => `${c.action}:${c.field ?? '-'}`)]),
      );
      storage.observe(id, 'profile/city', (changes) => city.push(changes.map((c) => `${c.action}:${c.field ?? '-'}`)));
      storage.observe(id, 'profile', (changes) => profile.push(changes.length));
      await storage.update(id, { 'profile/city': 'Kyiv' });
      await storage.update(id, { title: 'b' });
      await storage.update(other, { n: 1 });
      await storage.update(id, { profile: { n: 2 } });
      await storage.transact(async (tx) => {
        await tx.splice(id, 'body', 0, 0, 'hello');
        await tx.inc(id, 'hits', 1);
        await tx.update(other, { n: 2 });
      });
      assert.deepStrictEqual(whole, [
        [true, ['put:profile/city']],
        [true, ['put:title']],
        [true, ['put:profile', 'unset:profile/city']],
        [true, ['splice:body', 'inc:hits']],
      ]);
      assert.deepStrictEqual(
        city,
        [['put:profile/city'], ['put:profile', 'unset:profile/city']],
        'the path, and a reset above it',
      );
      assert.deepStrictEqual(profile, [1, 2], 'a child, and the prefix itself');
      // A peer's page: observed like a local turn, `local` false.
      const theirs = await peer.insert({ x: 1 });
      await peer.update(theirs, { x: 2 });
      const seen = [];
      storage.observe(theirs, 'x', (changes, event) =>
        seen.push([event.local, event.via === null, changes.map((c) => c.action)]),
      );
      await storage.applyRemote(peer.log.since(null).map((entry) => entry.op));
      assert.deepStrictEqual(seen, [[false, true, ['put', 'put']]]);
      // Stopped: nothing more; the others go on. A delete reaches every observer of the record.
      stop();
      const deleted = [];
      storage.observe(id, 'title', (changes) => deleted.push(changes.map((c) => c.action)));
      await storage.update(id, { title: 'c' });
      await storage.delete(id);
      assert.strictEqual(whole.length, 4, 'stopped');
      assert.deepStrictEqual(deleted, [['put'], ['delete']]);
      assert.deepStrictEqual(city.at(-1), ['delete:-']);
      // Through a Record; a listener that throws is contained.
      const record = await storage.record(other);
      const mine = [];
      const off = record.observe('n', (changes) => mine.push(changes[0].value));
      storage.observe(other, () => {
        throw new Error('contained');
      });
      await storage.update(other, { n: 3 });
      off();
      await storage.update(other, { n: 4 });
      assert.deepStrictEqual(mine, [3]);
      assert.deepStrictEqual(await storage.get(other), { n: 4 });
      // Arguments.
      assert.throws(() => storage.observe('bad id!', () => {}), { code: 'INVALID_ID' });
      assert.throws(() => storage.observe(other, 'n', 'x'), TypeError);
      assert.throws(() => storage.observe(other, 7, () => {}), TypeError);
      assert.throws(() => storage.observe(other), TypeError);
    },
  );

  await t.test(
    'a cut of a run that a peer inserted inside reads as one splice per stretch, and its delta gives the reading after',
    async (t2) => {
      const a = await open(t2, { defer: 0 });
      const b = await syncom.open({ path: '/b', fsi: memory(), logger: false, defer: 0 });
      t2.after(() => b.close().catch(() => {}));
      const exchange = async (from, to) => {
        await to.applyRemote(from.log.since(null).map((entry) => entry.op));
      };
      const id = await a.insert({});
      await a.splice(id, 'body', 0, 0, 'abcd'); // one run of a's
      await exchange(a, b);
      // b types inside a's run; a, not having seen it, cuts `bc` out of its run: [run, 1, 2].
      await b.splice(id, 'body', 2, 0, 'X');
      await a.splice(id, 'body', 1, 2);
      const before = (await b.get(id)).body;
      let turn = null;
      b.on('transaction', (event) => (turn = event));
      await exchange(a, b);
      const after = (await b.get(id)).body;
      assert.deepStrictEqual([before, after], ['abXcd', 'aXd']);
      assert.deepStrictEqual(
        turn.changes.map(({ action, index, count }) => [action, index, count]),
        [
          ['splice', 3, 1],
          ['splice', 1, 1],
        ],
        'the stretch after X, then the one before: the indices before the op, last first',
      );
      assert.strictEqual(applyQuill(before, b.toDelta(turn.changes, 'body')), after);
    },
  );

  await t.test(
    'toDelta() composes a turn’s changes into Quill’s form; applyDelta() makes a delta the field’s edits as one transaction',
    async (t2) => {
      const storage = await open(t2, { defer: 0 });
      const id = await storage.insert({});
      await storage.updateText(id, 'body', 'hello world');
      let turn = null;
      storage.on('transaction', (event) => (turn = event));
      const before = (await storage.get(id)).body;
      await storage.transact(async (tx) => {
        await tx.splice(id, 'body', 1, 2, 'EY');
        await tx.mark(id, 'body', 0, 3, 'bold', true);
        await tx.insertEmbed(id, 'body', 2, { type: 'img', attrs: { src: 'a' } });
        await tx.splice(id, 'body', 9, 0, '!');
        await tx.unmark(id, 'body', 0, 1, 'bold');
      });
      const delta = storage.toDelta(turn.changes, 'body');
      const img = { type: 'img', parents: [], attrs: { src: 'a' }, isEmbed: true };
      assert.deepStrictEqual(delta, [
        { retain: 1, attributes: { bold: null } },
        { delete: 2 },
        { insert: 'E', attributes: { bold: true } },
        { insert: { embed: img }, attributes: { bold: true } },
        { insert: 'Y', attributes: { bold: true } },
        { retain: 5 },
        { insert: '!' },
      ]);
      assert.strictEqual(applyQuill(before, delta), (await storage.get(id)).body);
      // Rich, not only the string: the reading before, composed with the delta, is the reading after —
      // the embed typed inside the bold range reads bold, and its insert says so.
      assert.deepStrictEqual(
        compose([], compose([{ insert: 'hello world' }], delta)),
        compose([], spansToDelta(await storage.spans(id, 'body'))),
      );
      assert.deepStrictEqual(storage.toDelta(turn.changes), delta, 'the one text field');
      assert.deepStrictEqual(storage.toDelta(turn.changes, 'other'), []);
      // A reset is no delta; a list's splice neither; arguments.
      assert.strictEqual(storage.toDelta([{ action: 'reset', field: 'body', kind: 'text', value: 'x' }]), null);
      assert.strictEqual(storage.toDelta([{ action: 'delete' }]), null);
      // Asked for one field: the record gone, or the field reset from above, is still no delta.
      assert.strictEqual(storage.toDelta([{ action: 'delete' }], 'body'), null);
      assert.strictEqual(storage.toDelta([{ action: 'purge' }], 'body'), null);
      assert.strictEqual(storage.toDelta([{ action: 'unset', field: 'doc' }], 'doc/body'), null);
      assert.deepStrictEqual(storage.toDelta([{ action: 'unset', field: 'docs' }], 'doc/body'), []);
      assert.strictEqual(
        storage.toDelta([{ action: 'splice', field: 'items', index: 0, count: 0, content: [1] }], 'items'),
        null,
      );
      assert.throws(() => storage.toDelta('x'), TypeError);
      // One retain over two slots sets the marker of each, as a delta composes two alike.
      const doc = await storage.insert({});
      await storage.splitBlock(doc, 'body', 0, { type: 'paragraph' });
      await storage.splitBlock(doc, 'body', 1, { type: 'paragraph' });
      const quote = { type: 'paragraph', parents: ['blockquote'], attrs: {}, isEmbed: false };
      assert.strictEqual(await storage.applyDelta(doc, 'body', [{ retain: 2, attributes: { embed: quote } }]), 2);
      assert.deepStrictEqual(
        (await storage.blocks(doc, 'body')).map((block) => block.parents),
        [['blockquote'], ['blockquote']],
      );
      // A slot inserted and its marker changed in one turn: the insert carries the marker it ends with
      // (it read as the marker it was inserted with, the change an `embed` mark on it, and an editor
      // bound to the field kept the old block).
      const nested = await storage.insert({});
      await storage.updateText(nested, 'body', 'ab');
      await storage.transact(async (tx) => {
        await tx.splitBlock(nested, 'body', 1, { type: 'paragraph' });
        await tx.mark(nested, 'body', 1, 2, 'em', true);
        await tx.updateBlock(nested, 'body', 1, { type: 'heading', attrs: { level: 2 } });
      });
      const heading = { type: 'heading', parents: [], attrs: { level: 2 }, isEmbed: false };
      assert.deepStrictEqual(storage.toDelta(turn.changes, 'body'), [
        { retain: 1 },
        { insert: { embed: heading }, attributes: { em: true } },
      ]);
      // Random edits: the composed delta of each turn takes the reading before it to the reading after,
      // markers and marks included.
      let seed = 11;
      const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
      for (let round = 0; round < 25; round++) {
        const was = (await storage.get(id)).body;
        const rich = await storage.spans(id, 'body');
        await storage.transact(async (tx) => {
          for (let i = 0; i < 1 + Math.floor(random() * 4); i++) {
            const length = (await tx.get(id)).body.length;
            const at = Math.floor(random() * (length + 1));
            const count = Math.floor(random() * Math.min(3, length - at + 1));
            const roll = random();
            if (roll < 0.5) await tx.splice(id, 'body', at, count, 'abc'.slice(0, 1 + Math.floor(random() * 3)));
            else if (roll < 0.7 && at < length) await tx.mark(id, 'body', at, at + 1, 'em', round);
            else if (roll < 0.8) await tx.insertEmbed(id, 'body', at, { type: 'x' });
            else if (roll < 0.9) {
              // A block started and, as often as not, changed in the same turn.
              await tx.splitBlock(id, 'body', at, { type: 'paragraph' });
              if (random() < 0.5) await tx.updateBlock(id, 'body', at, { type: 'heading', attrs: { level: round } });
            } else if (count > 0) await tx.splice(id, 'body', at, count);
          }
        });
        const composed = storage.toDelta(turn.changes, 'body');
        assert.strictEqual(applyQuill(was, composed), (await storage.get(id)).body, `round ${round}`);
        // A block marker's slot takes the marks of the range it is typed in; a reading of blocks leaves them out.
        const rich2 = (ops) =>
          compose([], ops).map(({ attributes, ...op }) =>
            op.insert?.embed?.isEmbed === false || attributes === undefined ? op : { ...op, attributes },
          );
        assert.deepStrictEqual(
          rich2(compose(spansToDelta(rich), composed)),
          rich2(spansToDelta(await storage.spans(id, 'body'))),
          `round ${round}: the rich reading`,
        );
      }
      // applyDelta: one transaction (one group file), marks and embeds included; a bad delta writes nothing.
      const other = await storage.insert({});
      const files = await openGroups(storage.fsi, '/o/log/open');
      const marker = { type: 'img', attrs: { src: 'b' } };
      const made = await storage.applyDelta(
        other,
        'body',
        [{ insert: 'Hi ' }, { insert: 'there', attributes: { bold: true } }, { insert: { embed: marker } }],
        { message: 'typed' },
      );
      assert.strictEqual(made, 4);
      assert.strictEqual((await openGroups(storage.fsi, '/o/log/open')) - files, 1, 'one group');
      assert.deepStrictEqual(await storage.spans(other, 'body'), [
        { type: 'text', text: 'Hi ', marks: {} },
        { type: 'text', text: 'there', marks: { bold: true } },
        { type: 'embed', value: { type: 'img', parents: [], attrs: { src: 'b' }, isEmbed: true }, marks: {} },
      ]);
      const { versions } = await storage.history(other);
      assert.deepStrictEqual(
        versions.map((version) => version.message),
        ['typed', 'typed', 'typed', 'typed', null],
        'the message on every op of the delta; the insert before it has none',
      );
      assert.strictEqual(
        await storage.applyDelta(other, 'body', [
          { retain: 3 },
          { retain: 5, attributes: { bold: null, em: 1 } },
          { delete: 1 },
          { insert: '' },
        ]),
        3,
      );
      assert.deepStrictEqual(await storage.spans(other, 'body'), [
        { type: 'text', text: 'Hi ', marks: {} },
        { type: 'text', text: 'there', marks: { em: 1 } },
      ]);
      await storage.applyDelta(other, 'body', [{ insert: { embed: { type: 'p', isEmbed: false } } }]);
      assert.deepStrictEqual(await storage.block(other, 'body', 0), {
        type: 'p',
        parents: [],
        attrs: {},
        isEmbed: false,
      });
      await storage.applyDelta(other, 'body', [{ retain: 1, attributes: { embed: { type: 'h1' } } }]);
      assert.deepStrictEqual(await storage.block(other, 'body', 0), {
        type: 'h1',
        parents: [],
        attrs: {},
        isEmbed: true,
      });
      const logged = storage.log.length;
      await assert.rejects(() => storage.applyDelta(other, 'body', [{ retain: 99 }, { delete: 1 }]), {
        code: 'OUT_OF_RANGE',
      });
      await assert.rejects(() => storage.applyDelta(other, 'body', [{ insert: '￼' }]), TypeError);
      await assert.rejects(() => storage.applyDelta(other, 'body', [{ nope: 1 }]), TypeError);
      await assert.rejects(() => storage.applyDelta(other, 'body', 'x'), TypeError);
      await assert.rejects(() => storage.applyDelta(other, 7, []), TypeError);
      assert.strictEqual(storage.log.length, logged, 'nothing written');
      // Positions: a cursor's index and side, several at once.
      const after = await storage.cursor(other, 'body', 2, { side: 'after' });
      const beforeCursor = await storage.cursor(other, 'body', 5);
      assert.deepStrictEqual(await storage.position(other, 'body', after), { index: 2, side: 'after' });
      await storage.splice(other, 'body', 0, 0, '>> ');
      assert.deepStrictEqual(await storage.positions(other, 'body', [after, beforeCursor, '^', '$']), [
        { index: 5, side: 'after' },
        { index: 8, side: 'before' },
        { index: 0, side: 'after' },
        { index: (await storage.get(other)).body.length, side: 'before' },
      ]);
      const record = await storage.record(other);
      assert.deepStrictEqual(await record.position('body', after), { index: 5, side: 'after' });
      assert.strictEqual(await storage.position(other, 'title', after), null);
      await storage.set(other, { title: 'reset' });
      assert.strictEqual(await storage.position(other, 'body', after), null);
      assert.deepStrictEqual(await storage.positions(other, 'body', [after]), [null]);
      await assert.rejects(() => storage.position(other, 'body', 'nope'), TypeError);
      await assert.rejects(() => storage.positions(other, 'body', 'nope'), TypeError);
    },
  );

  await t.test('observe() reads the same on disk', async (t2) => {
    const dir = await createTemp();
    t2.after(() => cleanupTemp(dir));
    const storage = await syncom.open({ path: dir, logger: false });
    t2.after(() => storage.close().catch(() => {}));
    const id = await storage.insert({ n: 1 });
    const seen = [];
    storage.observe(id, 'n', (changes) => seen.push(changes[0].value));
    await storage.update(id, { n: 2 });
    await storage.flush();
    assert.deepStrictEqual(seen, [2]);
  });
});

test('a live Record lays a write’s fields over what it holds: it reads as get() after every op of a seeded walk', async () => {
  const { memory } = require('../src/memory/memory.js');
  const syncomAll = require('../src/all/all.js');
  const { Reference } = require('../src/record.js');
  const storage = await syncomAll.open({ fsi: memory(), lock: false, defer: 0, logger: false });
  const other = await storage.insert({ name: 'other' });
  const id = await storage.insert({ title: 'a', n: 1 });
  const record = await storage.record(id);
  let seed = 11;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const fields = ['title', 'n', 'tags', 'body', 'link', 'list'];
  for (let step = 0; step < 300; step++) {
    const field = fields[Math.floor(random() * fields.length)];
    const roll = random();
    try {
      if (field === 'n') await (roll < 0.5 ? storage.inc(id, 'n', 1) : storage.update(id, { n: step }));
      else if (field === 'tags') {
        const tag = [`t${step % 5}`];
        await (roll < 0.5 ? storage.add(id, 'tags', tag) : storage.remove(id, 'tags', tag));
      } else if (field === 'body') await storage.push(id, 'body', 'x');
      else if (field === 'list') await storage.push(id, 'list', [{ step }]);
      else if (field === 'link') await storage.update(id, { link: roll < 0.5 ? other : 'nobody' });
      else if (roll < 0.2) await storage.unset(id, [field]);
      else await storage.update(id, { [field]: { nested: { step } } });
    } catch (error) {
      // A field of another kind now (an unset counter written as a register…): the walk goes on.
      if (error.code !== 'FIELD_KIND') throw error;
    }
    const held = await record.data();
    const read = await storage.get(id);
    const plain = JSON.parse(JSON.stringify(held, (key, value) => (value instanceof Reference ? 'ref' : value)));
    for (const key of Object.keys(read)) {
      if (key === 'link' && read.link === other) assert.ok(held.link instanceof Reference, `step ${step}`);
      else assert.deepStrictEqual(plain[key], read[key], `step ${step}: ${key}`);
    }
    for (const key of Object.keys(plain)) assert.ok(Object.hasOwn(read, key), `step ${step}: ${key} lingers`);
  }
  await storage.close();
});
