'use strict';

// The schema layer in isolation: definitions normalized at open, the three
// validator shapes reduced to one, ids and indexes read off a schema object,
// and the projection a validator sees / the fold of what it returns.

const test = require('node:test');
const assert = require('node:assert');
const { ValidationError } = require('../src/errors.js');
const {
  normalizeSchema,
  normalizeValidator,
  deriveIdField,
  derivedIndexes,
  toIssues,
} = require('../src/schema/define.js');
const { createLens } = require('../src/schema/lens.js');
const { project, unproject, foldSet } = require('../src/schema/entity.js');

const standard = (validate) => ({ '~standard': { version: 1, vendor: 'test', validate } });
const typeError = (message) => ({ name: 'TypeError', message });

test('ValidationError', async (t) => {
  await t.test('names the entity and the first issue, counts the rest', () => {
    const error = new ValidationError('Post', [
      { path: ['title'], message: 'is required', code: 'required' },
      { path: [], message: 'too big' },
    ]);
    assert.ok(error instanceof Error);
    assert.strictEqual(error.name, 'ValidationError');
    assert.strictEqual(error.code, 'VALIDATION_FAILED');
    assert.strictEqual(error.entity, 'Post');
    assert.strictEqual(error.message, 'Post failed validation at title: is required (+1 more)');
    assert.strictEqual(error.issues.length, 2);
    assert.strictEqual(
      new ValidationError(null, [{ path: [], message: 'bad' }]).message,
      'Record failed validation: bad',
    );
    assert.strictEqual(new ValidationError('Post', []).message, 'Post failed validation');
  });
});

