'use strict';

// Entity definitions and validation, against whichever storage half the
// caller builds: `createStorage(t, name, options)` gives the SAME directory
// for the same name within one subtest (reopen cases).

const { createMesh, settle } = require('../utils/mesh.js');

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
    assert.deepStrictEqual(result, { applied: 3, skipped: 1, duplicates: 0, gaps: 0 });
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
    assert.deepStrictEqual(later, { applied: 1, skipped: 1, duplicates: 0, gaps: 0 });
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
};

module.exports = { runSchemaTests };
