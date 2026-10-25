'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const { directoryExists } = require('../src/utils.js');
const syncom = require('../src/all/all.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');

const mockSchema = {
  entities: {
    Post: { fields: { title: 'string', content: 'string', author: 'Author' } },
    Author: { fields: { name: 'string', email: 'string' } },
    Comment: { fields: { text: 'string', post: 'Post', author: 'Author' } },
  },
};

test('Storage module', async (t) => {
  await t.test('Storage constructor and initialization', async () => {
    const tempDir = await createTemp();
    try {
      const storage = await syncom.open({ path: tempDir });

      assert.ok(storage instanceof syncom.Storage);
      assert.strictEqual(await directoryExists(tempDir), true);
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('Storage saveData and loadData without encryption', async () => {
    const tempDir = await createTemp();
    try {
      const storage = await syncom.open({ path: tempDir });

      const testData = { message: 'Hello, Storage!', number: 123 };
      await storage.saveData('test-1', testData);

      const loadedData = await storage.loadData('test-1');
      assert.deepStrictEqual(loadedData, testData);
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('Storage saveData and loadData with encryption', async () => {
    const tempDir = await createTemp();
    try {
      const storage = await syncom.open({ path: tempDir });

      const testData = { secret: 'encrypted data', value: 456 };
      await storage.saveData('test-2', testData, { encrypted: true });

      const loadedData = await storage.loadData('test-2');
      assert.deepStrictEqual(loadedData, testData);
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('Storage loadData with non-existent data', async () => {
    const tempDir = await createTemp();
    try {
      const storage = await syncom.open({ path: tempDir });

      const result = await storage.loadData('nonexistent');
      assert.strictEqual(result, null);
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('Storage validate method', async () => {
    const tempDir = await createTemp();
    try {
      const storage = await syncom.open({ path: tempDir });

      const testData = { message: 'Test validation' };
      await storage.saveData('test-3', testData);

      const filePath = path.join(tempDir, 'data', 'test-3.json');
      const raw = await fs.readFile(filePath, { encoding: 'utf8' });
      const entry = JSON.parse(raw);

      const isValid = await storage.validate('test-3', entry.data, entry.block);
      assert.strictEqual(isValid, true);

      const isInvalid = await storage.validate('test-3', { modified: 'data' }, entry.block);
      assert.strictEqual(isInvalid, false);

      const chainOk = await storage.validate({ last: 2 });
      assert.strictEqual(await storage.validate(), true);
      assert.strictEqual(await storage.validate({}), true);
      assert.strictEqual(chainOk, true);
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('Storage loadData throws if tampered', async () => {
    const tempDir = await createTemp();
    try {
      const storage = await syncom.open({ path: tempDir });
      await storage.saveData('tampered', { ok: true });

      const filePath = path.join(tempDir, 'data', 'tampered.json');
      const entry = JSON.parse(await fs.readFile(filePath, 'utf8'));
      entry.data = { ok: false };
      await fs.writeFile(filePath, JSON.stringify(entry), 'utf8');
      await storage.close();

      // Quiet: the reopen's log replay notices the damage and warns.
      const storage2 = await syncom.open({ path: tempDir, logger: false });
      await assert.rejects(() => storage2.loadData('tampered'), /invalid/);
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('Storage insert set swap and update errors', async () => {
    const tempDir = await createTemp();
    try {
      const storage = await syncom.open({ path: tempDir });

      const id = await storage.insert({ n: 1 });
      assert.strictEqual(typeof id, 'string');
      assert.deepStrictEqual(await storage.get(id), { n: 1 });

      await storage.set(id, { n: 2, v: 0 });
      assert.deepStrictEqual(await storage.get(id), { n: 2, v: 0 });

      const swapped = await storage.swap(id, { v: 1 }, { n: 2 });
      assert.strictEqual(swapped, true);
      assert.deepStrictEqual(await storage.get(id), { n: 2, v: 1 });

      const notSwapped = await storage.swap(id, { v: 9 }, { n: 999 });
      assert.strictEqual(notSwapped, false);

      await assert.rejects(() => storage.update('missing-id', { x: 1 }), { code: 'NOT_FOUND', message: /not found/ });
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('Storage with schema creates collections', async () => {
    const tempDir = await createTemp();
    try {
      const options = { path: tempDir, schema: mockSchema };
      const storage = await syncom.open(options);

      assert.strictEqual(storage.schema, mockSchema);
      assert.ok(storage.Post instanceof syncom.Storage.Collection);
      assert.ok(storage.Author instanceof syncom.Storage.Collection);
      assert.ok(storage.Comment instanceof syncom.Storage.Collection);
      assert.strictEqual(storage.Post.name, 'Post');
      assert.strictEqual(storage.Author.name, 'Author');
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('Storage with Map-based schema entities', async () => {
    const tempDir = await createTemp();
    try {
      const mapSchema = {
        entities: new Map([
          ['User', { fields: { name: 'string', email: 'string' } }],
          ['Article', { fields: { title: 'string', body: 'string' } }],
        ]),
      };
      const options = { path: tempDir, schema: mapSchema };
      const storage = await syncom.open(options);

      assert.ok(storage.User instanceof syncom.Storage.Collection);
      assert.ok(storage.Article instanceof syncom.Storage.Collection);
      assert.strictEqual(storage.User.name, 'User');
      assert.strictEqual(storage.Article.name, 'Article');

      const userData = { name: 'Test', email: 'a@b.com' };
      const user = await storage.User.insert(userData);
      assert.ok(user.id);
      assert.strictEqual(user.name, 'Test');
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('Storage without schema has no collections', async () => {
    const tempDir = await createTemp();
    try {
      const storage = await syncom.open({ path: tempDir });

      assert.strictEqual(storage.schema, null);
      assert.strictEqual(storage.Post, undefined);
      assert.strictEqual(storage.Author, undefined);
    } finally {
      await cleanupTemp(tempDir);
    }
  });
});

test('Collection module', async (t) => {
  await t.test('Collection insert returns a Record', async () => {
    const tempDir = await createTemp();
    try {
      const options = { path: tempDir, schema: mockSchema };
      const storage = await syncom.open(options);

      const authorData = { name: 'John', email: 'john@example.com' };
      const authorRecord = await storage.Author.insert(authorData);

      assert.ok(authorRecord instanceof syncom.Storage.Record);
      assert.ok(authorRecord.id);
      assert.strictEqual(authorRecord.name, 'John');
      assert.strictEqual(authorRecord.email, 'john@example.com');
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('Collection insert adds $type to data', async () => {
    const tempDir = await createTemp();
    try {
      const options = { path: tempDir, schema: mockSchema };
      const storage = await syncom.open(options);

      const postData = { title: 'Hello', content: 'World' };
      const postRecord = await storage.Post.insert(postData);

      const rawData = await storage.get(postRecord.id);
      assert.strictEqual(rawData.$type, 'Post');
      assert.strictEqual(rawData.title, 'Hello');
      assert.strictEqual(rawData.content, 'World');
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('Collection get retrieves data', async () => {
    const tempDir = await createTemp();
    try {
      const options = { path: tempDir, schema: mockSchema };
      const storage = await syncom.open(options);

      const authorRecord = await storage.Author.insert({
        name: 'Jane',
        email: 'jane@example.com',
      });

      const data = await storage.Author.get(authorRecord.id);
      assert.strictEqual(data.name, 'Jane');
      assert.strictEqual(data.email, 'jane@example.com');
      assert.strictEqual(data.$type, 'Author');
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('Collection update modifies data', async () => {
    const tempDir = await createTemp();
    try {
      const options = { path: tempDir, schema: mockSchema };
      const storage = await syncom.open(options);

      const postRecord = await storage.Post.insert({
        title: 'Original',
        content: 'Content',
      });

      await storage.Post.update(postRecord.id, { title: 'Updated' });

      const data = await storage.Post.get(postRecord.id);
      assert.strictEqual(data.title, 'Updated');
      assert.strictEqual(data.content, 'Content');
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('Collection delete removes data', async () => {
    const tempDir = await createTemp();
    try {
      const options = { path: tempDir, schema: mockSchema };
      const storage = await syncom.open(options);

      const commentRecord = await storage.Comment.insert({
        text: 'Nice post!',
      });
      const id = commentRecord.id;

      const existsBefore = await storage.has(id);
      assert.strictEqual(existsBefore, true);

      await storage.Comment.delete(id);

      const existsAfter = await storage.has(id);
      assert.strictEqual(existsAfter, false);
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('Collection record returns a Record instance', async () => {
    const tempDir = await createTemp();
    try {
      const options = { path: tempDir, schema: mockSchema };
      const storage = await syncom.open(options);

      const authorRecord = await storage.Author.insert({
        name: 'Bob',
        email: 'bob@example.com',
      });
      const id = authorRecord.id;

      const record = await storage.Author.record(id);
      assert.ok(record instanceof syncom.Storage.Record);
      assert.strictEqual(record.id, id);
      assert.strictEqual(record.name, 'Bob');
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('Multiple collections work independently', async () => {
    const tempDir = await createTemp();
    try {
      const options = { path: tempDir, schema: mockSchema };
      const storage = await syncom.open(options);

      const author = await storage.Author.insert({
        name: 'Alice',
        email: 'alice@example.com',
      });

      const post = await storage.Post.insert({
        title: 'My Post',
        content: 'Post content',
        author: author.id,
      });

      const comment = await storage.Comment.insert({
        text: 'Great post!',
        post: post.id,
        author: author.id,
      });

      const authorData = await storage.Author.get(author.id);
      const postData = await storage.Post.get(post.id);
      const commentData = await storage.Comment.get(comment.id);

      assert.strictEqual(authorData.$type, 'Author');
      assert.strictEqual(postData.$type, 'Post');
      assert.strictEqual(commentData.$type, 'Comment');
      assert.strictEqual(postData.author, author.id);
      assert.strictEqual(commentData.post, post.id);
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('Record save persists mutations', async () => {
    const tempDir = await createTemp();
    try {
      const options = { path: tempDir, schema: mockSchema };
      const storage = await syncom.open(options);

      const post = await storage.Post.insert({
        title: 'Draft',
        content: 'Body',
      });
      post.title = 'Published';
      await post.save();

      const loaded = await storage.Post.get(post.id);
      assert.strictEqual(loaded.title, 'Published');
    } finally {
      await cleanupTemp(tempDir);
    }
  });
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('Storage id generation', async (t) => {
  await t.test('Storage.generateId returns unique UUIDs', () => {
    const id = syncom.Storage.generateId();
    assert.match(id, UUID);
    assert.notStrictEqual(id, syncom.Storage.generateId());
  });

  await t.test('custom getId is used once per insert', async () => {
    const tempDir = await createTemp();
    try {
      let calls = 0;
      const getId = () => `custom-${++calls}`;
      const storage = await syncom.open({ path: tempDir, getId });

      assert.strictEqual(await storage.insert({ a: 1 }), 'custom-1');
      assert.strictEqual(await storage.insert({ a: 2 }), 'custom-2');
      assert.strictEqual(calls, 2);
      assert.deepStrictEqual(await storage.get('custom-1'), { a: 1 });
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('custom getId may be async', async () => {
    const tempDir = await createTemp();
    try {
      const getId = async () => 'async-id';
      const storage = await syncom.open({ path: tempDir, getId });

      const id = await storage.insert({ a: 1 });
      assert.strictEqual(id, 'async-id');
      assert.deepStrictEqual(await storage.get(id), { a: 1 });
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('custom getId reaches Collection insert', async () => {
    const tempDir = await createTemp();
    try {
      let calls = 0;
      const getId = () => `rec_${++calls}`;
      const options = { path: tempDir, schema: mockSchema, getId };
      const storage = await syncom.open(options);

      const author = await storage.Author.insert({ name: 'John' });
      assert.strictEqual(author.id, 'rec_1');

      const data = await storage.get(author.id);
      assert.strictEqual(data.$type, 'Author');
      assert.strictEqual(data.name, 'John');
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('a non-function getId is refused at open', async () => {
    const tempDir = await createTemp();
    try {
      await assert.rejects(async () => syncom.open({ path: tempDir, getId: 'nope' }), {
        name: 'TypeError',
        message: 'open({ getId }): getId must be a function',
      });
      const storage = await syncom.open({ path: tempDir });
      assert.match(await storage.insert({ a: 1 }), UUID);
    } finally {
      await cleanupTemp(tempDir);
    }
  });

  await t.test('non-UUID ids survive the whole record lifecycle', async () => {
    const tempDir = await createTemp();
    try {
      let calls = 0;
      const getId = () => `01ARZ3NDEKTSV4RRFFQ69G5FA${calls++}`;
      const storage = await syncom.open({ path: tempDir, getId });

      const id = await storage.insert({ title: 'Draft', hits: 0 });
      assert.deepStrictEqual(await storage.get(id), { title: 'Draft', hits: 0 });
      assert.strictEqual(await storage.has(id), true);

      await storage.update(id, { hits: 1 });
      assert.strictEqual(await storage.swap(id, { hits: 2 }, { hits: 1 }), true);

      const record = await storage.record(id);
      assert.strictEqual(record.id, id);
      assert.strictEqual(await storage.validate(), true);

      await storage.delete(id);
      assert.strictEqual(await storage.has(id), false);
    } finally {
      await cleanupTemp(tempDir);
    }
  });
});

test('Record: a field named like a method never shadows it', async (t) => {
  const tempDir = await createTemp();
  t.after(() => cleanupTemp(tempDir));
  const warnings = [];
  const logger = { warn: (entry) => warnings.push(entry), debug() {}, info() {}, error() {} };
  const storage = await syncom.open({ path: tempDir, logger });
  t.after(() => storage.close());
  const id = await storage.insert({ save: 'no', delete: 1, data: 'd', on: 'x', title: 'ok' });
  const record = await storage.record(id);
  assert.strictEqual(typeof record.save, 'function');
  assert.strictEqual(typeof record.delete, 'function');
  assert.strictEqual(typeof record.on, 'function');
  assert.strictEqual(record.title, 'ok');
  assert.deepStrictEqual(await record.data(), { save: 'no', delete: 1, data: 'd', on: 'x', title: 'ok' });
  record.title = 'changed';
  await record.save();
  assert.deepStrictEqual(await storage.get(id), { save: 'no', delete: 1, data: 'd', on: 'x', title: 'changed' });
  const shadowed = warnings.filter((entry) => entry.event === 'record.shadowed').map((entry) => entry.key);
  assert.deepStrictEqual(shadowed.sort(), ['data', 'delete', 'on', 'save'], 'reported once per field');
});

test('validate(id, data, block) checks the block is the one it is filed under', async (t) => {
  const tempDir = await createTemp();
  t.after(() => cleanupTemp(tempDir));
  const storage = await syncom.open({ path: tempDir, logger: false });
  t.after(() => storage.close());
  const id = await storage.insert({ n: 1 });
  const stored = JSON.parse(await storage.fsi.read(`${tempDir}/data`, `${id}.json`));
  assert.strictEqual(await storage.validate(id, stored.data, stored.block), true);
  // A block file planted under another name, with the right hash inside it.
  const block = JSON.parse(await storage.fsi.read(`${tempDir}/blockchain`, `${stored.block}.json`));
  const planted = 'f'.repeat(64);
  await storage.fsi.write(`${tempDir}/blockchain`, `${planted}.json`, JSON.stringify(block));
  assert.strictEqual(await storage.validate(id, stored.data, planted), false);
});

test('the private key is written owner-only where the backend has permissions', async (t) => {
  const fsp = require('node:fs/promises');
  const nodePath = require('node:path');
  const tempDir = await createTemp();
  t.after(() => cleanupTemp(tempDir));
  const storage = await syncom.open({ path: tempDir, logger: false });
  await storage.close();
  const { mode } = await fsp.stat(nodePath.join(tempDir, 'keys', 'private.pem'));
  if (process.platform !== 'win32') assert.strictEqual(mode & 0o777, 0o600);
  const open = await fsp.stat(nodePath.join(tempDir, 'keys', 'public.pem'));
  assert.notStrictEqual(open.mode & 0o777, 0o600, 'the public half keeps the default');
});

test('what crosses the boundary is a copy', async (t) => {
  const tempDir = await createTemp();
  t.after(() => cleanupTemp(tempDir));
  const storage = await syncom.open({ path: tempDir, logger: false });
  t.after(() => storage.close());
  const input = { title: 'a', tags: ['x'], nested: { n: 1 } };
  const id = await storage.insert(input);
  input.tags.push('y');
  input.nested.n = 2;
  input.title = 'b';
  assert.deepStrictEqual(await storage.get(id), { title: 'a', tags: ['x'], nested: { n: 1 } }, 'set() took a copy');
  const out = await storage.get(id);
  out.tags.push('z');
  out.nested.n = 3;
  assert.deepStrictEqual(await storage.get(id), { title: 'a', tags: ['x'], nested: { n: 1 } }, 'get() handed a copy');
  assert.deepStrictEqual(storage.log.since(undefined)[0].op.data, { title: 'a', tags: ['x'], nested: { n: 1 } });
  const delta = { nested: { n: 5 } };
  await storage.update(id, delta);
  delta.nested.n = 6;
  assert.deepStrictEqual((await storage.get(id)).nested, { n: 5 });
  // A cursor's rows are copies too; the cache is the raw object.
  const typed = await syncom.open({ path: `${tempDir}-typed`, logger: false, schema: { entities: { Post: {} } } });
  t.after(() => typed.close());
  t.after(() => cleanupTemp(`${tempDir}-typed`));
  const post = await typed.Post.insert({ tags: ['a'] });
  const [row] = await typed.Post.select({}).fetch();
  row.tags.push('b');
  assert.deepStrictEqual((await typed.get(post.id)).tags, ['a']);
  assert.deepStrictEqual(typed.getCachedData(post.id).tags, ['a']);
});

test('swap compares inside the queue: two swaps on one expectation cannot both pass', async (t) => {
  const tempDir = await createTemp();
  t.after(() => cleanupTemp(tempDir));
  const storage = await syncom.open({ path: tempDir, logger: false });
  t.after(() => storage.close());
  const id = await storage.insert({ hits: 1 });
  const results = await Promise.all([
    storage.swap(id, { hits: 2, by: 'a' }, { hits: 1 }),
    storage.swap(id, { hits: 2, by: 'b' }, { hits: 1 }),
    storage.swap(id, { hits: 2, by: 'c' }, { hits: 1 }),
  ]);
  assert.deepStrictEqual(results.filter(Boolean).length, 1, 'exactly one won');
  const winner = results.indexOf(true);
  assert.deepStrictEqual(await storage.get(id), { hits: 2, by: 'abc'[winner] });
  await assert.rejects(() => storage.swap('missing', { a: 1 }, { a: 0 }), { code: 'NOT_FOUND', message: /not found/ });
  await assert.rejects(() => storage.swap(id, 'x', { a: 0 }), TypeError);
  await assert.rejects(() => storage.swap(id, { a: 1 }, null), TypeError);
  assert.strictEqual(storage.log.length, 2, 'the losing swaps wrote nothing');
});

test('chain: false keeps no chain, writes less, and says so when asked to validate', async (t) => {
  const fsp = require('node:fs/promises');
  const nodePath = require('node:path');
  const tempDir = await createTemp();
  t.after(() => cleanupTemp(tempDir));
  const storage = await syncom.open({ path: tempDir, logger: false, chain: false });
  const id = await storage.insert({ n: 1 });
  await storage.update(id, { n: 2 });
  await storage.inc(id, 'hits', 3);
  await storage.saveData('sealed', { secret: true }, { encrypted: true });
  await storage.applyRemote([{ origin: 'peer', seq: 1, ts: Date.now(), type: 'write', id: 'r', data: { p: 1 } }]);
  assert.deepStrictEqual(await storage.get(id), { n: 2, hits: 3 });
  assert.deepStrictEqual(await storage.get('sealed'), { secret: true });
  assert.deepStrictEqual(await storage.get('r'), { p: 1 });
  await assert.rejects(() => storage.validate(), { code: 'NO_CHAIN' });
  await assert.rejects(() => storage.validate(id, { n: 2 }, 'x'), { code: 'NO_CHAIN' });
  await assert.rejects(() => fsp.stat(nodePath.join(tempDir, 'blockchain')), /ENOENT/);
  const stored = JSON.parse(await fsp.readFile(nodePath.join(tempDir, 'data', `${id}.json`), 'utf8'));
  assert.strictEqual(stored.block, null);
  await storage.close();
  // A cold read trusts the file: there is no block to check against.
  const again = await syncom.open({ path: tempDir, logger: false, chain: false });
  t.after(() => again.close());
  assert.deepStrictEqual(await again.get(id), { n: 2, hits: 3 });
  assert.deepStrictEqual((await again.snapshot()).records.map((r) => r.id).sort(), [id, 'r'].sort());
  assert.throws(() => syncom.open({ path: `${tempDir}-bad`, logger: false, chain: 'no' }), TypeError);
  assert.throws(() => syncom.open(`${tempDir}-bad`), TypeError, 'a path alone is not options');
  assert.throws(() => syncom.open(null), TypeError);
});

test(
  'a Record the application dropped lets go of its cache entry',
  { skip: typeof globalThis.gc !== 'function' },
  async (t) => {
    const tempDir = await createTemp();
    t.after(() => cleanupTemp(tempDir));
    const storage = await syncom.open({ path: tempDir, logger: false, cache: { max: 2 } });
    t.after(() => storage.close());
    let dropped = await storage.record(await storage.insert({ n: 1 }));
    const droppedId = dropped.id;
    const kept = await storage.record(await storage.insert({ n: 2 }));
    dropped = null;
    globalThis.gc();
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.gc();
    for (let i = 0; i < 5; i++) await storage.insert({ i });
    assert.strictEqual(storage.getCachedData(kept.id)?.n, 2, 'a held Record pins its entry');
    assert.strictEqual(storage.getCachedData(droppedId), null, 'a dropped one does not');
    assert.strictEqual(storage.hasRecord(droppedId), true, 'the record itself is still there, in the catalog');
  },
);

test('a live Record is the same instance while held, and a new one after delete', async (t) => {
  const tempDir = await createTemp();
  t.after(() => cleanupTemp(tempDir));
  const storage = await syncom.open({ path: tempDir, logger: false });
  t.after(() => storage.close());
  const id = await storage.insert({ n: 1 });
  const a = await storage.record(id);
  const b = await storage.record(id);
  assert.strictEqual(a, b);
  await storage.delete(id);
  await storage.set(id, { n: 2 });
  const c = await storage.record(id);
  assert.notStrictEqual(a, c);
  assert.strictEqual(c.n, 2);
});

test('maxListeners: a hundred by default, tunable, enforced on the storage and its sync manager', async (t) => {
  const tempDir = await createTemp();
  t.after(() => cleanupTemp(tempDir));
  const storage = await syncom.open({ path: tempDir, logger: false });
  t.after(() => storage.close());
  // The sync manager holds one `change` listener of its own.
  for (let i = 0; i < 99; i++) storage.on('change', () => i);
  assert.throws(() => storage.on('change', () => 100), /MaxListenersExceededWarning/);
  const tight = await syncom.open({ path: `${tempDir}-tight`, logger: false, lock: false, maxListeners: 2 });
  t.after(() => tight.close());
  t.after(() => cleanupTemp(`${tempDir}-tight`));
  tight.on('change', () => 1);
  assert.throws(() => tight.on('change', () => 2), /MaxListenersExceededWarning/);
  tight.sync.on('peer', () => 1);
  tight.sync.on('peer', () => 2);
  assert.throws(() => tight.sync.on('peer', () => 3), /MaxListenersExceededWarning/);
  assert.throws(() => syncom.open({ path: tempDir, logger: false, lock: false, maxListeners: 0 }), TypeError);
});

test('A collection answers for its own records only', async (t) => {
  const dir = await createTemp();
  t.after(() => cleanupTemp(dir));
  const storage = await syncom.open({ path: dir, logger: false, schema: { entities: { Todo: {}, Note: {} } } });
  t.after(() => storage.close().catch(() => {}));
  const note = await storage.Note.insert({ text: 'mine' });
  const bare = await storage.insert({ loose: true });
  assert.strictEqual(await storage.Todo.get(note.id), null, 'a Note is not a Todo');
  assert.strictEqual(await storage.Todo.get(bare), null, 'nor is a record of no collection');
  assert.deepStrictEqual(await storage.Note.get(note.id), { text: 'mine', $type: 'Note' });
  assert.strictEqual(await storage.Todo.get('absent'), null);
  for (const call of [
    () => storage.Todo.update(note.id, { text: 'theirs' }),
    () => storage.Todo.delete(note.id),
    () => storage.Todo.record(note.id),
  ]) {
    await assert.rejects(call, (error) => {
      assert.ok(error instanceof syncom.SyncomError);
      assert.strictEqual(error.code, 'NOT_FOUND');
      assert.strictEqual(error.id, note.id);
      assert.strictEqual(error.entity, 'Todo');
      return true;
    });
  }
  assert.deepStrictEqual(await storage.get(note.id), { text: 'mine', $type: 'Note' }, 'untouched');
  await storage.Note.update(note.id, { text: 'edited' });
  assert.strictEqual((await storage.Note.record(note.id)).text, 'edited');
  await storage.Note.delete(note.id);
  assert.strictEqual(await storage.Note.get(note.id), null);
});

test('An entity name the storage answers to is refused at open', async (t) => {
  for (const name of ['get', 'set', 'close', 'log', 'sync', 'path', 'on', 'constructor', '__proto__']) {
    const dir = await createTemp();
    t.after(() => cleanupTemp(dir));
    const entities = Object.create(null);
    entities[name] = {};
    await assert.rejects(
      async () => syncom.open({ path: dir, logger: false, schema: { entities } }),
      (error) => error instanceof TypeError && error.message.includes(`'${name}'`),
      name,
    );
    // Refused before anything was opened: the directory is free.
    const storage = await syncom.open({ path: dir, logger: false });
    await storage.close();
  }
});