test('normalizeSchema', async (t) => {
  await t.test('no schema is one version and no entities', () => {
    for (const schema of [undefined, null]) {
      const { version, entities } = normalizeSchema(schema);
      assert.strictEqual(version, 1);
      assert.strictEqual(entities.size, 0);
    }
  });

  await t.test('a bare entity: no validator, id under `id`, no indexes', () => {
    const { version, entities } = normalizeSchema({ version: 3, entities: { Post: {} } });
    assert.strictEqual(version, 3);
    assert.deepStrictEqual(entities.get('Post'), {
      name: 'Post',
      schema: undefined,
      standard: false,
      validator: null,
      idField: 'id',
      index: [],
      unique: [],
      fields: null,
      search: [],
    });
  });

  await t.test('search fields are explicit, deduplicated, and checked', () => {
    const { entities } = normalizeSchema({ entities: { Post: { search: ['title', 'body', 'title'] } } });
    assert.deepStrictEqual(entities.get('Post').search, ['title', 'body']);
    assert.throws(
      () => normalizeSchema({ entities: { Post: { search: 'title' } } }),
      /search must be an array of field names/,
    );
    assert.throws(
      () => normalizeSchema({ entities: { Post: { search: [''] } } }),
      /search must be an array of field names/,
    );
    assert.throws(
      () => normalizeSchema({ entities: { Post: { search: [1] } } }),
      /search must be an array of field names/,
    );
  });

  await t.test('entities may be a Map, and keep `fields` as given', () => {
    const fields = { title: 'string' };
    const { entities } = normalizeSchema({ entities: new Map([['Post', { fields }]]) });
    assert.strictEqual(entities.get('Post').fields, fields);
  });

  await t.test('the shape is checked at open, with TypeErrors that name the problem', () => {
    assert.throws(() => normalizeSchema('nope'), typeError('open({ schema }): schema must be an object'));
    assert.throws(() => normalizeSchema({ lenses: {} }), typeError("open({ schema }): unknown key 'lenses'"));
    for (const version of [0, -1, 1.5, '2', null]) {
      assert.throws(
        () => normalizeSchema({ version }),
        typeError('open({ schema }): version must be a positive integer'),
        String(version),
      );
    }
    assert.throws(() => normalizeSchema({ entities: 'Post' }), /entities must be an object or a Map/);
    assert.throws(() => normalizeSchema({ entities: { '': {} } }), /entity names must be non-empty strings/);
    assert.throws(() => normalizeSchema({ entities: { Post: 'string' } }), /entity Post: must be an object/);
    assert.throws(
      () => normalizeSchema({ entities: { Post: { uniqe: ['slug'] } } }),
      typeError(
        "open({ schema }): entity Post: unknown key 'uniqe' (expected schema, idField, validate, index, unique, fields, search)",
      ),
    );
    assert.throws(() => normalizeSchema({ entities: { Post: { validate: true } } }), /validate may only be false/);
    assert.throws(() => normalizeSchema({ entities: { Post: { fields: 'title' } } }), /fields must be an object/);
    for (const idField of [1, '', null, true]) {
      assert.throws(
        () => normalizeSchema({ entities: { Post: { idField } } }),
        /idField must be a field name or false/,
      );
    }
    assert.throws(
      () => normalizeSchema({ entities: { Post: { index: 'orgId' } } }),
      /index must be an array of field names/,
    );
    assert.throws(
      () => normalizeSchema({ entities: { Post: { index: [''] } } }),
      /index must be an array of field names/,
    );
    assert.throws(() => normalizeSchema({ entities: { Post: { unique: 'slug' } } }), /unique must be an array/);
    assert.throws(() => normalizeSchema({ entities: { Post: { unique: [1] } } }), /field names and arrays of them/);
    assert.throws(() => normalizeSchema({ entities: { Post: { unique: [[]] } } }), /field names and arrays of them/);
    assert.throws(() => normalizeSchema({}, { validator: {} }), /validator must have a compile\(\) method/);
    assert.throws(() => normalizeSchema({}, { validator: 'ajv' }), /validator must have a compile\(\) method/);
  });

  await t.test('explicit indexes: deduplicated, unique keys as field lists', () => {
    const { entities } = normalizeSchema({
      entities: { Post: { index: ['orgId', 'orgId', 'kind'], unique: ['slug', ['orgId', 'name'], 'slug'] } },
    });
    assert.deepStrictEqual(entities.get('Post').index, ['orgId', 'kind']);
    assert.deepStrictEqual(entities.get('Post').unique, [['slug'], ['orgId', 'name']]);
  });

  await t.test('indexes come off a metaschema-shaped schema when not given', () => {
    const schema = {
      fields: {
        orgId: { type: 'string' },
        email: { type: 'string', unique: true },
        kind: { type: 'string', index: true },
        count: () => 0,
        postId: { type: 'string', required: false },
      },
      indexes: {
        byOrg: { index: ['orgId', 'kind'] },
        bySlug: { unique: ['slug'] },
        byOrgName: { unique: ['orgId', 'name'] },
        pk: { primary: ['code'] },
        'tags?': { many: 'Tag' },
        odd: 'nope',
        empty: { index: [] },
      },
    };
    const { entities } = normalizeSchema({ entities: { Post: { schema, validate: false } } });
    const def = entities.get('Post');
    assert.deepStrictEqual(def.index, ['orgId', 'kind', 'code']);
    assert.deepStrictEqual(def.unique, [['slug'], ['orgId', 'name'], ['email']]);
    assert.strictEqual(def.idField, 'postId');
    assert.strictEqual(def.validator, null, 'validate: false');
    assert.strictEqual(def.schema, schema);
    // Each of `index` and `unique` is overridden on its own.
    const explicit = normalizeSchema({ entities: { Post: { schema, validate: false, index: ['kind'] } } });
    assert.deepStrictEqual(explicit.entities.get('Post').index, ['kind']);
    assert.deepStrictEqual(explicit.entities.get('Post').unique, [['slug'], ['orgId', 'name'], ['email']]);
    assert.deepStrictEqual(derivedIndexes('nope'), { index: new Set(), unique: [] });
  });

  await t.test('a schema object without ~standard needs validator.compile, or validate: false', () => {
    const json = { type: 'object' };
    assert.throws(
      () => normalizeSchema({ entities: { Post: { schema: json } } }),
      typeError(
        'open({ schema }): entity Post: a schema without ~standard needs open({ validator }) or validate: false',
      ),
    );
    assert.throws(
      () => normalizeSchema({ entities: { Post: { schema: null } } }),
      /schema must be an object or a function/,
    );
    assert.throws(
      () => normalizeSchema({ entities: { Post: { schema: 'string' } } }),
      /schema must be an object or a function/,
    );
    const calls = [];
    const validator = {
      compile(schema, meta) {
        calls.push([schema, meta, this === validator]);
        return () => true;
      },
    };
    const { entities } = normalizeSchema({ entities: { Post: { schema: json }, Tag: {} } }, { validator });
    assert.deepStrictEqual(calls, [[json, { entity: 'Post' }, true]]);
    assert.strictEqual(typeof entities.get('Post').validator, 'function');
    assert.strictEqual(entities.get('Post').standard, false);
    assert.throws(
      () => normalizeSchema({ entities: { Post: { schema: json } } }, { validator: { compile: () => 'nope' } }),
      typeError('open({ schema }): entity Post: validator.compile() must return a function'),
    );
  });

  await t.test('a ~standard property must carry validate()', () => {
    assert.throws(
      () => normalizeSchema({ entities: { Post: { schema: { '~standard': { version: 1 } } } } }),
      typeError('open({ schema }): entity Post: ~standard has no validate()'),
    );
    const { entities } = normalizeSchema({ entities: { Post: { schema: standard((v) => ({ value: v })) } } });
    assert.strictEqual(entities.get('Post').standard, true);
    assert.strictEqual(typeof entities.get('Post').validator, 'function');
  });
});

