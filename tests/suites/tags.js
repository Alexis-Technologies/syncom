'use strict';

// Named versions kept on the node, against whichever half the caller
// builds: a tag reads records as they were, copies land in the newest tag
// only and move down when it goes, a purge reaches them, a torn copy is
// evidence, and a tag survives a reopen.

const SECRET = 'SSN-123-45-6789';

const names = async (storage, dir) => {
  try {
    return (await storage.fsi.list(dir)).sort();
  } catch {
    return [];
  }
};
const dump = async (storage, dir) => {
  let text = '';
  for (const name of await names(storage, dir)) text += await storage.fsi.read(dir, name);
  return text;
};
const copies = (storage, tag) => names(storage, `${storage.path}/tags/${tag}/data`);

const runTagTests = async (t, assert, createStorage) => {
  await t.test(
    'a tag reads records as they were: after an update, a delete, an insert, through the lens',
    async (t2) => {
      const storage = await createStorage(t2, 'A', {
        schema: {
          version: 2,
          entities: { Post: {} },
          migrations: { 2: { Post: { up: ({ title, ...rest }) => ({ ...rest, name: title }) } } },
        },
      });
      const kept = await storage.insert({ n: 1 });
      await storage.splice(kept, 'body', 0, 0, 'hi');
      const doomed = await storage.insert({ gone: 'soon' });
      const sealed = await storage.insert({ pin: '1234' }, { encrypted: true });
      const stale = await storage.insert({ title: 'old', $type: 'Post' });
      await storage.delete(stale);
      assert.deepStrictEqual(storage.tags(), []);
      const tag = await storage.tag('v1');
      assert.deepStrictEqual(Object.keys(tag).sort(), ['createdAt', 'eventId', 'name', 'seq', 'ts', 'vector']);
      assert.strictEqual(tag.eventId, storage.log.formatId(tag.seq));
      assert.deepStrictEqual(tag.vector, storage.vector);
      assert.deepStrictEqual(storage.tags(), [tag]);
      // Changes after the tag.
      await storage.update(kept, { n: 2 });
      await storage.push(kept, 'body', '!');
      await storage.delete(doomed);
      await storage.set(sealed, { pin: '9999' }, { encrypted: true });
      const fresh = await storage.insert({ n: 'new' });
      await storage.set(stale, { title: 'revived', $type: 'Post' });
      // The tag: as it was.
      const view = storage.at('v1');
      assert.deepStrictEqual(await view.get(kept), { n: 1, body: 'hi' });
      assert.deepStrictEqual(await storage.get(kept, { at: { tag: 'v1' } }), { n: 1, body: 'hi' });
      assert.deepStrictEqual(await view.get(doomed), { gone: 'soon' }, 'deleted since: still there at the tag');
      assert.deepStrictEqual(await view.get(sealed), { pin: '1234' }, 'a sealed copy decrypts');
      assert.strictEqual(await view.get(fresh), null, 'inserted since: not there at the tag');
      assert.strictEqual(await view.get(stale), null, 'a tombstone at the tag');
      assert.strictEqual(await view.get('never'), null);
      assert.strictEqual(await view.get('bad id!'), null);
      assert.deepStrictEqual(
        [view.has(kept), view.has(doomed), view.has(sealed), view.has(fresh), view.has(stale)],
        [true, true, true, false, false],
      );
      assert.strictEqual(view.has('bad id!'), false);
      // The present is untouched.
      assert.deepStrictEqual(await storage.get(kept), { n: 2, body: 'hi!' });
      assert.strictEqual(await storage.get(doomed), null);
      assert.deepStrictEqual(await storage.get(fresh), { n: 'new' });
      // A copy is a copy.
      const copy = await view.get(kept);
      copy.n = 'edited';
      assert.deepStrictEqual((await view.get(kept)).n, 1);
      // Through the lens: a v1 record tagged, read at the tag as v2 reads it.
      const b = await createStorage(t2, 'B', { schema: { version: 1, entities: { Post: {} } } });
      const post = await b.Post.insert({ title: 'x' });
      await b.close();
      const upgraded = await createStorage(t2, 'B', {
        schema: {
          version: 2,
          entities: { Post: {} },
          migrations: { 2: { Post: { up: ({ title, ...rest }) => ({ ...rest, name: title }) } } },
        },
      });
      await upgraded.tag('before');
      await upgraded.Post.update(post.id, { name: 'y' });
      assert.deepStrictEqual(await upgraded.at('before').get(post.id), { name: 'x', $type: 'Post' });
      assert.deepStrictEqual(await upgraded.Post.get(post.id, { at: { tag: 'before' } }), { name: 'x', $type: 'Post' });
      // Names and codes.
      await assert.rejects(() => storage.tag('v1'), { name: 'SyncomError', code: 'TAG_EXISTS', tag: 'v1' });
      await assert.rejects(() => storage.tag('bad name!'), TypeError);
      await assert.rejects(() => storage.tag(''), TypeError);
      assert.throws(() => storage.at('nope'), { name: 'SyncomError', code: 'TAG_NOT_FOUND', tag: 'nope' });
      assert.throws(() => storage.at(5), TypeError);
      await assert.rejects(() => storage.untag('nope'), { code: 'TAG_NOT_FOUND' });
      await assert.rejects(() => storage.untag(5), TypeError);
      await assert.rejects(() => storage.get(kept, { at: { tag: 'nope' } }), { code: 'TAG_NOT_FOUND' });
      await assert.rejects(() => storage.get(kept, { at: { tag: 5 } }), { code: 'INVALID_VERSION' });
    },
  );

  await t.test('copies land in the newest tag only, once per record, and move down when it goes', async (t2) => {
    const storage = await createStorage(t2, 'A');
    const a = await storage.insert({ a: 1 });
    const b = await storage.insert({ b: 1 });
    const c = await storage.insert({ c: 1 });
    await storage.tag('t1');
    assert.deepStrictEqual(await copies(storage, 't1'), [], 'a tag copies nothing by itself');
    await storage.update(a, { a: 2 });
    await storage.update(a, { a: 3 });
    assert.deepStrictEqual(await copies(storage, 't1'), [`${a}.json`], 'one copy per record, at its first change');
    await storage.tag('t2');
    await storage.update(a, { a: 4 });
    await storage.update(b, { b: 2 });
    const d = await storage.insert({ d: 1 });
    await storage.update(d, { d: 2 });
    assert.deepStrictEqual(await copies(storage, 't1'), [`${a}.json`], 'the older tag takes no more');
    assert.deepStrictEqual(await copies(storage, 't2'), [`${a}.json`, `${b}.json`].sort(), 'd was not there at t2');
    await storage.tag('t3');
    await storage.update(c, { c: 2 });
    await storage.update(b, { b: 3 });
    assert.deepStrictEqual(await copies(storage, 't3'), [`${b}.json`, `${c}.json`].sort());
    const expect = async (tag, want) => {
      const view = storage.at(tag);
      assert.deepStrictEqual([await view.get(a), await view.get(b), await view.get(c), await view.get(d)], want, tag);
    };
    await expect('t1', [{ a: 1 }, { b: 1 }, { c: 1 }, null]);
    await expect('t2', [{ a: 3 }, { b: 1 }, { c: 1 }, null]);
    await expect('t3', [{ a: 4 }, { b: 2 }, { c: 1 }, { d: 2 }]);
    // Drop the middle: t1 reads the same; t2's copy of b (unchanged between
    // t1 and t2) moves to t1, its copy of a (t1 has its own) goes.
    await storage.untag('t2');
    assert.deepStrictEqual(
      storage.tags().map((tag) => tag.name),
      ['t1', 't3'],
    );
    assert.deepStrictEqual(await copies(storage, 't1'), [`${a}.json`, `${b}.json`].sort());
    assert.deepStrictEqual(await copies(storage, 't2'), []);
    await expect('t1', [{ a: 1 }, { b: 1 }, { c: 1 }, null]);
    await expect('t3', [{ a: 4 }, { b: 2 }, { c: 1 }, { d: 2 }]);
    // Drop the newest: nothing older needs its copies (c did not change
    // between t1 and t3 — so t1 takes c's copy; b t1 already has).
    await storage.untag('t3');
    assert.deepStrictEqual(await copies(storage, 't1'), [`${a}.json`, `${b}.json`, `${c}.json`].sort());
    assert.deepStrictEqual(await copies(storage, 't3'), []);
    await expect('t1', [{ a: 1 }, { b: 1 }, { c: 1 }, null]);
    // Drop the last: the copies go, the directory stays empty.
    await storage.untag('t1');
    assert.deepStrictEqual(storage.tags(), []);
    assert.deepStrictEqual(await copies(storage, 't1'), []);
    assert.deepStrictEqual(await names(storage, `${storage.path}/tags/t1/index`), []);
    // A new tag of a used name starts clean.
    await storage.tag('t1');
    await expect('t1', [{ a: 4 }, { b: 3 }, { c: 2 }, { d: 2 }]);
    assert.deepStrictEqual(await copies(storage, 't1'), []);
  });

  await t.test('a tag survives a reopen; a stray copy of a reused name is swept', async (t2) => {
    let storage = await createStorage(t2, 'A');
    const id = await storage.insert({ v: 1 });
    const tag = await storage.tag('rel');
    await storage.update(id, { v: 2 });
    await storage.close();
    storage = await createStorage(t2, 'A');
    assert.deepStrictEqual(storage.tags(), [tag]);
    assert.deepStrictEqual(await storage.at('rel').get(id), { v: 1 });
    await storage.update(id, { v: 3 });
    assert.deepStrictEqual(await copies(storage, 'rel'), [`${id}.json`], 'the copy is known again: not taken twice');
    assert.deepStrictEqual(await storage.at('rel').get(id), { v: 1 });
    // A crash between an untag's tags.json and its sweep: the copies are
    // unknown to every reader and go when the name is taken again.
    await storage.untag('rel');
    const leftover = `${storage.path}/tags/rel/data`;
    await storage.fsi.write(leftover, `${id}.json`, JSON.stringify({ data: { v: 'stale' }, meta: null }));
    await storage.close();
    storage = await createStorage(t2, 'A');
    assert.deepStrictEqual(storage.tags(), []);
    await storage.tag('rel');
    assert.deepStrictEqual(await copies(storage, 'rel'), [], 'swept when the name is taken again');
    assert.deepStrictEqual(await storage.at('rel').get(id), { v: 3 });
    // A tag whose catalog file is lost is dropped at open, with a warning.
    await storage.fsi.remove(`${storage.path}/tags/rel/index`, 'catalog.json');
    await storage.close();
    storage = await createStorage(t2, 'A');
    assert.deepStrictEqual(storage.tags(), []);
    // tags.json unreadable: the open refuses, like node.json.
    await storage.fsi.write(storage.path, 'tags.json', '{ torn');
    await storage.close();
    await assert.rejects(() => createStorage(t2, 'A'), { code: 'CORRUPT' });
    await storage.fsi.write(storage.path, 'tags.json', JSON.stringify({ format: 1, tags: [] }));
    storage = await createStorage(t2, 'A');
    assert.deepStrictEqual(storage.tags(), []);
  });

  await t.test(
    'a copy that cannot be written stops the write; a torn copy is evidence; a purge reaches the tags',
    async (t2) => {
      const storage = await createStorage(t2, 'A', {
        schema: { entities: { Person: { index: ['ssn'] } } },
      });
      const person = await storage.Person.insert({ ssn: SECRET, note: 'x' });
      await storage.tag('v1');
      // The copy fails: the op is logged, the record is held in memory and
      // reported UNPERSISTED, its file untouched — so the tag still reads the
      // file; the next write lands, the copy with it.
      const errors = [];
      storage.on('error', (error) => errors.push(error));
      const { fsi } = storage;
      const write = fsi.write;
      fsi.write = (dir, file, text) =>
        dir.includes('/tags/') ? Promise.reject(new Error('disk full')) : write.call(fsi, dir, file, text);
      try {
        await storage.update(person.id, { note: 'y' });
      } finally {
        fsi.write = write;
      }
      assert.strictEqual(errors.at(-1)?.code, 'UNPERSISTED');
      assert.deepStrictEqual(await copies(storage, 'v1'), [], 'no copy');
      assert.deepStrictEqual((await storage.get(person.id)).note, 'y', 'the write stands: the log has it');
      assert.deepStrictEqual(
        await storage.at('v1').get(person.id),
        { ssn: SECRET, note: 'x', $type: 'Person' },
        'held since the tag: the file is the tag’s state',
      );
      await storage.update(person.id, { note: 'z' });
      assert.deepStrictEqual(await copies(storage, 'v1'), [`${person.id}.json`]);
      assert.deepStrictEqual(await storage.at('v1').get(person.id), { ssn: SECRET, note: 'x', $type: 'Person' });
      assert.deepStrictEqual((await storage.get(person.id)).note, 'z');
      // A record held when a tag is asked for: no file to copy from, so the
      // tag waits for it to land.
      const held = await storage.insert({ h: 1 });
      fsi.write = (dir, file, text) =>
        dir.endsWith('/data') && file === `${held}.json`
          ? Promise.reject(new Error('disk full'))
          : write.call(fsi, dir, file, text);
      try {
        await storage.update(held, { h: 2 });
      } finally {
        fsi.write = write;
      }
      assert.strictEqual(errors.at(-1)?.code, 'UNPERSISTED');
      await assert.rejects(() => storage.tag('v2'), { name: 'SyncomError', code: 'UNPERSISTED', ids: [held] });
      await storage.update(held, { h: 3 });
      await storage.tag('v2');
      assert.deepStrictEqual(await storage.at('v2').get(held), { h: 3 });
      await storage.untag('v2');
      // A tampered copy fails its chain check at the tag, not the present.
      const dir = `${storage.path}/tags/v1/data`;
      const raw = JSON.parse(await fsi.read(dir, `${person.id}.json`));
      raw.data.note = 'forged';
      await fsi.write(dir, `${person.id}.json`, JSON.stringify(raw));
      await assert.rejects(() => storage.at('v1').get(person.id), { code: 'INTEGRITY' });
      await fsi.write(dir, `${person.id}.json`, '{ torn');
      await assert.rejects(() => storage.at('v1').get(person.id), { code: 'INTEGRITY' });
      assert.deepStrictEqual((await storage.get(person.id)).note, 'z');
      // A purge: the copies go, the tag's catalog forgets the row (its
      // indexed values and search text with it), nothing of the secret stays.
      await storage.purge(person.id);
      assert.strictEqual(storage.at('v1').has(person.id), false);
      assert.strictEqual(await storage.at('v1').get(person.id), null);
      assert.deepStrictEqual(await copies(storage, 'v1'), []);
      const texts = await Promise.all([dump(storage, dir), dump(storage, `${storage.path}/tags/v1/index`)]);
      assert.ok(!texts.some((text) => text.includes(SECRET)), 'nothing of the secret under tags/');
    },
  );

  await t.test('queries, the list and a snapshot at a tag read the storage as it was', async (t2) => {
    const storage = await createStorage(t2, 'A', {
      schema: { entities: { Post: { index: ['n'] }, Note: {} } },
    });
    const ids = [];
    for (let n = 1; n <= 4; n++) ids.push((await storage.Post.insert({ n })).id);
    const note = await storage.Note.insert({ text: 'x' });
    const sealed = await storage.insert({ pin: '1' }, { encrypted: true });
    const before = await storage.Post.select({ n: { $gte: 2 } })
      .order('n')
      .fetch();
    const all = await storage.list();
    const tag = await storage.tag('v1');
    await storage.Post.update(ids[1], { n: 20 });
    await storage.Post.delete(ids[2]);
    await storage.Post.insert({ n: 5 });
    await storage.Note.update(note.id, { text: 'y' });
    const view = storage.at('v1');
    const posts = view.collection('Post');
    assert.strictEqual(posts.name, 'Post');
    assert.deepStrictEqual(
      await posts
        .select({ n: { $gte: 2 } })
        .order('n')
        .fetch(),
      before,
      'as before the changes',
    );
    assert.deepStrictEqual(
      (
        await storage.Post.select({ n: { $gte: 2 } })
          .order('n')
          .fetch()
      ).map((row) => row.n),
      [4, 5, 20],
      'the present moved on',
    );
    assert.strictEqual(await posts.count({ n: { $gte: 2 } }), 3);
    assert.strictEqual(await posts.count(), 4);
    assert.deepStrictEqual(view.list(), all);
    assert.deepStrictEqual(await posts.get(ids[2]), { n: 3, $type: 'Post' }, 'deleted since');
    assert.strictEqual(await posts.get(note.id), null, 'another collection');
    assert.strictEqual(await posts.get('nope'), null);
    assert.deepStrictEqual(await view.collection('Note').get(note.id), { text: 'x', $type: 'Note' });
    assert.throws(() => view.collection('Nope'), TypeError);
    assert.throws(() => posts.select().watch(() => {}), /does not change/);
    assert.throws(() => posts.select({ $text: 'x' }), TypeError);
    // A snapshot at the tag: pages another storage joins to stand there.
    const page = await view.snapshot({ limit: 3 });
    assert.strictEqual(page.records.length, 3);
    assert.strictEqual(page.eventId, tag.eventId);
    assert.deepStrictEqual(page.vector, tag.vector);
    assert.ok(page.cursor !== null);
    const rest = await view.snapshot({ cursor: page.cursor });
    assert.strictEqual(rest.cursor, null);
    const records = [...page.records, ...rest.records];
    assert.deepStrictEqual(
      records.map((record) => record.id).sort(),
      all.filter((id) => id !== sealed).sort(),
      'every record live at the tag, the sealed one left out',
    );
    assert.deepStrictEqual(records.find((record) => record.id === ids[1]).data, { n: 2, $type: 'Post' });
    const other = await createStorage(t2, 'B', { schema: { entities: { Post: { index: ['n'] }, Note: {} } } });
    await other.mergeSnapshot(JSON.parse(JSON.stringify(records)));
    assert.deepStrictEqual(
      await other.Post.select({ n: { $gte: 2 } })
        .order('n')
        .fetch(),
      before,
    );
    assert.deepStrictEqual(
      await other.list(),
      all.filter((id) => id !== sealed),
    );
    assert.deepStrictEqual(await other.get(note.id), { text: 'x', $type: 'Note' });
    await other.adoptVector(tag.vector);
    for (const key of Object.keys(tag.vector)) assert.strictEqual(other.vector[key], tag.vector[key], key);
  });

  await t.test('the read hooks see the tag; a Record and a collection read through it too', async (t2) => {
    const seen = [];
    const storage = await createStorage(t2, 'A', {
      hooks: {
        beforeRead: (ctx) => void seen.push(ctx),
        afterRead: (ctx, data) => (data && data.secret ? { ...data, secret: '***' } : undefined),
      },
    });
    const id = await storage.insert({ secret: 's', n: 1 });
    await storage.tag('v1');
    await storage.update(id, { n: 2 });
    assert.deepStrictEqual(await storage.at('v1').get(id), { secret: '***', n: 1 });
    assert.deepStrictEqual(seen, [{ id, at: { tag: 'v1' } }]);
  });

  await t.test(
    'a tags.json line whose name is not a record id is dropped at open, never read as a path',
    async (t2) => {
      let storage = await createStorage(t2, 'A');
      const id = await storage.insert({ v: 1 });
      const tag = await storage.tag('ok');
      await storage.close();
      // A tampered file names a directory outside tags/ as a tag.
      const raw = JSON.parse(await storage.fsi.read(storage.path, 'tags.json'));
      raw.tags.push({ ...raw.tags[0], name: '../../elsewhere' });
      await storage.fsi.write(storage.path, 'tags.json', JSON.stringify(raw));
      storage = await createStorage(t2, 'A');
      assert.deepStrictEqual(storage.tags(), [tag]);
      assert.deepStrictEqual(await storage.at('ok').get(id), { v: 1 });
      const saved = JSON.parse(await storage.fsi.read(storage.path, 'tags.json'));
      assert.deepStrictEqual(
        saved.tags.map((line) => line.name),
        ['ok'],
        'the line is gone from the file',
      );
    },
  );
};

module.exports = { runTagTests };
