'use strict';

// Entity definitions and validation, against whichever storage half the
// caller builds: `createStorage(t, name, options)` gives the SAME directory
// for the same name within one subtest (reopen cases).

const { createMesh, settle, waitUntil } = require('../utils/mesh.js');
const { MemoryLink } = require('../utils/memory-link.js');

const remoteOp = (origin, seq, type, id, extra = {}) => ({ origin, seq, ts: Date.now() + seq, type, id, ...extra });
const standard = (validate) => ({ '~standard': { version: 1, vendor: 'test', validate } });
const issue = (message, path = [], code) => (code ? { message, path, code } : { message, path });

// The shape `model.entities.get('Project')` has in metaschema: the fields
// (with the kind's own `projectId`), the indexes as given, and `~standard`
// resolving aliases, filling defaults and rejecting unknown keys.
const metaschemaProject = (seen) => {
  const fields = {
    orgId: { required: true, type: 'string' },
    name: { required: true, aliases: ['title'], type: 'string' },
    slug: { required: true, type: 'string' },
    desc: { required: false, type: 'string', default: '' },
    projectId: { required: false, type: 'string' },
  };
  return {
    name: 'Project',
    kind: 'registry',
    fields,
    indexes: { byOrg: { index: ['orgId'] }, bySlug: { unique: ['slug'] }, 'tags?': { many: 'Tag' } },
    '~standard': {
      version: 1,
      vendor: 'alexify.metaschema',
      validate(input) {
        seen.push(Object.keys(input));
        const issues = [];
        const value = {};
        const unknown = [];
        for (const key of Object.keys(input)) {
          if (Object.hasOwn(fields, key)) value[key] = input[key];
          else if (key === 'title') {
            if (input.name === undefined) value.name = input.title;
          } else unknown.push(key);
        }
        for (const [field, spec] of Object.entries(fields)) {
          if (value[field] === undefined && spec.default !== undefined) value[field] = spec.default;
          if (value[field] === undefined && spec.required) {
            issues.push({ code: 'required', path: [field], message: 'is required', params: {} });
          }
        }
        if (unknown.length > 0) {
          const message = `has unexpected keys: ${unknown.join(', ')}`;
          issues.push({ code: 'unexpected', path: [], message, params: { keys: unknown } });
        }
        return issues.length > 0 ? { issues } : { value };
      },
    },
  };
};

