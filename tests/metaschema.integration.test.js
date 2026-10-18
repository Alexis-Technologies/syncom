'use strict';

// The real thing: metaschema entities as syncom entity definitions — the
// Standard Schema path, the id field and the indexes read off a Schema, with
// nothing configured. Skips (never fails) when @alexify/metaschema is not
// installed; nothing under src/ requires it.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('..');
const { normalizeSchema } = require('../src/schema.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');

const optional = (name) => {
  try {
    return require(name);
  } catch {
    return null;
  }
};

const metaschema = optional('@alexify/metaschema');

const openTemp = async (t, options = {}) => {
  const dir = await createTemp();
  t.after(() => cleanupTemp(dir));
  const storage = await syncom.open({ path: dir, logger: false, ...options });
  t.after(() => storage.close().catch(() => {}));
  return storage;
};

test('syncom with metaschema', { skip: metaschema ? false : '@alexify/metaschema unavailable' }, async (t) => {
  const { Model, Schema } = metaschema;
  const entities = new Map(
    Object.entries({
      Project: {
        Registry: {},
        orgId: 'string',
        name: { type: 'string', aliases: ['title'] },
        slug: { type: 'string', unique: true },
        'desc?': { type: 'string', default: '' },
        byOrg: { index: ['orgId'] },
        byOrgName: { unique: ['orgId', 'name'] },
      },
    }),
  );
  const model = new Model({}, entities);
  const Project = model.entities.get('Project');

  await t.test('an entity of a model validates through ~standard, under its own id key', async (t2) => {
    const storage = await openTemp(t2, { schema: { entities: { Project: { schema: Project } } } });
    const project = await storage.Project.insert({ title: 'Alioth', slug: 'alioth', orgId: 'org1' });
    assert.deepStrictEqual(await storage.get(project.id), {
      name: 'Alioth',
      slug: 'alioth',
      orgId: 'org1',
      desc: '',
      $type: 'Project',
    });
    // `projectId` is what the Registry kind adds; handed over as `id`, the
    // id would be an unexpected key.
    const checked = await storage.check('Project', { projectId: project.id, name: 'A', slug: 'a', orgId: 'o' });
    assert.deepStrictEqual(checked, { projectId: project.id, name: 'A', slug: 'a', orgId: 'o', desc: '' });
    const unexpected = await storage.Project.insert({ name: 'x', slug: 'x', orgId: 'o', extra: 1 }).catch((e) => e);
    assert.strictEqual(unexpected.name, 'ValidationError');
    assert.strictEqual(unexpected.entity, 'Project');
    assert.deepStrictEqual(unexpected.issues, [
      { path: [], message: 'has unexpected keys: extra', code: 'unexpected' },
    ]);
    const missing = await storage.Project.insert({ name: 'x' }).catch((e) => e);
    assert.deepStrictEqual(
      missing.issues.map((issue) => [issue.code, issue.path]),
      [
        ['required', ['orgId']],
        ['required', ['slug']],
      ],
    );
    await storage.Project.update(project.id, { desc: 'd' });
    assert.strictEqual((await storage.get(project.id)).desc, 'd');
    await assert.rejects(() => storage.Project.update(project.id, { orgId: 7 }), { name: 'ValidationError' });
    assert.strictEqual((await storage.get(project.id)).orgId, 'org1');
  });

  await t.test('the id field and the indexes are read off the schema as metaschema lays them out', () => {
    const { entities } = normalizeSchema({ entities: { Project: { schema: Project } } });
    const def = entities.get('Project');
    assert.strictEqual(def.idField, 'projectId');
    assert.strictEqual(def.standard, true);
    assert.deepStrictEqual(def.index, ['orgId']);
    assert.deepStrictEqual(def.unique, [['orgId', 'name'], ['slug']]);
  });

  await t.test('a struct is handed no id; an async validator is awaited', async (t2) => {
    const Address = Schema.from({
      Struct: {},
      city: 'string',
      country: { type: 'string', validate: async (value) => value.length === 2 || 'is two letters' },
    });
    const storage = await openTemp(t2, { schema: { entities: { Address: { schema: Address } } } });
    const address = await storage.Address.insert({ city: 'Kyiv', country: 'UA' });
    assert.deepStrictEqual(await storage.get(address.id), { city: 'Kyiv', country: 'UA', $type: 'Address' });
    const error = await storage.Address.insert({ city: 'Kyiv', country: 'Ukraine' }).catch((e) => e);
    assert.strictEqual(error.name, 'ValidationError');
    assert.deepStrictEqual(error.issues, [{ path: ['country'], message: 'is two letters', code: 'custom' }]);
  });
});
