'use strict';

// The inspector (src/inspect/inspect.js): a record's anatomy, raw, and an
// anonymized copy that keeps the shape and loses the words.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const { inspect, anonymize } = require('../src/inspect/inspect.js');

test('inspect() lays a record out by field and kind with its log; anonymize() keeps the shape and hashes every string', async (t) => {
  const storage = await syncom.open({ path: '/i', fsi: memory(), logger: false, defer: 0 });
  t.after(() => storage.close().catch(() => {}));
  const id = await storage.insert({ title: 'a', n: 1, profile: { city: 'Kyiv' } });
  await storage.inc(id, 'hits', 2);
  await storage.add(id, 'tags', ['x', 'y']);
  await storage.remove(id, 'tags', ['x']);
  await storage.splice(id, 'body', 0, 0, 'hello');
  await storage.mark(id, 'body', 0, 2, 'bold', true);
  await storage.push(id, 'items', [1, 2]);
  await storage.treeMove(id, 'outline', 'r');
  const [first] = await storage.elements(id, 'items');
  await storage.update(id, { [`items/${first}/note`]: 'n' });
  await storage.splice(id, 'items', 0, 1);
  const report = await inspect(storage, id);
  assert.deepStrictEqual([report.id, report.present, report.encrypted, report.alive], [id, true, false, true]);
  assert.deepStrictEqual(report.reading, {
    title: 'a',
    n: 1,
    profile: { city: 'Kyiv' },
    hits: 2,
    tags: ['y'],
    body: 'hello',
    items: [2],
    outline: [{ id: 'r', children: [] }],
  });
  assert.deepStrictEqual(Object.keys(report.data).sort(), [
    'body',
    'hits',
    'items',
    `items/${first}/note`,
    'n',
    'outline',
    'profile',
    'tags',
    'title',
  ]);
  const byField = Object.fromEntries(report.fields.map((field) => [field.field, field]));
  assert.deepStrictEqual(
    report.fields.map((field) => [field.field, field.kind, field.reachable]),
    [
      ['body', 'text', true],
      ['hits', 'counter', true],
      ['items', 'list', true],
      [`items/${first}/note`, 'register', false],
      ['n', 'register', true],
      ['outline', 'tree', true],
      ['profile', 'register', true],
      ['tags', 'set', true],
      ['title', 'register', true],
    ],
  );
  assert.deepStrictEqual(byField.title.stamp[1], storage.nodeId);
  assert.deepStrictEqual(Object.keys(byField.hits.sums), [storage.nodeId]);
  assert.deepStrictEqual([byField.tags.elements, byField.tags.live], [2, 1]);
  assert.deepStrictEqual([byField.body.k, byField.body.runs, byField.body.marks], ['t', 1, 1]);
  assert.deepStrictEqual(
    [byField.items.k, byField.items.runs, byField.items.cuts],
    ['l', 1, undefined],
    'a cut of an own run lands in the run',
  );
  assert.deepStrictEqual([byField.outline.nodes, byField.outline.moves], [1, 1]);
  assert.deepStrictEqual([report.base?.[1], report.deleted, report.purged], [storage.nodeId, null, null]);
  // The log: every retained entry of the record, by seq.
  assert.deepStrictEqual(
    report.log.map((entry) => entry.type),
    ['write', 'inc', 'add', 'remove', 'splice', 'mark', 'splice', 'tree', 'set', 'splice'],
  );
  assert.deepStrictEqual(
    report.log.map((entry) => entry.seq),
    report.log.map((entry) => entry.seq).sort((a, b) => a - b),
  );
  assert.ok(report.log.every((entry) => entry.origin === storage.nodeId && entry.signed && !entry.skipped));
  assert.strictEqual(report.log[1].field, 'hits');
  assert.strictEqual(report.log[0].eventId, storage.log.formatId(report.log[0].seq));
  // A deleted record, an absent one, an encrypted one.
  await storage.delete(id);
  const gone = await inspect(storage, id);
  assert.deepStrictEqual([gone.present, gone.alive, gone.reading, gone.fields.length], [true, false, null, 0]);
  assert.strictEqual(gone.log.at(-1).type, 'delete');
  const absent = await inspect(storage, 'absent');
  assert.deepStrictEqual([absent.present, absent.data, absent.fields, absent.log], [false, null, [], []]);
  const sealed = await storage.insert({ secret: 1 }, { encrypted: true });
  const hidden = await inspect(storage, sealed);
  assert.deepStrictEqual([hidden.encrypted, hidden.alive, hidden.data, hidden.log], [true, true, { secret: 1 }, []]);
  await assert.rejects(() => inspect(storage, 'bad id!'), { code: 'INVALID_ID' });
  await assert.rejects(() => inspect({}, id), TypeError);
  // anonymize: the shape stays, every string is a stable hash, keys when asked, nothing else touched.
  const page = await storage.snapshot();
  const copy = anonymize(page, { salt: 'bug-42' });
  assert.strictEqual(copy.records.length, page.records.length);
  assert.notStrictEqual(copy.records[0].id, page.records[0].id);
  assert.match(copy.records[0].id, /^~[0-9a-f]{8}$/);
  assert.strictEqual(copy.records[0].id, anonymize(page.records[0].id, { salt: 'bug-42' }), 'stable under one salt');
  assert.notStrictEqual(copy.records[0].id, anonymize(page.records[0].id, { salt: 'other' }));
  assert.strictEqual(JSON.stringify(copy).includes('Kyiv'), false);
  assert.deepStrictEqual(anonymize({ n: 1, ok: true, nothing: null, list: [1, 'x'] }), {
    n: 1,
    ok: true,
    nothing: null,
    list: [1, anonymize('x')],
  });
  const keyed = anonymize({ title: 'a' }, { keys: true });
  assert.deepStrictEqual(Object.keys(keyed), [anonymize('title')]);
  assert.throws(() => anonymize({ f: () => 1 }), TypeError);
  assert.throws(() => anonymize('x', { salt: 7 }), TypeError);
});