const runSchemaTests = async (t, assert, createStorage) => {
  const invalid = (entity) => ({ name: 'ValidationError', code: 'VALIDATION_FAILED', entity });

  await t.test('a malformed schema, validator or id generator is refused at open', async (t2) => {
    await assert.rejects(() => createStorage(t2, 'bad', { schema: { entities: { Post: { uniqe: [] } } } }), {
      name: 'TypeError',
      message: /entity Post: unknown key 'uniqe'/,
    });
    await assert.rejects(
      () => createStorage(t2, 'bad2', { schema: { entities: { Post: { schema: { type: 'object' } } } } }),
      /needs open\({ validator }\) or validate: false/,
    );
    await assert.rejects(
      () => createStorage(t2, 'bad3', { validator: {} }),
      /validator must have a compile\(\) method/,
    );
    await assert.rejects(() => createStorage(t2, 'bad4', { getId: 'nope' }), {
      name: 'TypeError',
      message: 'open({ getId }): getId must be a function',
    });
  });

  await t.test(
    'a Standard Schema validates every write of its collection; its value is what is written',
    async (t2) => {
      const seen = [];
      const Post = standard((value) => {
        seen.push(value);
        if (typeof value.title !== 'string') return { issues: [issue('is required', ['title'], 'required')] };
        const { extra, ...rest } = value;
        return { value: { ...rest, status: rest.status ?? 'draft' } };
      });
      const storage = await createStorage(t2, 'A', { schema: { entities: { Post: { schema: Post } } } });
      const ops = [];
      storage.on('change', (op) => ops.push(op));
      const post = await storage.Post.insert({ title: 'Hello', extra: true });
      assert.deepStrictEqual(seen, [{ id: post.id, title: 'Hello', extra: true }], 'seen under `id`, without $type');
      const written = { title: 'Hello', status: 'draft', $type: 'Post' };
      assert.deepStrictEqual(await storage.get(post.id), written, 'the default is on disk, the stripped key is not');
      assert.deepStrictEqual(ops[0].data, written, 'the op carries the validated record');
      assert.strictEqual(post.status, 'draft', 'and so does the record view');
      // A set is validated as the whole record it leaves behind.
      await storage.Post.update(post.id, { status: 'published', extra: 1 });
      assert.deepStrictEqual(seen.at(-1), { id: post.id, title: 'Hello', status: 'published', extra: 1 });
      assert.deepStrictEqual(ops.at(-1).data, { status: 'published' }, 'a stripped key drops out of the delta');
      assert.deepStrictEqual(await storage.get(post.id), { title: 'Hello', status: 'published', $type: 'Post' });
      // A set that only names stripped keys changes nothing.
      const { length } = storage.log;
      const vector = { ...storage.vector };
      await storage.Post.update(post.id, { extra: 2 });
      assert.strictEqual(storage.log.length, length);
      assert.deepStrictEqual(storage.vector, vector);
      assert.strictEqual(ops.length, 2);
      // A failing write leaves nothing behind.
      const error = await storage.Post.insert({ extra: true }).catch((e) => e);
      assert.strictEqual(error.name, 'ValidationError');
      assert.strictEqual(error.code, 'VALIDATION_FAILED');
      assert.strictEqual(error.entity, 'Post');
      assert.deepStrictEqual(error.issues, [{ path: ['title'], message: 'is required', code: 'required' }]);
      assert.strictEqual(error.message, 'Post failed validation at title: is required');
      assert.strictEqual(storage.log.length, length);
      assert.strictEqual((await storage.list()).length, 1);
      assert.strictEqual(await storage.validate(), true);
      await assert.rejects(() => storage.update(post.id, { title: 7 }), invalid('Post'));
      assert.deepStrictEqual(await storage.get(post.id), { title: 'Hello', status: 'published', $type: 'Post' });
      // Records outside the collection are not validated.
      const loose = await storage.insert({ anything: true });
      assert.deepStrictEqual(await storage.get(loose), { anything: true });
      assert.strictEqual(seen.length, 5);
    },
  );

  await t.test('aliases: the validator renames on write; a set names the field, not the alias', async (t2) => {
    // Shaped like metaschema's `name: { aliases: ['title'] }` and a default `desc`.
    const Post = standard(({ title, ...rest }) => {
      const value = { ...rest };
      if (value.name === undefined && title !== undefined) value.name = title;
      if (value.desc === undefined) value.desc = '';
      return { value };
    });
    const storage = await createStorage(t2, 'A', { schema: { entities: { Post: { schema: Post } } } });
    const ops = [];
    storage.on('change', (op) => ops.push(op));
    const post = await storage.Post.insert({ title: 'Hello' });
    assert.deepStrictEqual(ops[0].data, { name: 'Hello', desc: '', $type: 'Post' });
    assert.deepStrictEqual(await storage.get(post.id), { name: 'Hello', desc: '', $type: 'Post' });
    // On a set the own field wins: a delta under the alias changes nothing.
    await storage.Post.update(post.id, { title: 'Renamed' });
    assert.strictEqual(ops.length, 1, 'nothing durable');
    assert.deepStrictEqual(await storage.get(post.id), { name: 'Hello', desc: '', $type: 'Post' });
    await storage.Post.update(post.id, { name: 'Renamed' });
    assert.deepStrictEqual(ops.at(-1).data, { name: 'Renamed' });
    // A record holding only the alias (written by an older peer) takes the
    // field; the alias key stays until a whole-record write replaces it.
    await storage.applyRemote([remoteOp('old', 1, 'write', 'legacy', { data: { title: 'Old', $type: 'Post' } })]);
    await storage.update('legacy', { title: 'New' });
    assert.deepStrictEqual(ops.at(-1).data, { name: 'New', desc: '' });
    assert.deepStrictEqual(await storage.get('legacy'), { title: 'Old', name: 'New', desc: '', $type: 'Post' });
    await storage.Post.set('legacy', { title: 'Whole' });
    assert.deepStrictEqual(await storage.get('legacy'), { name: 'Whole', desc: '', $type: 'Post' });
  });

  await t.test('the validator may be asynchronous, and its value is taken as JSON', async (t2) => {
    const Event = standard(async (value) => ({ value: { ...value, when: new Date(value.when) } }));
    const schema = { entities: { Event: { schema: Event } } };
    const storage = await createStorage(t2, 'A', { schema });
    const { id } = await storage.Event.insert({ when: '2026-01-01T00:00:00.000Z' });
    assert.deepStrictEqual(await storage.get(id), { when: '2026-01-01T00:00:00.000Z', $type: 'Event' });
    await storage.close();
    const reopened = await createStorage(t2, 'A', { schema });
    assert.deepStrictEqual(await reopened.get(id), { when: '2026-01-01T00:00:00.000Z', $type: 'Event' });
  });

  await t.test('idField: the id is handed over under the schema’s own key, or not at all', async (t2) => {
    const seen = [];
    const spy = standard((value) => {
      seen.push(Object.keys(value));
      return { value };
    });
    const storage = await createStorage(t2, 'A', {
      schema: { entities: { Project: { schema: spy, idField: 'projectId' }, Note: { schema: spy, idField: false } } },
    });
    const project = await storage.Project.insert({ name: 'p' });
    assert.deepStrictEqual(seen, [['projectId', 'name']]);
    assert.deepStrictEqual(
      await storage.get(project.id),
      { name: 'p', $type: 'Project' },
      'the id field is not written',
    );
    await storage.Note.insert({ name: 'n' });
    assert.deepStrictEqual(seen.at(-1), ['name']);
    // By metaschema's convention, off the field map: `id`, `<entity>Id`, or none.
    const withFields = (fields) => ({ ...spy, fields });
    const auto = await createStorage(t2, 'B', {
      schema: {
        entities: {
          Project: { schema: withFields({ projectId: {}, name: {} }) },
          Thing: { schema: withFields({ name: {} }) },
          Plain: { schema: withFields({ id: {}, name: {} }) },
        },
      },
    });
    seen.length = 0;
    await auto.Project.insert({ name: 'p' });
    await auto.Thing.insert({ name: 't' });
    await auto.Plain.insert({ name: 'x' });
    assert.deepStrictEqual(seen, [['projectId', 'name'], ['name'], ['id', 'name']]);
  });

  await t.test('validate: false reads the definition but validates nothing', async (t2) => {
    const schema = { fields: { postId: {}, title: {} }, indexes: { byTitle: { index: ['title'] } } };
    const storage = await createStorage(t2, 'A', { schema: { entities: { Post: { schema, validate: false } } } });
    const post = await storage.Post.insert({ anything: 1 });
    assert.deepStrictEqual(await storage.get(post.id), { anything: 1, $type: 'Post' });
    assert.deepStrictEqual(await storage.check('Post', { anything: 1 }), { anything: 1 });
  });

  await t.test('an ajv-compiled function and a compiled JSON Schema validate the same way', async (t2) => {
    const compiled = (value) => {
      if (typeof value.n === 'number') return true;
      compiled.errors = [{ instancePath: '/n', message: 'must be number', keyword: 'type' }];
      return false;
    };
    const compiles = [];
    const validator = {
      compile: (schema, meta) => {
        compiles.push([schema, meta]);
        return (value) => {
          if (value.n > 10) throw new RangeError('too big');
        };
      },
    };
    const json = { type: 'object' };
    const entities = { Fn: { schema: compiled }, Json: { schema: json } };
    const storage = await createStorage(t2, 'A', { schema: { entities }, validator });
    assert.deepStrictEqual(compiles, [[json, { entity: 'Json' }]]);
    await storage.Fn.insert({ n: 1 });
    const error = await storage.Fn.insert({ n: 'x' }).catch((e) => e);
    assert.strictEqual(error.name, 'ValidationError');
    assert.deepStrictEqual(error.issues, [{ path: ['n'], message: 'must be number', code: 'type' }]);
    await storage.Json.insert({ n: 1 });
    const ranged = await storage.Json.insert({ n: 11 }).catch((e) => e);
    assert.strictEqual(ranged.name, 'ValidationError');
    assert.deepStrictEqual(ranged.issues, [{ path: [], message: 'too big' }]);
    assert.strictEqual(ranged.cause.name, 'RangeError');
    assert.strictEqual((await storage.list()).length, 2);
  });

  await t.test('inc is validated against the record it leaves', async (t2) => {
    const Counter = standard((value) =>
      value.hits < 0 ? { issues: [issue('must be >= 0', ['hits'], 'min')] } : { value },
    );
    const storage = await createStorage(t2, 'A', { schema: { entities: { Counter: { schema: Counter } } } });
    const counter = await storage.Counter.insert({ name: 'c' });
    await storage.inc(counter.id, 'hits', 2);
    await assert.rejects(() => storage.inc(counter.id, 'hits', -3), invalid('Counter'));
    assert.deepStrictEqual(await storage.get(counter.id), { name: 'c', hits: 2, $type: 'Counter' });
    await storage.inc(counter.id, 'hits', -2);
    assert.strictEqual((await storage.get(counter.id)).hits, 0);
    // A set op is validated the same way: as the record it leaves.
    const Tagged = standard((value) =>
      (value.tags ?? []).length > 2 ? { issues: [issue('too many', ['tags'], 'max')] } : { value },
    );
    const tagged = await createStorage(t2, 'B', { schema: { entities: { Tagged: { schema: Tagged } } } });
    const post = await tagged.Tagged.insert({ name: 'p' });
    await tagged.add(post.id, 'tags', ['a', 'b']);
    await assert.rejects(() => tagged.add(post.id, 'tags', ['c']), invalid('Tagged'));
    assert.deepStrictEqual((await tagged.get(post.id)).tags, ['a', 'b']);
    await tagged.remove(post.id, 'tags', ['a']);
    await tagged.add(post.id, 'tags', ['c']);
    assert.deepStrictEqual((await tagged.get(post.id)).tags, ['b', 'c']);
    // A splice too: the validator sees the text as the op leaves it.
    const Short = standard((value) =>
      (value.body ?? '').length > 5 ? { issues: [issue('too long', ['body'], 'max')] } : { value },
    );
    const texts = await createStorage(t2, 'C', { schema: { entities: { Short: { schema: Short } } } });
    const note = await texts.Short.insert({ name: 'n' });
    await texts.splice(note.id, 'body', 0, 0, 'abc');
    await assert.rejects(() => texts.push(note.id, 'body', 'defg'), invalid('Short'));
    assert.strictEqual((await texts.get(note.id)).body, 'abc');
    await texts.push(note.id, 'body', 'de');
    assert.strictEqual((await texts.get(note.id)).body, 'abcde');
    // A validator default for the field makes it a register — the trap the
    // docs name: the splice is then refused for the kind.
    const Defaulted = standard((value) => ({ value: { body: '', ...value } }));
    const defaults = await createStorage(t2, 'D', { schema: { entities: { Defaulted: { schema: Defaulted } } } });
    const blank = await defaults.Defaulted.insert({ name: 'd' });
    assert.deepStrictEqual(await defaults.get(blank.id), { body: '', name: 'd', $type: 'Defaulted' });
    await assert.rejects(() => defaults.splice(blank.id, 'body', 0, 0, 'x'), {
      code: 'FIELD_KIND',
      kind: 'register',
    });
  });

  await t.test('check() runs the validator without writing', async (t2) => {
    const Post = standard((value) =>
      value.title ? { value: { ...value, status: 'draft' } } : { issues: [issue('is required', ['title'])] },
    );
    const storage = await createStorage(t2, 'A', { schema: { entities: { Post: { schema: Post }, Bare: {} } } });
    assert.deepStrictEqual(await storage.check('Post', { title: 'a' }), { title: 'a', status: 'draft' });
    assert.deepStrictEqual(await storage.check('Post', { id: 'p1', title: 'a', $type: 'Post' }), {
      id: 'p1',
      title: 'a',
      status: 'draft',
    });
    await assert.rejects(() => storage.check('Post', {}), invalid('Post'));
    assert.deepStrictEqual(await storage.check('Bare', { x: 1 }), { x: 1 });
    await assert.rejects(() => storage.check('Nope', {}), { name: 'TypeError', message: 'Unknown entity Nope' });
    await assert.rejects(() => storage.check('Post', 'text'), TypeError);
    assert.deepStrictEqual(await storage.list(), []);
  });

  await t.test('$type is immutable: carried by a whole-record write, refused when it would change', async (t2) => {
    const storage = await createStorage(t2, 'A', { schema: { entities: { Post: {}, Tag: {} } } });
    const post = await storage.Post.insert({ title: 'a' });
    await storage.set(post.id, { title: 'b' });
    assert.deepStrictEqual(await storage.get(post.id), { title: 'b', $type: 'Post' }, 'set() without $type keeps it');
    await storage.update(post.id, { $type: 'Post', n: 1 });
    assert.deepStrictEqual(await storage.get(post.id), { title: 'b', n: 1, $type: 'Post' });
    await assert.rejects(() => storage.set(post.id, { $type: 'Tag' }), {
      name: 'TypeError',
      code: 'TYPE_IMMUTABLE',
      message: `Record ${post.id} is a Post; $type is immutable`,
    });
    await assert.rejects(() => storage.update(post.id, { $type: 'Tag' }), TypeError);
    await assert.rejects(() => storage.Tag.set(post.id, { name: 'x' }), TypeError);
    await assert.rejects(() => storage.Post.update(post.id, { $type: 'Post' }), {
      name: 'TypeError',
      message: '$type is immutable; update() may not name it',
    });
    await assert.rejects(() => storage.Post.set(post.id, 'text'), TypeError);
    assert.deepStrictEqual(await storage.get(post.id), { title: 'b', n: 1, $type: 'Post' });
    // A record outside any collection may join one; a deleted one may be reborn in another.
    const loose = await storage.insert({ n: 1 });
    await storage.Post.set(loose, { n: 2, $type: 'Tag' });
    assert.deepStrictEqual(await storage.get(loose), { n: 2, $type: 'Post' }, 'Collection.set stamps its own');
    await storage.delete(post.id);
    await storage.Tag.set(post.id, { name: 'reborn' });
    assert.deepStrictEqual(await storage.get(post.id), { name: 'reborn', $type: 'Tag' });
    // A peer's op is applied as it is (stamped well above this node's clock).
    await storage.applyRemote([remoteOp('peer', 1, 'set', loose, { data: { $type: 'Tag' }, ts: Date.now() + 10_000 })]);
    assert.strictEqual((await storage.get(loose)).$type, 'Tag');
  });

  await t.test('a peer’s invalid op is skipped here: logged, relayed, replay-safe, reported', async (t2) => {
    const Post = standard((value) =>
      value.secret ? { issues: [issue('no secrets', ['secret'], 'forbidden')] } : { value },
    );
    const schema = { entities: { Post: { schema: Post } } };
    let storage = await createStorage(t2, 'A', { schema });
    const errors = [];
    storage.on('error', (error) => errors.push(error));
    const result = await storage.applyRemote(
      [
        remoteOp('peer', 1, 'write', 'r1', { data: { secret: true, $type: 'Post' } }),
        remoteOp('peer', 2, 'write', 'r2', { data: { n: 2, $type: 'Post' } }),
        remoteOp('peer', 3, 'write', 'r3', { data: { secret: true } }),
      ],
      { via: 'L', peer: { url: 'mem://peer', node: 'peer' } },
    );
    assert.deepStrictEqual(result, {
      applied: 3,
      skipped: 1,
      duplicates: 0,
      gaps: 0,
      malformed: 0,
      unsigned: 0,
      forged: 0,
      outOfScope: 0,
    });
    assert.strictEqual(await storage.get('r1'), null, 'the invalid op did not touch the record');
    assert.deepStrictEqual(await storage.get('r2'), { n: 2, $type: 'Post' });
    assert.deepStrictEqual(await storage.get('r3'), { secret: true }, 'outside the collection: not validated');
    assert.strictEqual(storage.vector.peer, 3, 'but it moved the vector');
    assert.strictEqual(storage.log.length, 3, 'and is in the log');
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Invalid op on r1/);
    assert.strictEqual(errors[0].op.seq, 1);
    assert.strictEqual(errors[0].entity, 'Post');
    assert.deepStrictEqual(errors[0].issues, [{ path: ['secret'], message: 'no secrets', code: 'forbidden' }]);
    // A later set that would make the record invalid is skipped too.
    const later = await storage.applyRemote([remoteOp('peer', 4, 'set', 'r2', { data: { secret: 1 } })]);
    assert.deepStrictEqual(later, {
      applied: 1,
      skipped: 1,
      duplicates: 0,
      gaps: 0,
      malformed: 0,
      unsigned: 0,
      forged: 0,
      outOfScope: 0,
    });
    assert.deepStrictEqual(await storage.get('r2'), { n: 2, $type: 'Post' });
    // A reopen replays the unsealed tail and leaves the skipped ops alone.
    await storage.close();
    storage = await createStorage(t2, 'A', { schema });
    assert.strictEqual(await storage.get('r1'), null);
    assert.deepStrictEqual(await storage.get('r2'), { n: 2, $type: 'Post' });
    assert.strictEqual(storage.vector.peer, 4);
  });

  await t.test('a skip is local: a lax peer behind a strict one still receives the op', async (t2) => {
    const strict = {
      entities: { Post: { schema: standard((value) => (value.secret ? { issues: [issue('no')] } : { value })) } },
    };
    const mesh = await createMesh(
      t2,
      ['A', 'B', 'C'],
      [
        ['B', 'A'],
        ['C', 'B'],
      ],
      createStorage,
      { nodes: { B: { schema: strict } } },
    );
    const [a, b, c] = ['A', 'B', 'C'].map((name) => mesh.get(name));
    const errors = [];
    b.on('error', (error) => errors.push(error));
    const secret = await a.insert({ secret: true, $type: 'Post' });
    const plain = await a.insert({ plain: true, $type: 'Post' });
    await settle([a, b, c]);
    assert.strictEqual(await b.get(secret), null, 'B skipped it');
    assert.deepStrictEqual(await b.get(plain), { plain: true, $type: 'Post' });
    assert.deepStrictEqual(await c.get(secret), { secret: true, $type: 'Post' }, 'C, behind B, still got it');
    assert.deepStrictEqual(await c.get(plain), { plain: true, $type: 'Post' });
    assert.strictEqual(errors.length, 1);
  });

  await t.test('a validator that misbehaves is a ValidationError or a TypeError, never a silent write', async (t2) => {
    const Bad = standard(() => {
      throw new TypeError('kaput');
    });
    const NotObject = standard(() => ({ value: 'text' }));
    const entities = { Bad: { schema: Bad }, NotObject: { schema: NotObject } };
    const storage = await createStorage(t2, 'A', { schema: { entities } });
    const error = await storage.Bad.insert({}).catch((e) => e);
    assert.strictEqual(error.name, 'ValidationError');
    assert.strictEqual(error.cause.message, 'kaput');
    await assert.rejects(() => storage.NotObject.insert({}), {
      name: 'TypeError',
      message: /entity NotObject: the validator must return an object/,
    });
    assert.deepStrictEqual(await storage.list(), []);
    assert.strictEqual(storage.log.length, 0);
  });

  await t.test(
    'a metaschema-shaped entity needs no configuration: aliases, defaults, unknown keys, its own id',
    async (t2) => {
      const seen = [];
      const Project = metaschemaProject(seen);
      const storage = await createStorage(t2, 'A', { schema: { entities: { Project: { schema: Project } } } });
      const project = await storage.Project.insert({ title: 'T', slug: 's', orgId: 'o' });
      assert.deepStrictEqual(seen, [['projectId', 'title', 'slug', 'orgId']], 'the id goes under projectId');
      assert.deepStrictEqual(await storage.get(project.id), {
        name: 'T',
        slug: 's',
        orgId: 'o',
        desc: '',
        $type: 'Project',
      });
      const error = await storage.Project.insert({ name: 'T', slug: 's', orgId: 'o', extra: 1 }).catch((e) => e);
      assert.deepStrictEqual(error.issues, [{ path: [], message: 'has unexpected keys: extra', code: 'unexpected' }]);
      await assert.rejects(() => storage.Project.insert({ name: 'T' }), invalid('Project'));
      // A struct — fields but no id-like key — is handed no id.
      const Struct = {
        kind: 'struct',
        fields: { a: {} },
        '~standard': {
          version: 1,
          vendor: 'alexify.metaschema',
          validate: (input) => {
            seen.push(Object.keys(input));
            return { value: input };
          },
        },
      };
      const structs = await createStorage(t2, 'B', { schema: { entities: { Thing: { schema: Struct } } } });
      await structs.Thing.insert({ a: 1 });
      assert.deepStrictEqual(seen.at(-1), ['a']);
    },
  );

  await t.test('the schema version rides on every local op and on the record it writes', async (t2) => {
    const storage = await createStorage(t2, 'A', { schema: { version: 2, entities: { Post: {} } } });
    const ops = [];
    storage.on('change', (op) => ops.push(op));
    const seen = [];
    const plain = await createStorage(t2, 'B', { hooks: { beforeWrite: (ctx) => void seen.push(ctx.v) } });
    assert.deepStrictEqual(storage.schemaInfo, { version: 2, hash: null, previous: null, held: null });
    assert.strictEqual(plain.schemaInfo, null);
    const post = await storage.Post.insert({ title: 'a' });
    await storage.update(post.id, { title: 'b' });
    await storage.inc(post.id, 'hits');
    await storage.delete(post.id);
    assert.deepStrictEqual(
      ops.map((op) => [op.type, op.v]),
      [
        ['write', 2],
        ['set', 2],
        ['inc', 2],
        ['delete', 2],
      ],
    );
    const metaOf = async (target, id) => (await target.snapshot()).records.find((r) => r.id === id).meta;
    const alive = await storage.Post.insert({ title: 'c' });
    assert.strictEqual((await metaOf(storage, alive.id)).v, 2, 'the record remembers the version that wrote it');
    const id = await plain.insert({ n: 1 });
    assert.strictEqual(ops.at(-1).v, 2);
    assert.strictEqual('v' in (await metaOf(plain, id)), false, 'no schema, no version');
    assert.deepStrictEqual(seen, [null]);
    // A peer's version lands with its ops: a set leaves it, a write moves it.
    const stamp = () => Date.now() + 10_000;
    await storage.applyRemote([
      { origin: 'peer', seq: 1, ts: stamp(), type: 'set', id: alive.id, data: { n: 1 }, v: 3 },
    ]);
    assert.strictEqual((await metaOf(storage, alive.id)).v, 2);
    await storage.applyRemote([
      { origin: 'peer', seq: 2, ts: stamp(), type: 'write', id: alive.id, data: { n: 2 }, v: 3 },
    ]);
    assert.strictEqual((await metaOf(storage, alive.id)).v, 3);
    await storage.applyRemote([{ origin: 'peer', seq: 3, ts: stamp(), type: 'set', id: 'new', data: { n: 1 }, v: 3 }]);
    assert.strictEqual((await metaOf(storage, 'new')).v, 3, 'a set that creates the record takes its v');
    // A merge (bootstrap) carries the joined entry's own version.
    await plain.mergeSnapshot([{ id: alive.id, data: { n: 2 }, meta: await metaOf(storage, alive.id) }]);
    assert.strictEqual((await metaOf(plain, alive.id)).v, 3);
  });

  await t.test('schema.json remembers the version this directory ran; a change is schemaInfo.previous', async (t2) => {
    const warnings = [];
    const logger = { warn: (entry) => warnings.push(entry.event) };
    const v2 = { version: 2, entities: {}, snapshot: { entities: ['Post'] } };
    const first = await createStorage(t2, 'A', { schema: v2 });
    const { hash } = first.schemaInfo;
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.deepStrictEqual(first.schemaInfo, { version: 2, hash, previous: null, held: null });
    await first.close();
    const same = await createStorage(t2, 'A', { schema: v2 });
    assert.deepStrictEqual(same.schemaInfo.previous, null, 'the same version and snapshot: nothing to report');
    await same.close();
    const upgraded = await createStorage(t2, 'A', { schema: { ...v2, version: 3 }, logger });
    assert.deepStrictEqual(upgraded.schemaInfo.previous, { version: 2, hash });
    assert.deepStrictEqual(warnings, []);
    await upgraded.close();
    const changed = await createStorage(t2, 'A', { schema: { ...v2, version: 3, snapshot: { entities: [] } }, logger });
    assert.deepStrictEqual(changed.schemaInfo.previous, { version: 3, hash }, 'same version, other snapshot');
    assert.notStrictEqual(changed.schemaInfo.hash, hash);
    await changed.close();
    const downgraded = await createStorage(t2, 'A', { schema: v2, logger });
    assert.deepStrictEqual(downgraded.schemaInfo.previous, { version: 3, hash: changed.schemaInfo.hash });
    assert.deepStrictEqual(warnings, ['schema.upgrade'], 'a downgrade is warned about');
    await downgraded.close();
    const unversioned = await createStorage(t2, 'A', { schema: { entities: {} } });
    assert.deepStrictEqual(unversioned.schemaInfo, {
      version: 1,
      hash: null,
      previous: { version: 2, hash },
      held: null,
    });
    await unversioned.close();
    const none = await createStorage(t2, 'A');
    assert.strictEqual(none.schemaInfo, null, 'no schema: the file is left alone');
    await none.close();
    const back = await createStorage(t2, 'A', { schema: { entities: {} } });
    assert.deepStrictEqual(back.schemaInfo.previous, null);
  });

  await t.test('hello exchanges the schema; a host may refuse on it; drift is reported, never refused', async (t2) => {
    const snapshot = { entities: { Post: { title: 'string' } } };
    const other = { entities: { Post: { title: 'string', body: 'string' } } };
    const mesh = await createMesh(
      t2,
      ['A', 'B', 'C', 'D'],
      [
        ['A', 'B'],
        ['C', 'B'],
        ['D', 'B'],
      ],
      createStorage,
      {
        nodes: {
          A: { schema: { version: 2, snapshot } },
          B: { schema: { version: 2, snapshot } },
          C: { schema: { version: 2, snapshot: other } },
          D: { schema: { version: 3, snapshot: other } },
        },
      },
    );
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((name) => mesh.get(name));
    const drifts = { A: [], B: [], C: [], D: [] };
    for (const [name, storage] of [
      ['A', a],
      ['B', b],
      ['C', c],
      ['D', d],
    ]) {
      storage.on('schema', (event) => drifts[name].push(event));
    }
    await waitUntil(() => [a, c, d].every((s) => s.sync.peers()[0]?.subscribed));
    const id = await a.insert({ from: 'A', $type: 'Post' });
    await settle([a, b, c, d]);
    assert.deepStrictEqual(await c.get(id), { from: 'A', $type: 'Post' }, 'ops flow regardless');
    const [peerA] = a.sync.listNodes();
    assert.deepStrictEqual(peerA.remote.schema, { version: 2, hash: a.schemaInfo.hash });
    assert.strictEqual(a.schemaInfo.hash, b.schemaInfo.hash, 'the same snapshot hashes the same');
    assert.deepStrictEqual(drifts.A, []);
    assert.deepStrictEqual(drifts.D, [], 'another version is not drift');
    assert.deepStrictEqual(drifts.C, [
      {
        kind: 'drift',
        peer: { url: 'mem://B', node: b.nodeId },
        version: 2,
        hash: b.schemaInfo.hash,
        local: c.schemaInfo.hash,
      },
    ]);
    assert.deepStrictEqual(drifts.B, [
      {
        kind: 'drift',
        peer: { url: null, node: c.nodeId },
        version: 2,
        hash: c.schemaInfo.hash,
        local: b.schemaInfo.hash,
      },
    ]);
    // The hosting side sees it in hello, and `authorize` may act on it.
    const hellos = [];
    b.sync.on('hello', (event) => hellos.push(event));
    const strict = b.sync.unit({
      access: 'public',
      authorize: (context, hello) => hello.schema?.version === 2,
    });
    await new MemoryLink(strict).call('syncom/hello', { node: 'x', version: 1, schema: { version: 2, hash: null } });
    assert.deepStrictEqual(hellos, [{ node: 'x', scopes: ['*'], schema: { version: 2, hash: null }, kinds: null }]);
    await assert.rejects(
      () => new MemoryLink(strict).call('syncom/hello', { node: 'y', version: 1, schema: { version: 3, hash: 'h' } }),
      { code: 403 },
    );
    await assert.rejects(() => new MemoryLink(strict).call('syncom/hello', { node: 'z', version: 1 }), { code: 403 });
    // A dialer without a schema says so; a peer event carries what hello learned.
    const events = [];
    const plain = await createStorage(t2, 'P', {
      sync: { autoStart: false, connect: () => new MemoryLink(mesh.units.get('B')) },
    });
    plain.sync.on('peer', (event) => events.push(event));
    await plain.sync.addNode({ url: 'mem://B' });
    await plain.sync.start();
    await waitUntil(() => plain.sync.peers()[0]?.subscribed);
    assert.deepStrictEqual(
      events.find((e) => e.node),
      {
        url: 'mem://B',
        connected: true,
        node: b.nodeId,
        schema: { version: 2, hash: b.schemaInfo.hash },
      },
    );
    assert.deepStrictEqual(hellos.at(-1), { node: plain.nodeId, scopes: ['*'], schema: null, kinds: plain.kinds });
    assert.deepStrictEqual(drifts.B.length, 1, 'no schema on one side: nothing to compare');
  });

  // Two nodes on two versions. A (v1) writes `{ title }`; B (v2) reads it as
  // `{ name, desc }` through its lens — migrations, or the validator's alias
  // and default — and `migrate()` rewrites it for everyone.
  const aliasStub = standard(({ title, ...rest }) => {
    const value = { ...rest };
    if (value.name === undefined && title !== undefined) value.name = title;
    if (value.desc === undefined) value.desc = '';
    return { value };
  });
  const v2Variants = {
    migrations: {
      version: 2,
      entities: { Post: {} },
      migrations: { 2: { Post: { up: ({ title, ...rest }) => ({ ...rest, name: title, desc: rest.desc ?? '' }) } } },
    },
    validate: { version: 2, entities: { Post: { schema: aliasStub } } },
  };
  const metaOf = async (storage, id) => (await storage.snapshot()).records.find((r) => r.id === id).meta;

  for (const [variant, v2] of Object.entries(v2Variants)) {
    await t.test(
      `a newer node reads an older record through the lens (${variant}), and migrate() rewrites it`,
      async (t2) => {
        const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage, {
          nodes: { A: { schema: { entities: { Post: {} } } }, B: { schema: v2 } },
        });
        const [a, b] = ['A', 'B'].map((name) => mesh.get(name));
        const bOps = [];
        b.on('change', (op, via) => via === null && bOps.push(op));
        const aEvents = [];
        a.on('schema', (event) => aEvents.push(event));
        await waitUntil(() => a.sync.peers()[0]?.subscribed);
        const post = await a.Post.insert({ title: 'x' });
        await settle([a, b]);
        assert.deepStrictEqual(await b.get(post.id), { name: 'x', desc: '', $type: 'Post' }, 'lensed on read');
        assert.deepStrictEqual(
          (await b.snapshot()).records[0].data,
          { title: 'x', $type: 'Post' },
          'replication is raw',
        );
        assert.deepStrictEqual(b.getCachedData(post.id), { title: 'x', $type: 'Post' }, 'the cache peek is raw');
        const record = await b.record(post.id);
        assert.strictEqual(record.name, 'x', 'a Record view reads through the lens');
        assert.strictEqual(await b.swap(post.id, { desc: 'swapped' }, { name: 'x' }), true, 'swap compares the view');
        await settle([a, b]);
        // A set is validated through the lens and carries only what changed.
        const refreshed = new Promise((resolve) => record.once('update', () => resolve()));
        await b.Post.update(post.id, { desc: 'd' });
        await refreshed;
        assert.deepStrictEqual(
          [record.name, record.desc, record.title],
          ['x', 'd', undefined],
          'the Record stays lensed',
        );
        assert.deepStrictEqual(bOps.at(-1).data, { desc: 'd' });
        await settle([a, b]);
        assert.deepStrictEqual(await a.get(post.id), { title: 'x', desc: 'd', $type: 'Post' }, 'A keeps its shape');
        assert.deepStrictEqual(await b.get(post.id), { name: 'x', desc: 'd', $type: 'Post' });
        assert.strictEqual((await metaOf(b, post.id)).v, 1, 'a set does not move the record’s version');
        await a.inc(post.id, 'hits', 3);
        await a.add(post.id, 'tags', ['t']);
        await a.treeMove(post.id, 'outline', 'n1');
        await a.treeMove(post.id, 'outline', 'n2', 'n1');
        await settle([a, b]);
        assert.strictEqual((await b.get(post.id)).hits, 3);
        assert.deepStrictEqual((await b.get(post.id)).tags, ['t']);
        // migrate(): a whole-record write of the view (v2, no `title`), then
        // the counter and the set added back.
        const before = bOps.length;
        assert.deepStrictEqual(await b.migrate({ batch: 1 }), {
          migrated: 1,
          counters: 1,
          sets: 1,
          lists: 0,
          texts: 0,
          trees: 1,
        });
        const [write, inc, add, n1, n2] = bOps.slice(before);
        assert.deepStrictEqual(
          [n1.type, n1.value.node, n1.value.parent, n2.type, n2.value.node, n2.value.parent],
          ['tree', 'n1', null, 'tree', 'n2', 'n1'],
          'a tree comes back as one move per node, parents first',
        );
        assert.deepStrictEqual(
          [write.type, write.v, write.data],
          ['write', 2, { name: 'x', desc: 'd', $type: 'Post' }],
        );
        assert.deepStrictEqual([inc.type, inc.key, inc.value], ['inc', 'hits', 3]);
        assert.deepStrictEqual([add.type, add.key, add.value], ['add', 'tags', ['t']]);
        const outline = [{ id: 'n1', children: [{ id: 'n2', children: [] }] }];
        const migrated = { name: 'x', desc: 'd', hits: 3, tags: ['t'], outline, $type: 'Post' };
        assert.deepStrictEqual(await b.get(post.id), migrated);
        assert.strictEqual((await metaOf(b, post.id)).v, 2);
        await settle([a, b]);
        assert.deepStrictEqual(await a.get(post.id), migrated, 'A applies v2 ops as they are');
        assert.strictEqual((await metaOf(a, post.id)).v, 2);
        // Every v2 op B made — its swap, its update, the migration's write and inc — was ahead of A.
        assert.deepStrictEqual(
          aEvents.map((event) => [event.kind, event.held, event.op.type]),
          [
            ['ahead', false, 'set'],
            ['ahead', false, 'set'],
            ['ahead', false, 'write'],
            ['ahead', false, 'inc'],
            ['ahead', false, 'add'],
            ['ahead', false, 'tree'],
            ['ahead', false, 'tree'],
          ],
        );
        assert.deepStrictEqual(
          await b.migrate(),
          { migrated: 0, counters: 0, sets: 0, lists: 0, texts: 0, trees: 0 },
          'idempotent',
        );
        // A record B writes itself is of its version and never lensed.
        const fresh = await b.Post.insert({ name: 'fresh' });
        assert.strictEqual((await metaOf(b, fresh.id)).v, 2);
        assert.deepStrictEqual(await b.migrate({ entities: ['Other'] }), {
          migrated: 0,
          counters: 0,
          sets: 0,
          lists: 0,
          texts: 0,
          trees: 0,
        });
      },
    );
  }

  await t.test('lens options: which steps read an older record, what a migration may return', async (t2) => {
    const v1 = { entities: { Post: {} } };
    const migrations = { 2: { up: (data) => ({ ...data, v2: true }) } };
    // 'migrations' alone: the alias stub is not consulted on read.
    const mesh = await createMesh(
      t2,
      ['A', 'B', 'C', 'D'],
      [
        ['A', 'B'],
        ['A', 'C'],
        ['A', 'D'],
      ],
      createStorage,
      {
        nodes: {
          A: { schema: v1 },
          B: { schema: { version: 2, entities: { Post: { schema: aliasStub } }, lens: 'migrations', migrations } },
          C: { schema: { version: 2, entities: { Post: { schema: aliasStub } }, lens: 'validate' } },
          D: { schema: { version: 2, entities: { Post: {} }, migrations } },
        },
      },
    );
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((name) => mesh.get(name));
    await waitUntil(() => a.sync.peers().every((peer) => peer.subscribed));
    const post = await a.Post.insert({ title: 'x' });
    const loose = await a.insert({ n: 1 });
    await settle([a, b, c, d]);
    assert.deepStrictEqual(await b.get(post.id), { title: 'x', v2: true, $type: 'Post' }, 'migrations only');
    assert.deepStrictEqual(await c.get(post.id), { name: 'x', desc: '', $type: 'Post' }, 'validate only');
    assert.deepStrictEqual(
      await d.get(loose),
      { n: 1, v2: true },
      'a storage-wide migration reaches records without $type',
    );
    assert.deepStrictEqual(await b.get(loose), { n: 1, v2: true });
    // A validator that refuses an old record (written before it existed)
    // leaves the migrated data, at debug.
    const debug = [];
    const strict = standard((value) =>
      value.slug ? { value } : { issues: [issue('is required', ['slug'], 'required')] },
    );
    const old = await createStorage(t2, 'E', { schema: { entities: { Post: {} } } });
    await old.set('p', { title: 'x', $type: 'Post' });
    await old.set('q', { title: 'y', slug: 'q', $type: 'Post' });
    await old.close();
    const e = await createStorage(t2, 'E', {
      schema: {
        version: 2,
        entities: { Post: { schema: strict } },
        migrations: { 2: { Post: { up: (data) => ({ ...data, up: 1 }) } } },
      },
      logger: { debug: (entry) => debug.push(entry) },
    });
    assert.deepStrictEqual(await e.get('p'), { title: 'x', up: 1, $type: 'Post' });
    assert.deepStrictEqual(await e.get('q'), { title: 'y', slug: 'q', up: 1, $type: 'Post' });
    // migrate() goes through the validator: the record it refuses stops the run.
    await assert.rejects(() => e.migrate({ batch: 1 }), { name: 'ValidationError', entity: 'Post' });
    assert.strictEqual((await metaOf(e, 'q')).v, 1, 'p came first; q was not reached');
    assert.deepStrictEqual(await e.migrate({ entities: ['Nope'], batch: 1 }), {
      migrated: 0,
      counters: 0,
      sets: 0,
      lists: 0,
      texts: 0,
      trees: 0,
    });
    assert.deepStrictEqual(
      debug.filter((entry) => entry.event === 'schema.lens.issues').map((entry) => [entry.entity, entry.id]),
      [['Post', 'p']],
    );
    // A migration must return an object.
    const bad = await createStorage(t2, 'F', { schema: { version: 2, migrations: { 2: { up: () => 'nope' } } } });
    await bad.applyRemote([{ origin: 'old', seq: 1, ts: Date.now(), type: 'write', id: 'p', data: { n: 1 }, v: 1 }]);
    await assert.rejects(() => bad.get('p'), { name: 'TypeError', message: /migrations\[2\] must return an object/ });
    // Refused at open.
    await assert.rejects(() => createStorage(t2, 'G', { schema: { version: 2, lens: 'validate', migrations } }), {
      name: 'TypeError',
      message: /lens 'validate' skips the migrations/,
    });
    await assert.rejects(
      () => createStorage(t2, 'G2', { schema: { ahead: 'maybe' } }),
      /ahead must be 'apply' or 'hold'/,
    );
    await assert.rejects(() => createStorage(t2, 'G3', { schema: { lens: 'none' } }), /lens must be/);
    await assert.rejects(
      () => createStorage(t2, 'G4', { schema: { version: 2, migrations: { 3: { up: () => ({}) } } } }),
      /beyond version 2/,
    );
    await assert.rejects(
      () => createStorage(t2, 'G5', { schema: { version: 2, migrations: { 1: { up: () => ({}) } } } }),
      /not a version of 2 or more/,
    );
    await assert.rejects(
      () => createStorage(t2, 'G6', { schema: { version: 2, migrations: { 2: 'up' } } }),
      /must be \{ up \}/,
    );
    await assert.rejects(
      () => createStorage(t2, 'G7', { schema: { version: 2, migrations: { 2: { Post: 'up' } } } }),
      /migrations\[2\].Post must be/,
    );
    await assert.rejects(
      () => createStorage(t2, 'G8', { schema: { version: 2, migrations: [] } }),
      /migrations must be an object/,
    );
    await assert.rejects(
      () => createStorage(t2, 'G9', { schema: { ahead: 'hold' }, sync: { retention: { ops: 10 } } }),
      /ahead 'hold' needs sync.retention.ops of 1000 or more/,
    );
    const kept = await createStorage(t2, 'G10', { schema: { ahead: 'hold' }, sync: { retention: { ops: 0 } } });
    assert.strictEqual(kept.schemaInfo.held, null, "retention.ops 0 keeps everything, so 'hold' is fine");
    await assert.rejects(() => e.migrate({ entities: 'Post' }), TypeError);
    await assert.rejects(() => e.migrate({ batch: 0 }), TypeError);
    assert.deepStrictEqual(
      await a.migrate(),
      { migrated: 0, counters: 0, sets: 0, lists: 0, texts: 0, trees: 0 },
      'version 1: nothing older to migrate',
    );
    const none = await createStorage(t2, 'N');
    await assert.rejects(() => none.migrate(), { name: 'TypeError', message: 'migrate() needs open({ schema })' });
  });

  await t.test(
    "ahead 'hold': an op from a newer version waits in the log, relays, and lands on the upgrade",
    async (t2) => {
      const v2 = { version: 2, entities: { Post: {} } };
      const mesh = await createMesh(
        t2,
        ['A', 'B', 'C'],
        [
          ['B', 'A'],
          ['C', 'B'],
        ],
        createStorage,
        {
          nodes: {
            A: { schema: v2 },
            B: { schema: { version: 1, entities: { Post: {} }, ahead: 'hold' } },
            C: { schema: v2 },
          },
        },
      );
      const [a, b, c] = ['A', 'B', 'C'].map((name) => mesh.get(name));
      const events = [];
      b.on('schema', (event) => events.push(event));
      await waitUntil(() => b.sync.peers()[0]?.subscribed && c.sync.peers()[0]?.subscribed);
      const post = await a.Post.insert({ n: 1 });
      await settle([a, b, c]);
      assert.strictEqual(await b.get(post.id), null, 'held, not applied');
      assert.strictEqual(b.vector[a.nodeId], 1, 'but the vector moved');
      assert.deepStrictEqual(
        b.log.held().map((entry) => [entry.op.type, entry.held, entry.skipped]),
        [['write', 2, true]],
      );
      assert.deepStrictEqual(await c.get(post.id), { n: 1, $type: 'Post' }, 'C, behind B, received it');
      assert.deepStrictEqual(
        events.map((event) => [event.kind, event.held, event.op.id]),
        [['ahead', true, post.id]],
      );
      // B's own writes are of version 1 and land as usual.
      await b.Post.set('mine', { mine: true });
      assert.deepStrictEqual(await b.get('mine'), { mine: true, $type: 'Post' });
      // B upgrades: the held op is applied as if it had just arrived.
      await c.sync.stop();
      await b.close();
      const upgraded = await createStorage(t2, 'B', { schema: v2 });
      assert.deepStrictEqual(upgraded.schemaInfo.held, { replayed: 1, lost: 0 });
      assert.deepStrictEqual(upgraded.schemaInfo.previous, { version: 1, hash: null });
      assert.deepStrictEqual(await upgraded.get(post.id), { n: 1, $type: 'Post' });
      assert.deepStrictEqual(await upgraded.get('mine'), { mine: true, $type: 'Post' });
      assert.deepStrictEqual(
        await upgraded.repair(post.id),
        { ops: 1, alive: true },
        'a held op this node has since applied counts for repair()',
      );
      assert.deepStrictEqual(await upgraded.get(post.id), { n: 1, $type: 'Post' });
      await upgraded.close();
      const again = await createStorage(t2, 'B', { schema: v2 });
      assert.deepStrictEqual(
        again.schemaInfo.held,
        { replayed: 0, lost: 0 },
        'a held op stays flagged, re-applied as a no-op',
      );
      assert.deepStrictEqual(await again.get(post.id), { n: 1, $type: 'Post' });
      await again.close();
      await assert.rejects(() => createStorage(t2, 'B', { schema: { version: 1, ahead: 'hold' } }), {
        name: 'SyncomError',
        code: 'DOWNGRADE',
        message: /ahead 'hold' cannot downgrade/,
      });
      const noHeld = await createStorage(t2, 'B', { schema: { version: 1 } });
      assert.strictEqual(noHeld.schemaInfo.held, null, 'nothing held for version 1');
    },
  );
};

module.exports = { runSchemaTests };
