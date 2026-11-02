'use strict';

// Entity definitions and the injected validator — what the schema plugin
// (./schema.js) reads `createDatabase({ schema, validator })` into, once, at open. No
// requires beyond the core's errors: this file ships to the browser, and
// scripts/size.js fails on any import that is not a relative file.
//
// `createDatabase({ schema: { entities } })` names the collections. Each entity may
// carry a `schema` — any Standard Schema (`~standard`: metaschema, zod,
// valibot, arktype), a compiled validator function (ajv), or a plain object
// that `createDatabase({ validator })` knows how to compile (JSON Schema, TypeBox) —
// plus the indexes the record catalog keeps. The engine never requires a
// validation library: it reads one property and calls one function, and
// everything a validator returns or throws is normalized here, once, so the
// write path sees `async (record) => validated` and nothing else.

const { ValidationError } = require('../errors.js');

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const SCHEMA_KEYS = new Set(['version', 'entities', 'snapshot', 'migrations', 'ahead', 'lens']);
const AHEAD = new Set(['apply', 'hold']);
const LENS = new Set(['migrations', 'validate', 'both']);
const ENTITY_KEYS = ['schema', 'idField', 'validate', 'index', 'unique', 'fields', 'search', 'id', 'refs'];
const ENTITY_KEY = new Set(ENTITY_KEYS);

const fail = (entity, text) => new TypeError(`createDatabase({ schema }): entity ${entity}: ${text}`);

// One issue as syncom keeps it, from either shape it meets: a Standard
// Schema issue (`path` of keys or `{ key }` segments) or an ajv error
// (`instancePath` as a JSON pointer, `keyword`).
const segment = (part) => {
  const key = isObject(part) ? part.key : part;
  return typeof key === 'symbol' ? String(key) : key;
};

const pointer = (text) => {
  const parts = text.split('/');
  const path = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== '') path.push(parts[i].replaceAll('~1', '/').replaceAll('~0', '~'));
  }
  return path;
};

const toIssue = (issue) => {
  if (!isObject(issue)) return { path: [], message: String(issue) };
  let path = [];
  if (Array.isArray(issue.path)) {
    for (let i = 0; i < issue.path.length; i++) path.push(segment(issue.path[i]));
  } else if (typeof issue.instancePath === 'string') {
    path = pointer(issue.instancePath);
  }
  const message = typeof issue.message === 'string' ? issue.message : 'invalid';
  const code = typeof issue.code === 'string' ? issue.code : issue.keyword;
  return typeof code === 'string' ? { path, message, code } : { path, message };
};

const toIssues = (issues) => {
  if (!Array.isArray(issues) || issues.length === 0) return [{ path: [], message: 'invalid' }];
  const out = [];
  for (let i = 0; i < issues.length; i++) out.push(toIssue(issues[i]));
  return out;
};

// Whatever a validator threw, as a ValidationError: its own, one carrying
// ajv-style `errors`, or anything else as a single issue with the cause kept.
const failure = (entity, error) => {
  if (error instanceof ValidationError) return error;
  if (Array.isArray(error?.errors)) return new ValidationError(entity, toIssues(error.errors));
  const message = typeof error?.message === 'string' ? error.message : String(error);
  const wrapped = new ValidationError(entity, [{ path: [], message }]);
  wrapped.cause = error;
  return wrapped;
};

const isThenable = (value) => Boolean(value) && typeof value.then === 'function';

// `'~standard' in schema` is how the specification says to tell a Standard
// Schema from anything else; the property is often an accessor, so it is
// read once here.
const isStandard = (schema) => isObject(schema) && '~standard' in schema;

const fromStandard = (standard, entity) => async (data) => {
  let result;
  try {
    result = standard.validate(data);
    if (isThenable(result)) result = await result;
  } catch (error) {
    throw failure(entity, error);
  }
  if (!isObject(result)) throw new ValidationError(entity, [{ path: [], message: 'the validator returned no result' }]);
  if (result.issues !== undefined) throw new ValidationError(entity, toIssues(result.issues));
  return result.value;
};

// A function validator: ajv's (`false` plus `fn.errors`, or an async reject
// carrying `errors`), an assertion that throws, or a transformer that returns
// the value. `true` and `undefined` both mean "as given".
const fromFunction = (fn, entity) => async (data) => {
  let result;
  try {
    result = fn(data);
    if (isThenable(result)) result = await result;
  } catch (error) {
    throw failure(entity, error);
  }
  if (result === false) throw new ValidationError(entity, toIssues(fn.errors));
  return result === true || result === undefined ? data : result;
};

