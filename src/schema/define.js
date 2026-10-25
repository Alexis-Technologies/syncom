'use strict';

// Entity definitions and the injected validator — what the schema plugin
// (./schema.js) reads `open({ schema, validator })` into, once, at open. No
// requires beyond the core's errors: this file ships to the browser, and
// scripts/size.js fails on any import that is not a relative file.
//
// `open({ schema: { entities } })` names the collections. Each entity may
// carry a `schema` — any Standard Schema (`~standard`: metaschema, zod,
// valibot, arktype), a compiled validator function (ajv), or a plain object
// that `open({ validator })` knows how to compile (JSON Schema, TypeBox) —
// plus the indexes the record catalog keeps. The engine never requires a
// validation library: it reads one property and calls one function, and
// everything a validator returns or throws is normalized here, once, so the
// write path sees `async (record) => validated` and nothing else.

const { ValidationError } = require('../errors.js');

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const SCHEMA_KEYS = ['version', 'entities', 'snapshot', 'migrations', 'ahead', 'lens'];
const AHEAD = ['apply', 'hold'];
const LENS = ['migrations', 'validate', 'both'];
const ENTITY_KEYS = ['schema', 'idField', 'validate', 'index', 'unique', 'fields', 'search'];

const fail = (entity, text) => new TypeError(`open({ schema }): entity ${entity}: ${text}`);

// One issue as syncom keeps it, from either shape it meets: a Standard
// Schema issue (`path` of keys or `{ key }` segments) or an ajv error
// (`instancePath` as a JSON pointer, `keyword`).
const segment = (part) => {
  const key = isObject(part) ? part.key : part;
  return typeof key === 'symbol' ? String(key) : key;
};

const pointer = (text) =>
  text
    .split('/')
    .filter(Boolean)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));

const toIssue = (issue) => {
  if (!isObject(issue)) return { path: [], message: String(issue) };
  const path = Array.isArray(issue.path)
    ? issue.path.map(segment)
    : typeof issue.instancePath === 'string'
      ? pointer(issue.instancePath)
      : [];
  const message = typeof issue.message === 'string' ? issue.message : 'invalid';
  const code = typeof issue.code === 'string' ? issue.code : issue.keyword;
  return typeof code === 'string' ? { path, message, code } : { path, message };
};

const toIssues = (issues) =>
  Array.isArray(issues) && issues.length > 0 ? issues.map(toIssue) : [{ path: [], message: 'invalid' }];

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
  if (validator === null) throw fail(entity, 'a schema without ~standard needs open({ validator }) or validate: false');
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
const isFieldList = (value) => Array.isArray(value) && value.length > 0 && value.every(isField);

const explicitIndex = (value, entity) => {
  if (!Array.isArray(value) || !value.every(isField)) throw fail(entity, 'index must be an array of field names');
  return [...new Set(value)];
};

// The fields `$text` searches, joined into the record's catalog row and
// handed to the injected text index (`open({ search })`); never derived from
// a schema — no validator has a notion of "searchable".
const explicitSearch = (value, entity) => {
  if (!Array.isArray(value) || !value.every(isField)) throw fail(entity, 'search must be an array of field names');
  return [...new Set(value)];
};

