'use strict';

// @alexify/syncom/mcp — the tools an agent calls over a database, in the shape of the Model Context Protocol:
// `createTools(db, { collections, tools, readOnly, limit, sealed, regex })` answers `[{ name, description, inputSchema,
// annotations, execute }]`, a set per collection — query, count, get, changes, wait_changes, and insert, upsert, delete
// unless `readOnly` (`tools` names the verbs to make) — JSON in, JSON out. Registering them is the caller's: an MCP
// server's `tools/list` answers the definitions and its `tools/call` runs `execute`, WebMCP's
// `navigator.modelContext.registerTool(tool)` takes one as it is; no SDK is imported. `execute(args)` checks `args`
// against `inputSchema` first (`checkArgs`: the subset of JSON Schema the tools declare, own members alone) — a tool
// is called by a model, and a wrong argument is a TypeError at the door, never a crash deeper down; a `$regex`
// anywhere in a query is refused the same way unless `regex: true` (a pattern of the model's is a pattern on the
// event loop). The collection's own errors (NOT_FOUND, a validator's, PLUGIN_MISSING without the query plugin) come
// through as they are: SyncomErrors with a code the server reports. `changes` answers at most `limit` records and
// `more` while the log holds more.

const { SOURCE } = require('../symbols.js');

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;
const MAX_WAIT = 120_000;
const DEFAULT_WAIT = 30_000;
// How many log entries `changes` reads at a time while it looks for `limit` records of the collection.
const LOG_PAGE = 1000;
// How deep a query is walked for a `$regex` (the query plugin refuses deeper ones itself).
const MAX_QUERY_DEPTH = 32;
const VERBS = ['query', 'count', 'get', 'changes', 'wait_changes', 'insert', 'upsert', 'delete'];
const WRITERS = new Set(['insert', 'upsert', 'delete']);

const kindOf = (value) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);

// `value` against `schema`: type, enum, minimum/maximum, items, properties with required and a closed object where
// `additionalProperties` is false — what the tools declare, no more. A member is one the schema NAMES as its own
// (`Object.hasOwn`): `constructor`, `toString` or `__proto__` are not. `path` names the member refused.
const check = (schema, value, path) => {
  const kind = kindOf(value);
  if (schema.type !== undefined) {
    const expected = schema.type === 'integer' || schema.type === 'number' ? 'number' : schema.type;
    const ok = kind === expected && (schema.type !== 'integer' || Number.isInteger(value));
    if (!ok) throw new TypeError(`${path}: ${schema.type} expected, ${kind} given`);
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    throw new TypeError(`${path}: one of ${schema.enum.join(', ')} expected`);
  }
  if (kind === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new TypeError(`${path}: ${schema.minimum} at least`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new TypeError(`${path}: ${schema.maximum} at most`);
    }
  }
  if (kind === 'array' && schema.items !== undefined) {
    for (let i = 0; i < value.length; i++) check(schema.items, value[i], `${path}[${i}]`);
  }
  if (kind === 'object' && schema.properties !== undefined) {
    const required = schema.required ?? [];
    for (let i = 0; i < required.length; i++) {
      if (!Object.hasOwn(value, required[i])) throw new TypeError(`${path}.${required[i]} is required`);
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) {
        if (schema.additionalProperties === false) throw new TypeError(`${path}.${key} is not a member`);
        continue;
      }
      check(schema.properties[key], value[key], `${path}.${key}`);
    }
  }
};

/** `args` against a tool's `inputSchema`: a TypeError naming the member refused, nothing otherwise. */
const checkArgs = (schema, args) => check(schema, args, 'args');

// A `$regex` anywhere in `query` — own keys, arrays, MAX_QUERY_DEPTH deep — is refused: a TypeError at the door.
const forbidRegex = (value, path, depth) => {
  if (value === null || typeof value !== 'object') return;
  if (depth > MAX_QUERY_DEPTH) throw new TypeError(`${path}: too deep`);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) forbidRegex(value[i], `${path}[${i}]`, depth + 1);
    return;
  }
  for (const key of Object.keys(value)) {
    if (key === '$regex') throw new TypeError(`${path}.$regex is not allowed: createTools({ regex: true })`);
    forbidRegex(value[key], `${path}.${key}`, depth + 1);
  }
};