const normalizeValidator = (schema, entity, validator) => {
  if (isStandard(schema)) {
    const standard = schema['~standard'];
    const usable = isObject(standard) && typeof standard.validate === 'function';
    if (!usable) throw fail(entity, '~standard has no validate()');
    return fromStandard(standard, entity);
  }
  if (typeof schema === 'function') return fromFunction(schema, entity);
  if (!isObject(schema)) throw fail(entity, 'schema must be an object or a function');
  if (validator === null) {
    throw fail(entity, 'a schema without ~standard needs createDatabase({ validator }) or validate: false');
  }
  const compiled = validator.compile(schema, { entity });
  if (typeof compiled !== 'function') throw fail(entity, 'validator.compile() must return a function');
  return fromFunction(compiled, entity);
};

// ---------------------------------------------------------------------------
// What the engine reads off a schema object: the field map (metaschema
// `fields`, zod `shape`, valibot `entries`) and metaschema's `indexes`.

const lowerCamel = (name) => name.charAt(0).toLowerCase() + name.slice(1);

const fieldMap = (schema) => {
  if (!isObject(schema)) return null;
  if (isObject(schema.fields)) return schema.fields;
  if (isObject(schema.shape)) return schema.shape;
  if (isObject(schema.entries)) return schema.entries;
  return null;
};

// The key the record id is handed to the validator under: `id` when the
// schema has it, metaschema's `<entityName>Id` when it has that, nothing
// (`false`) for a schema that shows its fields and has neither, and `id`
// for one that shows nothing (a function, a JSON Schema).
const deriveIdField = (schema, entity) => {
  const map = fieldMap(schema);
  if (map === null) return 'id';
  if (Object.hasOwn(map, 'id')) return 'id';
  const key = `${lowerCamel(entity)}Id`;
  return Object.hasOwn(map, key) ? key : false;
};

const isField = (value) => typeof value === 'string' && value.length > 0;

// A copy of a non-empty array of field names, or null.
const fieldList = (value) => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const list = [];
  for (let i = 0; i < value.length; i++) {
    if (!isField(value[i])) return null;
    list.push(value[i]);
  }
  return list;
};

// An array of field names, each once, in the order first given.
const fieldNames = (value, entity, what) => {
  if (!Array.isArray(value)) throw fail(entity, `${what} must be an array of field names`);
  const names = new Set();
  for (let i = 0; i < value.length; i++) {
    if (!isField(value[i])) throw fail(entity, `${what} must be an array of field names`);
    names.add(value[i]);
  }
  return [...names];
};

const explicitIndex = (value, entity) => fieldNames(value, entity, 'index');

// The fields `$text` searches, joined into the record's catalog row and
// handed to the injected text index (`createDatabase({ search })`); never derived from
// a schema — no validator has a notion of "searchable".
const explicitSearch = (value, entity) => fieldNames(value, entity, 'search');

const explicitUnique = (value, entity) => {
  if (!Array.isArray(value)) throw fail(entity, 'unique must be an array');
  const keys = [];
  for (const key of value) {
    const list = isField(key) ? [key] : fieldList(key);
    if (list === null) throw fail(entity, 'unique takes field names and arrays of them');
    keys.push(list);
  }
  return keys;
};

// Indexes as metaschema lays them out: a pseudo-field with a field list
// under `unique`, `index` or `primary` in `schema.indexes` (a `primary` is
// a storage hint here — the primary key is the record id), and `unique:
// true` / `index: true` on a field. A `many` relation, or anything else, is
// left alone.
const derivedIndexes = (schema) => {
  const index = new Set();
  const unique = [];
  if (!isObject(schema)) return { index, unique };
  if (isObject(schema.indexes)) {
    const names = Object.keys(schema.indexes);
    for (let i = 0; i < names.length; i++) {
      const spec = schema.indexes[names[i]];
      if (!isObject(spec)) continue;
      const keys = fieldList(spec.unique);
      if (keys !== null) {
        unique.push(keys);
        continue;
      }
      const fields = fieldList(spec.index) ?? fieldList(spec.primary);
      if (fields !== null) for (let j = 0; j < fields.length; j++) index.add(fields[j]);
    }
  }
  if (isObject(schema.fields)) {
    const names = Object.keys(schema.fields);
    for (let i = 0; i < names.length; i++) {
      const field = names[i];
      const spec = schema.fields[field];
      if (!isObject(spec)) continue;
      if (spec.unique === true) unique.push([field]);
      else if (spec.index === true) index.add(field);
    }
  }
  return { index, unique };
};

const dedupe = (keys) => {
  const seen = new Set();
  const out = [];
  for (const key of keys) {
    const tag = key.join('\0');
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(key);
  }
  return out;
};