const explicitUnique = (value, entity) => {
  if (!Array.isArray(value)) throw fail(entity, 'unique must be an array');
  const keys = [];
  for (const key of value) {
    if (isField(key)) keys.push([key]);
    else if (isFieldList(key)) keys.push([...key]);
    else throw fail(entity, 'unique takes field names and arrays of them');
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
    for (const spec of Object.values(schema.indexes)) {
      if (!isObject(spec)) continue;
      if (isFieldList(spec.unique)) unique.push([...spec.unique]);
      else if (isFieldList(spec.index)) for (const field of spec.index) index.add(field);
      else if (isFieldList(spec.primary)) for (const field of spec.primary) index.add(field);
    }
  }
  if (isObject(schema.fields)) {
    for (const [field, spec] of Object.entries(schema.fields)) {
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

const normalizeEntity = (name, def, validator) => {
  if (!isObject(def)) throw fail(name, 'must be an object');
  for (const key of Object.keys(def)) {
    if (!ENTITY_KEYS.includes(key)) throw fail(name, `unknown key '${key}' (expected ${ENTITY_KEYS.join(', ')})`);
  }
  const { schema, validate, fields } = def;
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
    index,
    unique,
    fields: fields ?? null,
    search: def.search === undefined ? [] : explicitSearch(def.search, name),
  };
};

const isMigration = (value) =>
  isObject(value) && typeof value.up === 'function' && (value.down === undefined || typeof value.down === 'function');

// `migrations` keyed by the version each one migrates TO (`2` takes a record
// from 1 to 2): a storage-wide `{ up }`, or `{ [entity]: { up } }`. `down`
// is accepted and reserved. A Map of version → `{ up }` | Map<entity, { up }>.
const normalizeMigrations = (migrations, version) => {
  if (migrations === undefined) return null;
  if (!isObject(migrations)) throw new TypeError('open({ schema }): migrations must be an object keyed by version');
  const chain = new Map();
  for (const key of Object.keys(migrations)) {
    const to = Number(key);
    if (!Number.isInteger(to) || to < 2 || String(to) !== key) {
      throw new TypeError(`open({ schema }): migrations: '${key}' is not a version of 2 or more`);
    }
    if (to > version) throw new TypeError(`open({ schema }): migrations: ${key} is beyond version ${version}`);
    const value = migrations[key];
    if (isMigration(value)) {
      chain.set(to, { up: value.up });
      continue;
    }
    if (!isObject(value)) {
      throw new TypeError(`open({ schema }): migrations[${key}] must be { up } or { [entity]: { up } }`);
    }
    const perEntity = new Map();
    for (const [entity, migration] of Object.entries(value)) {
      if (!isMigration(migration)) throw new TypeError(`open({ schema }): migrations[${key}].${entity} must be { up }`);
      perEntity.set(entity, { up: migration.up });
    }
    chain.set(to, perEntity);
  }
  return chain;
};

/**
 * `open({ schema, validator })` normalized: `{ version, entities, snapshot,
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
    throw new TypeError('open({ validator }): validator must have a compile() method');
  }
  const compiler = validator === undefined ? null : validator;
  const entities = new Map();
  if (schema === undefined || schema === null) {
    return { version: 1, entities, snapshot: undefined, migrations: null, ahead: 'apply', lens: 'both' };
  }
  if (!isObject(schema)) throw new TypeError('open({ schema }): schema must be an object');
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYS.includes(key)) throw new TypeError(`open({ schema }): unknown key '${key}'`);
  }
  const version = schema.version === undefined ? 1 : schema.version;
  if (!Number.isInteger(version) || version < 1) {
    throw new TypeError('open({ schema }): version must be a positive integer');
  }
  const ahead = schema.ahead === undefined ? 'apply' : schema.ahead;
  if (!AHEAD.includes(ahead)) throw new TypeError("open({ schema }): ahead must be 'apply' or 'hold'");
  const lens = schema.lens === undefined ? 'both' : schema.lens;
  if (!LENS.includes(lens)) throw new TypeError("open({ schema }): lens must be 'migrations', 'validate' or 'both'");
  const migrations = normalizeMigrations(schema.migrations, version);
  if (lens === 'validate' && migrations !== null) {
    throw new TypeError("open({ schema }): lens 'validate' skips the migrations the schema declares");
  }
  const source = schema.entities;
  if (source !== undefined && source !== null) {
    const pairs =
      typeof source.entries === 'function' ? [...source.entries()] : isObject(source) ? Object.entries(source) : null;
    if (pairs === null) throw new TypeError('open({ schema }): entities must be an object or a Map');
    for (const [name, def] of pairs) {
      if (!isField(name)) throw new TypeError('open({ schema }): entity names must be non-empty strings');
      entities.set(name, normalizeEntity(name, def, compiler));
    }
  }
  return { version, entities, snapshot: schema.snapshot, migrations, ahead, lens };
};

module.exports = {
  normalizeSchema,
  normalizeValidator,
  deriveIdField,
  derivedIndexes,
  toIssues,
};