test('createLens', async (t) => {
  const quiet = { debug() {} };
  const lensOf = (schema, logger = quiet) => createLens(normalizeSchema(schema), logger);

  await t.test('runs the up-chain from the record’s version, per entity or storage-wide, in order', async () => {
    const calls = [];
    const lens = lensOf({
      version: 4,
      entities: { Post: {}, Tag: {} },
      migrations: {
        2: {
          up: (data, ctx) => {
            calls.push(['2', ctx]);
            return { ...data, two: true };
          },
        },
        3: {
          Post: {
            up: (data, ctx) => {
              calls.push(['3.Post', ctx]);
              return { ...data, three: true };
            },
          },
        },
        4: { Tag: { up: (data) => ({ ...data, four: true }) } },
      },
    });
    assert.deepStrictEqual(await lens('p', { $type: 'Post', title: 'x' }, 1), {
      title: 'x',
      two: true,
      three: true,
      $type: 'Post',
    });
    assert.deepStrictEqual(calls, [
      ['2', { entity: 'Post', id: 'p', from: 1, to: 2 }],
      ['3.Post', { entity: 'Post', id: 'p', from: 2, to: 3 }],
    ]);
    assert.deepStrictEqual(await lens('t', { $type: 'Tag', n: 1 }, 2), { n: 1, four: true, $type: 'Tag' });
    assert.deepStrictEqual(await lens('x', { n: 1 }, 1), { n: 1, two: true }, 'no $type: the storage-wide step only');
    assert.deepStrictEqual(await lens('x', { n: 1, $type: 'Nope' }, 3), { n: 1, $type: 'Nope' });
    await assert.rejects(() => lensOf({ version: 2, migrations: { 2: { up: () => null } } })('x', { n: 1 }, 1), {
      name: 'TypeError',
      message: 'open({ schema }): migrations[2] must return an object (x)',
    });
  });

  await t.test('then the entity’s Standard Schema validator; its issues leave the migrated data', async () => {
    const debug = [];
    const Post = standard((value) =>
      value.slug === undefined
        ? { issues: [{ message: 'is required', path: ['slug'] }] }
        : { value: { ...value, status: value.status ?? 'draft' } },
    );
    const lens = lensOf(
      {
        version: 2,
        entities: { Post: { schema: Post } },
        migrations: { 2: { Post: { up: ({ title, ...rest }) => ({ ...rest, name: title }) } } },
      },
      { debug: (entry) => debug.push(entry) },
    );
    assert.deepStrictEqual(await lens('p', { $type: 'Post', title: 'x', slug: 's' }, 1), {
      name: 'x',
      slug: 's',
      status: 'draft',
      $type: 'Post',
    });
    assert.deepStrictEqual(await lens('p', { $type: 'Post', title: 'x' }, 1), { name: 'x', $type: 'Post' });
    assert.deepStrictEqual(debug, [
      { event: 'schema.lens.issues', entity: 'Post', id: 'p', issues: [{ path: ['slug'], message: 'is required' }] },
    ]);
    // A function validator is not a lens: it has no aliases or defaults to offer.
    const fn = lensOf({ version: 2, entities: { Post: { schema: () => ({ added: true }) } } });
    assert.deepStrictEqual(await fn('p', { $type: 'Post', title: 'x' }, 1), { title: 'x', $type: 'Post' });
    // `lens` picks the steps.
    const only = lensOf({ version: 2, entities: { Post: { schema: Post } }, lens: 'validate' });
    assert.deepStrictEqual(await only('p', { $type: 'Post', slug: 's' }, 1), {
      slug: 's',
      status: 'draft',
      $type: 'Post',
    });
    const none = lensOf({ version: 2, entities: { Post: { schema: Post } }, lens: 'migrations' });
    assert.deepStrictEqual(await none('p', { $type: 'Post', slug: 's' }, 1), { slug: 's', $type: 'Post' });
  });

  await t.test('normalizeSchema reads migrations, ahead and lens', () => {
    const up = () => ({});
    const { migrations, ahead, lens } = normalizeSchema({
      version: 3,
      migrations: { 2: { up }, 3: { Post: { up, down: up } } },
    });
    assert.deepStrictEqual([...migrations.keys()], [2, 3]);
    assert.deepStrictEqual(migrations.get(2), { up });
    assert.deepStrictEqual([...migrations.get(3).entries()], [['Post', { up }]]);
    assert.deepStrictEqual([ahead, lens], ['apply', 'both']);
    assert.deepStrictEqual(normalizeSchema({ ahead: 'hold', lens: 'migrations' }).ahead, 'hold');
    assert.deepStrictEqual(normalizeSchema(null).migrations, null);
    assert.throws(() => normalizeSchema({ version: 2, migrations: { 2: { up, down: 'x' } } }), /must be \{ up \}/);
    assert.throws(() => normalizeSchema({ version: 2, migrations: { 2.5: { up } } }), /not a version of 2 or more/);
  });
});