// A composite id: `{ fields, separator? }` — the record id is the fields' values joined by the
// separator ('.' unless given), every character of which must be of the id class.
const SEPARATOR = /^[A-Za-z0-9._@-]+$/;
const compositeId = (value, entity) => {
  if (value === undefined) return null;
  if (!isObject(value)) throw fail(entity, 'id must be { fields, separator? }');
  const fields = fieldList(value.fields);
  if (fields === null) throw fail(entity, 'id.fields must be a non-empty array of field names');
  const separator = value.separator === undefined ? '.' : value.separator;
  if (typeof separator !== 'string' || !SEPARATOR.test(separator)) {
    throw fail(entity, 'id.separator must be of the id class ([A-Za-z0-9._@-])');
  }
  return { fields, separator };
};

// The references a definition declares — `refs: { author: 'Author', tags: ['Tag'] }`: a field that
// names one record of a collection, or many — as `{ [field]: { entity, many } }`; null for none.
const explicitRefs = (value, entity) => {
  if (!isObject(value)) throw fail(entity, 'refs must be an object of field: entity | [entity]');
  const refs = {};
  const fields = Object.keys(value);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const spec = value[field];
    const many = Array.isArray(spec);
    const target = many ? (spec.length === 1 ? spec[0] : null) : spec;
    if (!isField(field) || !isField(target)) throw fail(entity, `refs.${field} must name an entity, or [entity]`);
    refs[field] = { entity: target, many };
  }
  return fields.length === 0 ? null : refs;
};

// What metaschema's own type names are not: a field whose type is another entity of the model is a
// reference (`company: 'Company'`, `{ type: 'Company' }`, `{ many: 'Address' }`). Decided once the
// entities are all known (`deriveRefs`), explicit `refs` left as they are.
const relationsOf = (schema, names) => {
  const map = fieldMap(schema);
  if (map === null) return null;
  const refs = {};
  let found = 0;
  const fields = Object.keys(map);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const spec = map[field];
    let target = null;
    let many = false;
    if (typeof spec === 'string') target = spec;
    else if (isObject(spec)) {
      if (typeof spec.many === 'string') {
        target = spec.many;
        many = true;
      } else if (typeof spec.type === 'string') target = spec.type;
    }
    if (target === null || !names.has(target)) continue;
    refs[field] = { entity: target, many };
    found++;
  }
  return found === 0 ? null : refs;
};

/** The entity's references completed from its schema's relations, once every entity name is known. */
const deriveRefs = (def, names) => {
  if (def.refs !== null || def.schema === undefined) return def;
  const derived = relationsOf(def.schema, names);
  return derived === null ? def : { ...def, refs: derived };
};

const normalizeEntity = (name, def, validator) => {
  if (!isObject(def)) throw fail(name, 'must be an object');
  for (const key of Object.keys(def)) {
    if (!ENTITY_KEY.has(key)) throw fail(name, `unknown key '${key}' (expected ${ENTITY_KEYS.join(', ')})`);
  }
  const { schema, validate, fields } = def;
  const id = compositeId(def.id, name);
  if (validate !== undefined && validate !== false) throw fail(name, 'validate may only be false');
  if (fields !== undefined && !isObject(fields)) throw fail(name, 'fields must be an object');
  const idField = def.idField === undefined ? deriveIdField(schema, name) : def.idField;
  if (idField !== false && !isField(idField)) throw fail(name, 'idField must be a field name or false');
  const derived = def.index === undefined || def.unique === undefined ? derivedIndexes(schema) : null;
  const index = def.index === undefined ? [...derived.index] : explicitIndex(def.index, name);
  const unique = dedupe(def.unique === undefined ? derived.unique : explicitUnique(def.unique, name));
  const validates = schema !== undefined && validate !== false;
  return {
    name,
    schema,
    standard: isStandard(schema),
    validator: validates ? normalizeValidator(schema, name, validator) : null,
    idField,
    id,
    index,
    unique,
    fields: fields ?? null,
    search: def.search === undefined ? [] : explicitSearch(def.search, name),
    refs: def.refs === undefined ? null : explicitRefs(def.refs, name),
  };
};

const addEntity = (entities, name, def, compiler) => {
  if (!isField(name)) throw new TypeError('createDatabase({ schema }): entity names must be non-empty strings');
  entities.set(name, normalizeEntity(name, def, compiler));
};

const isMigration = (value) =>
  isObject(value) && typeof value.up === 'function' && (value.down === undefined || typeof value.down === 'function');