// A tool in the protocol's shape; its annotations are the verb's: the readers read-only and idempotent, a writer
// makes (insert), overwrites (upsert) or takes away (delete), none reaches outside the database.
const tool = (otel, verb, name, description, inputSchema, run) =>
  Object.freeze({
    name,
    description,
    inputSchema,
    annotations: {
      title: name,
      readOnlyHint: !WRITERS.has(verb),
      destructiveHint: verb === 'upsert' || verb === 'delete',
      idempotentHint: verb !== 'insert',
      openWorldHint: false,
    },
    // Every call counted (`syncom.mcp.calls`, by verb): ok, refused (an argument's no, a TypeError), error.
    async execute(args = {}) {
      try {
        checkArgs(inputSchema, args);
        const result = await run(args);
        otel.recordTool(verb, 'ok');
        return result;
      } catch (error) {
        otel.recordTool(verb, error instanceof TypeError ? 'refused' : 'error');
        throw error;
      }
    },
  });

const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const QUERY = { type: 'object', description: 'A Mango query: { field: value }, $gt, $in, $and, $or, $not, $text…' };
const ID = { type: 'string' };
const SINCE = { type: 'string', description: 'An eventId `changes` answered' };

const toolsOf = (db, name, collection, { verbs, limit: maxLimit, sealed, regex }) => {
  const seam = db[SOURCE];
  // A sealed record is the key holder's: the agent reads none unless `sealed` asks (the cursor through the seam
  // leaves them out; `get` the same by the catalog's row).
  const hidden = (id) => !sealed && seam.row(id)?.encrypted === true;
  const queryOf = (query) => {
    if (!regex) forbidRegex(query, 'args.query', 0);
    return query;
  };
  const select = ({ query = {}, order = [], limit = Math.min(DEFAULT_LIMIT, maxLimit), offset = 0 }) => {
    let cursor = collection.select(queryOf(query), { sealed });
    for (let i = 0; i < order.length; i++) {
      const field = order[i];
      cursor = field.startsWith('-') ? cursor.desc(field.slice(1)) : cursor.order(field);
    }
    return cursor.limit(limit).offset(offset);
  };
  // The collection's records the log touched since `since` (an id once, deleted or not), at most `limit` of them,
  // and where to resume — the position after the last record answered while there may be more (`more`), the log's
  // end otherwise; the id to start from alone without `since`; `changes: null` where the log cannot resume there
  // (another epoch, a position compacted away) — list the collection again then. The log is read a page at a time.
  const changesSince = (since, limit) => {
    const end = (changes) => ({ eventId: db.log.lastEventId, changes, more: false });
    if (since === undefined) return end([]);
    const changes = [];
    const seen = new Set();
    let cursor = since;
    for (;;) {
      const read = db.log.read(cursor, { limit: LOG_PAGE });
      if (read === null) return end(null);
      const { entries, last } = read;
      for (let i = 0; i < entries.length; i++) {
        const { op, seq } = entries[i];
        if (typeof op.id !== 'string' || seen.has(op.id)) continue;
        const row = seam.row(op.id);
        if (row === null || row.type !== name) continue;
        seen.add(op.id);
        changes.push({ id: op.id, deleted: row.gone === true });
        if (changes.length >= limit) return { eventId: db.log.formatId(seq), changes, more: true };
      }
      if (entries.length < LOG_PAGE || last === null) return end(changes);
      cursor = db.log.formatId(last);
    }
  };
  // What `changes` answers, once there is something to answer or `timeout` ms passed: the collection's `change`
  // event is listened to before the log is read, so nothing lands between the two unheard.
  const waitChanges = (since, limit, timeout) =>
    new Promise((resolve) => {
      let timer = null;
      const done = () => {
        collection.off('change', done);
        if (timer !== null) clearTimeout(timer);
        resolve(changesSince(since, limit));
      };
      collection.on('change', done);
      const now = changesSince(since, limit);
      if (now.changes === null || now.changes.length > 0) return done();
      timer = setTimeout(done, timeout);
    });
  const LIMIT = { type: 'integer', minimum: 1, maximum: maxLimit };
  const defs = [
    [
      'query',
      `The records of ${name} matching a query — ordered, windowed; ${maxLimit} at most`,
      object({
        query: QUERY,
        order: { type: 'array', items: { type: 'string' }, description: "Order by fields; '-field' descending" },
        limit: { type: 'integer', minimum: 0, maximum: maxLimit },
        offset: { type: 'integer', minimum: 0 },
      }),
      async (args) => ({ rows: await select(args).fetch() }),
    ],
    [
      'count',
      `How many records of ${name} match a query`,
      object({ query: QUERY }),
      async ({ query = {} }) => ({ count: await collection.count(queryOf(query), { sealed }) }),
    ],
    [
      'get',
      `One record of ${name} by id, or null`,
      object({ id: ID }, ['id']),
      async ({ id }) => ({ record: hidden(id) ? null : await collection.get(id) }),
    ],
    [
      'changes',
      `Records of ${name} changed since an eventId (limit at most), the eventId to ask from next, more while there are; without since, where to start; changes null where the log cannot resume`,
      object({ since: SINCE, limit: LIMIT }),
      ({ since, limit = maxLimit }) => changesSince(since, limit),
    ],
    [
      'wait_changes',
      `${name}_changes once a change comes after the eventId, or after timeout ms (${DEFAULT_WAIT})`,
      object({ since: SINCE, limit: LIMIT, timeout: { type: 'integer', minimum: 0, maximum: MAX_WAIT } }, ['since']),
      ({ since, limit = maxLimit, timeout = DEFAULT_WAIT }) => waitChanges(since, limit, timeout),
    ],
    [
      'insert',
      `A new record of ${name}; its id`,
      object({ data: { type: 'object' } }, ['data']),
      async ({ data }) => ({ id: (await collection.insert(data)).id }),
    ],
    [
      'upsert',
      `A record of ${name} written whole under id — or under the id its data names`,
      object({ id: ID, data: { type: 'object' } }, ['data']),
      async ({ id, data }) => {
        if (id !== undefined) {
          await collection.set(id, data);
          return { id };
        }
        return { id: (await collection.upsert(data)).id };
      },
    ],
    [
      'delete',
      `The record of ${name} deleted; deleted false where there is none`,
      object({ id: ID }, ['id']),
      async ({ id }) => {
        // Nothing to delete leaves no tombstone; a record of another collection is the collection's NOT_FOUND.
        const row = seam.row(id);
        if (row === null || row.gone === true) return { id, deleted: false };
        await collection.delete(id);
        return { id, deleted: true };
      },
    ],
  ];
  const tools = [];
  for (let i = 0; i < defs.length; i++) {
    const [verb, description, schema, run] = defs[i];
    if (verbs.has(verb)) tools.push(tool(seam.otel, verb, `${name}_${verb}`, description, schema, run));
  }
  return tools;
};