test('deriveIdField', async (t) => {
  await t.test(
    '`id` when the schema has it, `<entity>Id` when it has that, else false; `id` when it shows nothing',
    () => {
      assert.strictEqual(deriveIdField({ fields: { id: {}, title: {} } }, 'Post'), 'id');
      assert.strictEqual(deriveIdField({ fields: { postId: {}, title: {} } }, 'Post'), 'postId');
      assert.strictEqual(deriveIdField({ fields: { title: {} } }, 'Post'), false);
      assert.strictEqual(deriveIdField({ shape: { id: {} } }, 'Post'), 'id', 'zod');
      assert.strictEqual(deriveIdField({ entries: { postId: {} } }, 'Post'), 'postId', 'valibot');
      assert.strictEqual(deriveIdField({ fields: { uRLShortenerId: {} } }, 'URLShortener'), 'uRLShortenerId');
      assert.strictEqual(
        deriveIdField(() => true, 'Post'),
        'id',
      );
      assert.strictEqual(deriveIdField({ type: 'object' }, 'Post'), 'id');
      assert.strictEqual(deriveIdField(undefined, 'Post'), 'id');
      assert.strictEqual(deriveIdField({ fields: 'nope', shape: null }, 'Post'), 'id');
    },
  );
});

test('normalizeValidator', async (t) => {
  const invalid = (entity, issues) => ({ name: 'ValidationError', entity, issues });

  await t.test('Standard Schema: { value } passes through, { issues } throws, sync or async', async () => {
    const sync = normalizeValidator(
      standard((v) => (v.ok ? { value: { ...v, seen: true } } : { issues: [{ message: 'not ok', path: ['ok'] }] })),
      'Post',
    );
    assert.deepStrictEqual(await sync({ ok: true }), { ok: true, seen: true });
    await assert.rejects(() => sync({ ok: false }), invalid('Post', [{ path: ['ok'], message: 'not ok' }]));
    const async = normalizeValidator(
      standard(async (v) => (v.ok ? { value: v } : { issues: [{ message: 'later' }] })),
      'Post',
    );
    assert.deepStrictEqual(await async({ ok: true }), { ok: true });
    await assert.rejects(() => async({ ok: false }), invalid('Post', [{ path: [], message: 'later' }]));
  });

  await t.test('issues are normalized: { key } segments, symbols, codes, odd shapes', async () => {
    const validate = normalizeValidator(
      standard(() => ({
        issues: [
          { message: 'deep', path: [{ key: 'a' }, 0, { key: Symbol('s') }], code: 'type' },
          { message: 'no path' },
          'just text',
          { path: ['x'] },
        ],
      })),
      'Post',
    );
    await assert.rejects(
      () => validate({}),
      invalid('Post', [
        { path: ['a', 0, 'Symbol(s)'], message: 'deep', code: 'type' },
        { path: [], message: 'no path' },
        { path: [], message: 'just text' },
        { path: ['x'], message: 'invalid' },
      ]),
    );
    assert.deepStrictEqual(toIssues([]), [{ path: [], message: 'invalid' }]);
    assert.deepStrictEqual(toIssues('nope'), [{ path: [], message: 'invalid' }]);
    await assert.rejects(
      () =>
        normalizeValidator(
          standard(() => ({ issues: [] })),
          'Post',
        )({}),
      invalid('Post', [{ path: [], message: 'invalid' }]),
    );
  });

  await t.test('a validate that returns no result, or throws, is a ValidationError too', async () => {
    await assert.rejects(
      () =>
        normalizeValidator(
          standard(() => undefined),
          'Post',
        )({}),
      invalid('Post', [{ path: [], message: 'the validator returned no result' }]),
    );
    const cause = new TypeError('boom');
    const error = await normalizeValidator(
      standard(() => {
        throw cause;
      }),
      'Post',
    )({}).catch((e) => e);
    assert.strictEqual(error.name, 'ValidationError');
    assert.strictEqual(error.cause, cause);
    assert.deepStrictEqual(error.issues, [{ path: [], message: 'boom' }]);
    const text = await normalizeValidator(
      standard(() => {
        // oxlint-disable-next-line no-throw-literal -- the hostile case
        throw 'text';
      }),
      'Post',
    )({}).catch((e) => e);
    assert.deepStrictEqual(text.issues, [{ path: [], message: 'text' }]);
  });

  await t.test('a function: ajv-style false + errors, assertions, transformers, async rejections', async () => {
    const ajv = (data) => {
      if (data.ok) return true;
      ajv.errors = [{ instancePath: '/a/0/x~1y', message: 'must be ok', keyword: 'const' }, { message: 'other' }];
      return false;
    };
    const validate = normalizeValidator(ajv, 'Post');
    const data = { ok: true };
    assert.strictEqual(await validate(data), data, 'true gives the data back, the same reference');
    await assert.rejects(
      () => validate({ ok: false }),
      invalid('Post', [
        { path: ['a', '0', 'x/y'], message: 'must be ok', code: 'const' },
        { path: [], message: 'other' },
      ]),
    );
    const bare = () => false;
    await assert.rejects(
      () => normalizeValidator(bare, 'Post')({}),
      invalid('Post', [{ path: [], message: 'invalid' }]),
    );
    assert.strictEqual(await normalizeValidator(() => undefined, 'Post')(data), data, 'an assertion that passed');
    assert.deepStrictEqual(await normalizeValidator((v) => ({ ...v, n: 1 }), 'Post')(data), { ok: true, n: 1 });
    assert.deepStrictEqual(await normalizeValidator(async (v) => ({ ...v, n: 2 }), 'Post')(data), { ok: true, n: 2 });
    await assert.rejects(
      () =>
        normalizeValidator(async () => {
          throw Object.assign(new Error('async ajv'), { errors: [{ instancePath: '', message: 'nope' }] });
        }, 'Post')({}),
      invalid('Post', [{ path: [], message: 'nope' }]),
    );
    const own = new ValidationError('Post', [{ path: ['k'], message: 'mine' }]);
    const rethrown = await normalizeValidator(() => {
      throw own;
    }, 'Post')({}).catch((e) => e);
    assert.strictEqual(rethrown, own, 'a ValidationError of the validator’s own is kept');
    const wrapped = await normalizeValidator(() => {
      throw new RangeError('out of range');
    }, 'Post')({}).catch((e) => e);
    assert.strictEqual(wrapped.name, 'ValidationError');
    assert.strictEqual(wrapped.cause.name, 'RangeError');
  });
});

