'use strict';

// Full-text search through the storage, against whichever half the caller
// builds: the seam (`schema.entities[name].search`, `open({ search })`,
// `$text`) over the @alexify/syncom/search index. `createStorage(t, name,
// options)` gives the same directory for the same name within one subtest;
// the memory backend is wrapped to count reads, so "no I/O" is a number.

const { createMemoryFsi } = require('../../src/backend.js');
const { createSearch } = require('../../src/search.js');

const counting = (fsi) => {
  const reads = [];
  return {
    read: (dir, name) => {
      reads.push(`${dir}/${name}`);
      return fsi.read(dir, name);
    },
    write: (dir, name, content) => fsi.write(dir, name, content),
    exists: (dir, name) => fsi.exists(dir, name),
    remove: (dir, name) => fsi.remove(dir, name),
    list: (dir) => fsi.list(dir),
    dataReads: () => reads.filter((key) => key.includes('/data/')).length,
    reset: () => void reads.splice(0),
  };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const titles = (rows) => rows.map((row) => row.title);

const runSearchTests = async (t, assert, createStorage) => {
  const schema = { entities: { Post: { index: ['orgId'], search: ['title', 'body'] }, Tag: {} } };
  const search = createSearch();

  await t.test(
    'search fields without open({ search }) are refused at open; so is a bad option or index',
    async (t2) => {
      await assert.rejects(() => createStorage(t2, 'none', { schema }), {
        name: 'TypeError',
        message: /open\(\{ search \}\): entity Post declares search fields/,
      });
      await assert.rejects(() => createStorage(t2, 'bad', { schema, search: 'yes' }), {
        name: 'TypeError',
        message: /open\(\{ search \}\): search must be a function/,
      });
      await assert.rejects(() => createStorage(t2, 'shape', { schema, search: () => ({}) }), {
        name: 'TypeError',
        message: /the index for Post must have put\(\), remove\(\) and query\(\)/,
      });
      // An index given to a storage with nothing to search is simply unused.
      const plain = await createStorage(t2, 'plain', { search });
      const id = await plain.insert({ title: 'no schema' });
      assert.deepStrictEqual(await plain.get(id), { title: 'no schema' });
    },
  );

  await t.test('every write path reaches the index: insert, update, delete, purge, a peer op', async (t2) => {
    const storage = await createStorage(t2, 'A', { schema, search });
    const find = async (text) => titles(await storage.Post.select({ $text: text }).fetch());
    const post = await storage.Post.insert({ orgId: 'o1', title: 'Quick brown fox', body: 'jumps' });
    assert.deepStrictEqual(await find('fox'), ['Quick brown fox']);
    assert.deepStrictEqual(await find('jumps'), ['Quick brown fox'], 'every search field is searched');
    await storage.update(post.id, { title: 'Lazy dog' });
    assert.deepStrictEqual(await find('fox'), []);
    assert.deepStrictEqual(await find('dog'), ['Lazy dog']);
    await storage.delete(post.id);
    assert.deepStrictEqual(await find('dog'), [], 'a tombstone never matches');
    await storage.set(post.id, { $type: 'Post', title: 'Back again' });
    assert.deepStrictEqual(await find('again'), ['Back again'], 'a revival is found again');
    await storage.purge(post.id);
    assert.deepStrictEqual(await find('again'), []);
    await storage.applyRemote([
      {
        origin: 'peer',
        seq: 1,
        ts: Date.now() + 10_000,
        type: 'write',
        id: 'p1',
        data: { $type: 'Post', orgId: 'o2', title: 'From a peer' },
      },
    ]);
    assert.deepStrictEqual(await find('peer'), ['From a peer']);
  });

  await t.test('a text field is searched as it reads: updateText moves a word in and out of the index', async (t2) => {
    const storage = await createStorage(t2, 'T', { schema, search });
    const find = async (text) => titles(await storage.Post.select({ $text: text }).fetch());
    const post = await storage.Post.insert({ orgId: 'o1', title: 'Typed' });
    await storage.updateText(post.id, 'body', 'jumps over the lazy dog');
    assert.deepStrictEqual(await find('lazy'), ['Typed']);
    await storage.updateText(post.id, 'body', 'jumps over the sleepy dog');
    assert.deepStrictEqual(await find('lazy'), []);
    assert.deepStrictEqual(await find('sleepy'), ['Typed']);
    await storage.splice(post.id, 'body', 0, 5, 'leaps');
    assert.deepStrictEqual(await find('leaps'), ['Typed']);
    assert.deepStrictEqual(await find('jumps'), []);
  });

  await t.test('$text ranks, an equality narrows, limit and one() read little, order re-sorts', async (t2) => {
    const fsi = counting(createMemoryFsi());
    const storage = await createStorage(t2, 'A', { fsi, schema, search, cache: { max: 5 } });
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    for (let i = 0; i < 60; i++) {
      const title = `${words[i % 6]} ${words[(i * 5) % 6]} note ${i}`;
      await storage.Post.insert({ orgId: `o${i % 3}`, title, n: i });
    }
    await storage.Post.insert({ orgId: 'o1', title: 'quick fox', n: 100 });
    await storage.Post.insert({ orgId: 'o1', title: 'quick fox jumps over the lazy dog, again and again', n: 101 });
    await storage.Post.insert({ orgId: 'o2', title: 'quick fox', n: 102 });
    // Best first: the short exact title, ties by id; the long one after.
    const ranked = await storage.Post.select({ $text: 'quick fox', orgId: 'o1' }).fetch();
    assert.deepStrictEqual(
      ranked.map((row) => row.n),
      [100, 101],
      'o1 only, the shorter title first',
    );
    assert.strictEqual(await storage.Post.count({ $text: 'quick fox' }), 3);
    assert.strictEqual(await storage.Post.count({ $text: 'quick fox', orgId: 'o2' }), 1);
    fsi.reset();
    const [best] = await storage.Post.select({ $text: 'quick fox', orgId: 'o1' }).limit(1).fetch();
    assert.strictEqual(best.n, 100);
    assert.ok(fsi.dataReads() <= 1, `an unordered limit reads ${fsi.dataReads()} record(s), not 63`);
    fsi.reset();
    assert.strictEqual((await storage.Post.select({ $text: 'gamma' }).one()).title.includes('gamma'), true);
    assert.ok(fsi.dataReads() <= 1);
    const ordered = await storage.Post.select({ $text: 'quick fox' }).desc('n').fetch();
    assert.deepStrictEqual(
      ordered.map((row) => row.n),
      [102, 101, 100],
      'order() re-sorts the matches',
    );
    // Covered: the catalog answers $text + an indexed projection with no read.
    fsi.reset();
    const covered = await storage.Post.select({ $text: 'quick fox', orgId: 'o1' }).projection(['orgId']).fetch();
    assert.strictEqual(covered.length, 2);
    assert.strictEqual(fsi.dataReads(), 0);
    // Typos: a word with its last letters swapped still finds it.
    assert.strictEqual(await storage.Post.count({ $text: 'quick fxo' }), 3);
    assert.deepStrictEqual(await storage.Post.select({ $text: 'nothing like it' }).fetch(), []);
    assert.deepStrictEqual(await storage.Post.select({ $text: '...' }).fetch(), [], 'nothing to search for');
  });

  await t.test(
    'what is searched: the record as it reads, never encrypted, deleted or another collection',
    async (t2) => {
      const v1 = { version: 1, entities: { Post: { search: ['headline'] }, Tag: {} } };
      const v2 = {
        version: 2,
        entities: { Post: { search: ['title'] }, Tag: {} },
        migrations: { 2: { Post: { up: ({ headline, ...rest }) => ({ ...rest, title: headline }) } } },
      };
      const fsi = createMemoryFsi();
      let storage = await createStorage(t2, 'A', { fsi, schema: v1, search });
      await storage.Post.insert({ headline: 'Written before the rename' });
      await storage.insert({ $type: 'Post', headline: 'sealed words' }, { encrypted: true });
      await storage.Tag.insert({ headline: 'a tag, not a post' });
      await storage.close();
      // Read through the lens: the v1 record's `headline` is v2's `title`.
      storage = await createStorage(t2, 'A', { fsi, schema: v2, search });
      assert.deepStrictEqual(titles(await storage.Post.select({ $text: 'rename' }).fetch()), [
        'Written before the rename',
      ]);
      assert.strictEqual(await storage.Post.count({ $text: 'sealed' }), 0, 'an encrypted record is never matched');
      assert.throws(() => storage.Tag.select({ $text: 'tag' }), {
        name: 'TypeError',
        message: /\$text needs search fields on Tag/,
      });
      assert.throws(() => storage.Post.select({ $or: [{ $text: 'x' }] }), /only allowed at the top level/);
    },
  );

  await t.test('a reopen reuses the catalog, text included; other search fields rebuild it once', async (t2) => {
    const fsi = counting(createMemoryFsi());
    let storage = await createStorage(t2, 'A', { fsi, schema, search, catalog: { flushEvery: 1000 } });
    for (let i = 0; i < 20; i++) await storage.Post.insert({ title: `title ${i}`, body: `body word${i}` });
    await storage.log.flush();
    await storage.close();
    fsi.reset();
    storage = await createStorage(t2, 'A', { fsi, schema, search, catalog: { flushEvery: 1000 } });
    assert.strictEqual(fsi.dataReads(), 0, 'the text came back from catalog.json');
    // Fuzzy: `word7` shares three of its five trigrams with every `wordN`, so
    // all of them match — and the exact one ranks first.
    assert.strictEqual(await storage.Post.count({ $text: 'word7' }), 20);
    const [top] = await storage.Post.select({ $text: 'word7' }).limit(1).fetch();
    assert.strictEqual(top.body, 'body word7');
    await storage.close();
    // Only `title` now: the catalog is rebuilt, and a body word no longer matches.
    const debug = [];
    const logger = { debug: (entry) => debug.push(entry.event), info() {}, warn() {}, error() {} };
    const titleOnly = { entities: { Post: { index: ['orgId'], search: ['title'] }, Tag: {} } };
    fsi.reset();
    storage = await createStorage(t2, 'A', { fsi, schema: titleOnly, search, logger });
    assert.ok(debug.includes('catalog.rebuild'), 'the file was built for other fields');
    assert.ok(fsi.dataReads() >= 20);
    assert.strictEqual(await storage.Post.count({ $text: 'word7' }), 0);
    assert.strictEqual(await storage.Post.count({ $text: 'title' }), 20);
  });

  await t.test('watch() runs again when a matching record lands', async (t2) => {
    const storage = await createStorage(t2, 'A', { schema, search });
    await storage.Post.insert({ title: 'first fox' });
    const calls = [];
    const stop = storage.Post.select({ $text: 'fox' }).watch((rows) => calls.push(titles(rows)));
    await tick();
    assert.deepStrictEqual(calls, [['first fox']]);
    await storage.Post.insert({ title: 'second fox' });
    await tick();
    assert.deepStrictEqual(calls.at(-1), ['first fox', 'second fox']);
    await storage.Tag.insert({ title: 'fox' });
    await tick();
    assert.strictEqual(calls.length, 2, 'another collection does not wake it');
    stop();
  });

  await t.test('an index that throws is logged; the write lands and lists', async (t2) => {
    const warnings = [];
    const logger = { warn: (entry) => warnings.push(entry), info() {}, debug() {}, error() {} };
    let fail = true;
    const flaky = (entity) => {
      const index = search(entity);
      return {
        put: (id, text) => {
          if (fail) {
            fail = false;
            throw new Error('index full');
          }
          index.put(id, text);
        },
        remove: (id) => index.remove(id),
        query: (text) => index.query(text),
      };
    };
    const storage = await createStorage(t2, 'A', { schema, search: flaky, logger });
    const lost = await storage.Post.insert({ title: 'not indexed' });
    const kept = await storage.Post.insert({ title: 'indexed' });
    assert.ok((await storage.list()).includes(lost.id), 'the write landed');
    assert.deepStrictEqual(
      warnings.filter((entry) => entry.event === 'catalog.search').map((entry) => [entry.id, entry.err.message]),
      [[lost.id, 'index full']],
    );
    assert.deepStrictEqual(
      (await storage.Post.select({ $text: 'indexed' }).fetch()).map((row) => row.id),
      [kept.id],
    );
  });
};

module.exports = { runSearchTests };