/**
 * The tools over `db`'s collections — every one by default, `collections` names some — as `{ name, description,
 * inputSchema, annotations, execute }`: query, count, get, changes, wait_changes per collection, and insert, upsert,
 * delete unless `readOnly` (`tools` names the verbs to make among the eight). `limit` caps a query's window and a
 * `changes` page (1000 by default). The collection's sealed records are left out of query, count and get unless
 * `sealed` — an agent is a reader of the plain rows by default. A `$regex` in a query is refused unless `regex`.
 */
const createTools = (db, options = {}) => {
  if (db === null || typeof db !== 'object' || typeof db.log?.read !== 'function' || db.collections === undefined) {
    throw new TypeError('createTools() takes a database');
  }
  const {
    collections = null,
    tools = null,
    readOnly = false,
    limit = MAX_LIMIT,
    sealed = false,
    regex = false,
  } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new TypeError(`createTools(): limit is 1..${MAX_LIMIT}`);
  }
  for (const [option, value] of [
    ['sealed', sealed],
    ['regex', regex],
    ['readOnly', readOnly],
  ]) {
    if (typeof value !== 'boolean') throw new TypeError(`createTools(): ${option} is a boolean`);
  }
  if (tools !== null && !Array.isArray(tools)) throw new TypeError('createTools(): tools is an array of verbs');
  const wanted = tools ?? VERBS;
  const verbs = new Set();
  for (let i = 0; i < wanted.length; i++) {
    const verb = wanted[i];
    if (!VERBS.includes(verb)) throw new TypeError(`createTools(): no tool ${verb}`);
    if (!readOnly || !WRITERS.has(verb)) verbs.add(verb);
  }
  const all = db.collections;
  const names = collections === null ? Object.keys(all) : collections;
  if (!Array.isArray(names)) throw new TypeError('createTools(): collections is an array');
  const out = [];
  for (let i = 0; i < names.length; i++) {
    const collection = all[names[i]];
    if (collection === undefined) throw new TypeError(`createTools(): no collection ${names[i]}`);
    const made = toolsOf(db, names[i], collection, { verbs, limit, sealed, regex });
    for (let j = 0; j < made.length; j++) out.push(made[j]);
  }
  return out;
};

module.exports = { createTools, checkArgs, MAX_LIMIT };