test('project, unproject, foldSet', async (t) => {
  const def = { name: 'Post', idField: 'postId' };

  await t.test('the validator sees the record under its id field and without $type', () => {
    assert.deepStrictEqual(project(def, 'p1', { $type: 'Post', title: 'a' }), { postId: 'p1', title: 'a' });
    assert.deepStrictEqual(project(def, null, { title: 'a' }), { title: 'a' });
    assert.deepStrictEqual(project({ idField: false }, 'p1', { title: 'a' }), { title: 'a' });
  });

  await t.test('what it returns comes back without the id field, with $type, as JSON', () => {
    const when = new Date(0);
    assert.deepStrictEqual(unproject(def, { postId: 'p1', $type: 'Nope', title: 'a', when, gone: undefined }, 'Post'), {
      title: 'a',
      when: when.toISOString(),
      $type: 'Post',
    });
    assert.throws(() => unproject(def, 'text', 'Post'), /entity Post: the validator must return an object/);
    assert.throws(() => unproject(def, null, 'Post'), TypeError);
  });

  await t.test('a set keeps the delta’s keys as validated plus the keys the record lacked', () => {
    const projected = { postId: 'p1', name: 'old', status: 'draft', extra: 1 };
    const validated = { name: 'old', status: 'published', createdAt: 't', $type: 'Post' };
    // `status` is in the delta (validated form), `createdAt` is new (a
    // default), `name` is outside the delta, `extra` was stripped.
    assert.deepStrictEqual(foldSet({ status: 'published', extra: 1 }, validated, projected), {
      status: 'published',
      createdAt: 't',
    });
    assert.deepStrictEqual(foldSet({ extra: 1 }, { name: 'old', $type: 'Post' }, projected), {});
    // A key outside the delta whose validated value changed (a lens rename) is carried too.
    assert.deepStrictEqual(
      foldSet({ desc: 'd' }, { name: 'new', desc: 'd', $type: 'Post' }, { name: 'old', desc: '' }),
      {
        name: 'new',
        desc: 'd',
      },
    );
  });
});