// `migrations` keyed by the version each one migrates TO (`2` takes a record
// from 1 to 2): a storage-wide `{ up }`, or `{ [entity]: { up } }`. `down`
// is accepted and reserved. A Map of version → `{ up }` | Map<entity, { up }>.
const normalizeMigrations = (migrations, version) => {
  if (migrations === undefined) return null;
  if (!isObject(migrations)) {
    throw new TypeError('createDatabase({ schema }): migrations must be an object keyed by version');
  }
  const chain = new Map();
  for (const key of Object.keys(migrations)) {
    const to = Number(key);
    if (!Number.isInteger(to) || to < 2 || String(to) !== key) {
      throw new TypeError(`createDatabase({ schema }): migrations: '${key}' is not a version of 2 or more`);
    }
    if (to > version) {
      throw new TypeError(`createDatabase({ schema }): migrations: ${key} is beyond version ${version}`);
    }
    const value = migrations[key];
    if (isMigration(value)) {
      chain.set(to, { up: value.up });
      continue;
    }
    if (!isObject(value)) {
      throw new TypeError(`createDatabase({ schema }): migrations[${key}] must be { up } or { [entity]: { up } }`);
    }
    const perEntity = new Map();
    const entities = Object.keys(value);
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      const migration = value[entity];
      if (!isMigration(migration)) {
        throw new TypeError(`createDatabase({ schema }): migrations[${key}].${entity} must be { up }`);
      }
      perEntity.set(entity, { up: migration.up });
    }
    chain.set(to, perEntity);
  }
  return chain;
};

// The entity definitions a database adds after it opened (`addCollections`):
// each normalized as one of the schema's would be. The validator is the one
// `createDatabase({ validator })` gave, read once at setup.
const defineEntity = (name, def, validator, names = new Set()) => {
  if (!isField(name)) throw new TypeError('addCollections(): collection names must be non-empty strings');
  const known = new Set(names);
  known.add(name);
  return deriveRefs(normalizeEntity(name, def, validator === undefined ? null : validator), known);
};

/**
 * `createDatabase({ schema, validator })` normalized: `{ version, entities, snapshot,
 * migrations, ahead, lens }` — the entities a Map of `{ name, schema,
 * standard, validator, idField, index, unique, fields, search }`, `snapshot` whatever
 * JSON describes the schema (hashed by the storage, exchanged in hello),
 * `migrations` the up-chain, `ahead` what to do with an op from a newer
 * version, `lens` which steps read an older record. Unknown keys, a malformed
 * definition and a schema this engine cannot validate are TypeErrors here, at
 * open — a schema that silently never validates would be a validation that
 * silently never runs.
 */
const normalizeSchema = (schema, { validator } = {}) => {
  if (validator !== undefined && (!isObject(validator) || typeof validator.compile !== 'function')) {
    throw new TypeError('createDatabase({ validator }): validator must have a compile() method');
  }
  const compiler = validator === undefined ? null : validator;
  const entities = new Map();
  if (schema === undefined || schema === null) {
    return { version: 1, entities, snapshot: undefined, migrations: null, ahead: 'apply', lens: 'both' };
  }
  if (!isObject(schema)) throw new TypeError('createDatabase({ schema }): schema must be an object');
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYS.has(key)) throw new TypeError(`createDatabase({ schema }): unknown key '${key}'`);
  }
  const version = schema.version === undefined ? 1 : schema.version;
  if (!Number.isInteger(version) || version < 1) {
    throw new TypeError('createDatabase({ schema }): version must be a positive integer');
  }
  const ahead = schema.ahead === undefined ? 'apply' : schema.ahead;
  if (!AHEAD.has(ahead)) throw new TypeError("createDatabase({ schema }): ahead must be 'apply' or 'hold'");
  const lens = schema.lens === undefined ? 'both' : schema.lens;
  if (!LENS.has(lens)) {
    throw new TypeError("createDatabase({ schema }): lens must be 'migrations', 'validate' or 'both'");
  }
  const migrations = normalizeMigrations(schema.migrations, version);
  if (lens === 'validate' && migrations !== null) {
    throw new TypeError("createDatabase({ schema }): lens 'validate' skips the migrations the schema declares");
  }
  const source = schema.entities;
  if (source !== undefined && source !== null) {
    if (typeof source.entries === 'function') {
      for (const [name, def] of source.entries()) addEntity(entities, name, def, compiler);
    } else if (isObject(source)) {
      const names = Object.keys(source);
      for (let i = 0; i < names.length; i++) addEntity(entities, names[i], source[names[i]], compiler);
    } else {
      throw new TypeError('createDatabase({ schema }): entities must be an object or a Map');
    }
  }
  // A schema's relations name entities of the model: read once every name is known.
  const names = new Set(entities.keys());
  for (const [name, def] of entities) entities.set(name, deriveRefs(def, names));
  return { version, entities, snapshot: schema.snapshot, migrations, ahead, lens };
};

module.exports = {
  normalizeSchema,
  defineEntity,
  normalizeValidator,
  deriveIdField,
  derivedIndexes,
  toIssues,
};
