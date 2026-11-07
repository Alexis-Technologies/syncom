'use strict';

// @alexify/syncom/mcp — the tools an agent calls over a database, in the shape of the Model Context Protocol:
// `createTools(db, { collections, readOnly, limit })` answers `[{ name, description, inputSchema, execute }]`, a set
// per collection — query, count, get, changes, wait_changes, and insert, upsert, delete unless `readOnly` — JSON in,
// JSON out. Registering them is the caller's: an MCP server's `tools/list` answers the definitions and its
// `tools/call` runs `execute`, WebMCP's `navigator.modelContext.registerTool(tool)` takes one as it is; no SDK is
// imported. `execute(args)` checks `args` against `inputSchema` first (`checkArgs`: the subset of JSON Schema the
// tools declare) — a tool is called by a model, and a wrong argument is a TypeError at the door, never a crash
// deeper down. The collection's own errors (NOT_FOUND, a validator's, PLUGIN_MISSING without the query plugin) come
// through as they are: SyncomErrors with a code the server reports.

const { SOURCE } = require('../symbols.js');

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;
const MAX_WAIT = 120_000;
const DEFAULT_WAIT = 30_000;

const kindOf = (value) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);

// `value` against `schema`: type, enum, minimum/maximum, items, properties with required and a closed object where
// `additionalProperties` is false — what the tools declare, no more. `path` names the member refused.
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
      const property = schema.properties[key];
      if (property === undefined) {
        if (schema.additionalProperties === false) throw new TypeError(`${path}.${key} is not a member`);
        continue;
      }
      check(property, value[key], `${path}.${key}`);
    }
  }
};

/** `args` against a tool's `inputSchema`: a TypeError naming the member refused, nothing otherwise. */
const checkArgs = (schema, args) => check(schema, args, 'args');

const tool = (name, description, inputSchema, run) =>
  Object.freeze({
    name,
    description,
    inputSchema,
    async execute(args = {}) {
      checkArgs(inputSchema, args);
      return run(args);
    },
  });

const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const QUERY = {
  type: 'object',
  description: 'A Mango query: { field: value }, $gt/$gte/$lt/$lte/$in/$nin/$ne/$exists/$regex/$and/$or/$not/$text',
};
const ID = { type: 'string', description: 'The record id' };
const SINCE = { type: 'string', description: 'The eventId a `changes` call answered' };

const toolsOf = (db, name, collection, { readOnly, limit: maxLimit }) => {
  const seam = db[SOURCE];
  const select = ({ query = {}, order = [], limit = Math.min(DEFAULT_LIMIT, maxLimit), offset = 0 }) => {
    let cursor = collection.select(query);
    for (let i = 0; i < order.length; i++) {
      const field = order[i];
      cursor = field.startsWith('-') ? cursor.desc(field.slice(1)) : cursor.order(field);
    }
    return cursor.limit(limit).offset(offset);
  };
  // The collection's records the log touched since `since` (an id once, deleted or not), and where to resume; the
  // id to start from alone without `since`; `changes: null` where the log cannot resume there (another epoch, a
  // position compacted away) — list the collection again then.
  const changesSince = (since) => {
    const eventId = db.log.lastEventId;
    if (since === undefined) return { eventId, changes: [] };
    const entries = db.log.since(since);
    if (entries === null) return { eventId, changes: null };
    const changes = [];
    const seen = new Set();
    for (let i = 0; i < entries.length; i++) {
      const { op } = entries[i];
      if (typeof op.id !== 'string' || seen.has(op.id)) continue;
      const row = seam.row(op.id);
      if (row === null || row.type !== name) continue;
      seen.add(op.id);
      changes.push({ id: op.id, deleted: row.gone === true });
    }
    return { eventId, changes };
  };
  // What `changes` answers, once there is something to answer or `timeout` ms passed: the collection's `change`
  // event is listened to before the log is read, so nothing lands between the two unheard.
  const waitChanges = (since, timeout) =>
    new Promise((resolve) => {
      let timer = null;
      const done = () => {
        collection.off('change', done);
        if (timer !== null) clearTimeout(timer);
        resolve(changesSince(since));
      };
      collection.on('change', done);
      const now = changesSince(since);
      if (now.changes === null || now.changes.length > 0) return done();
      timer = setTimeout(done, timeout);
    });
  const tools = [
    tool(
      `${name}_query`,
      `The records of ${name} matching a query — ordered, windowed; ${maxLimit} at most`,
      object({
        query: QUERY,
        order: { type: 'array', items: { type: 'string' }, description: "Fields to order by, '-field' descending" },
        limit: { type: 'integer', minimum: 0, maximum: maxLimit },
        offset: { type: 'integer', minimum: 0 },
      }),
      async (args) => ({ rows: await select(args).fetch() }),
    ),
    tool(
      `${name}_count`,
      `How many records of ${name} match a query`,
      object({ query: QUERY }),
      async ({ query = {} }) => ({
        count: await collection.count(query),
      }),
    ),
    tool(`${name}_get`, `One record of ${name} by id, or null`, object({ id: ID }, ['id']), async ({ id }) => ({
      record: await collection.get(id),
    })),
    tool(
      `${name}_changes`,
      `The records of ${name} changed since an eventId (and the eventId to ask from next); without one, the eventId to start from; changes null where the log cannot resume there — list again then`,
      object({ since: SINCE }),
      ({ since }) => changesSince(since),
    ),
    tool(
      `${name}_wait_changes`,
      `What ${name}_changes answers, once there is a change after the eventId or timeout ms (${DEFAULT_WAIT} by default) passed`,
      object({ since: SINCE, timeout: { type: 'integer', minimum: 0, maximum: MAX_WAIT } }, ['since']),
      ({ since, timeout = DEFAULT_WAIT }) => waitChanges(since, timeout),
    ),
  ];
  if (readOnly) return tools;
  tools.push(
    tool(
      `${name}_insert`,
      `A new record of ${name}; its id`,
      object({ data: { type: 'object' } }, ['data']),
      async ({ data }) => ({
        id: (await collection.insert(data)).id,
      }),
    ),
    tool(
      `${name}_upsert`,
      `A record of ${name} written whole under id — or under the id its data names`,
      object({ id: ID, data: { type: 'object' } }, ['data']),
      async ({ id, data }) => {
        if (id !== undefined) {
          await collection.set(id, data);
          return { id };
        }
        return { id: (await collection.upsert(data)).id };
      },
    ),
    tool(
      `${name}_delete`,
      `The record of ${name} deleted; deleted false where there is none`,
      object({ id: ID }, ['id']),
      async ({ id }) => {
        // Nothing to delete leaves no tombstone; a record of another collection is the collection's NOT_FOUND.
        const row = seam.row(id);
        if (row === null || row.gone === true) return { id, deleted: false };
        await collection.delete(id);
        return { id, deleted: true };
      },
    ),
  );
  return tools;
};

/**
 * The tools over `db`'s collections — every one by default, `collections` names some — as `{ name, description,
 * inputSchema, execute }`: query, count, get, changes, wait_changes per collection, and insert, upsert, delete
 * unless `readOnly`. `limit` caps a query's window (1000 by default).
 */
const createTools = (db, options = {}) => {
  if (db === null || typeof db !== 'object' || typeof db.log?.since !== 'function' || db.collections === undefined) {
    throw new TypeError('createTools() takes a database');
  }
  const { collections = null, readOnly = false, limit = MAX_LIMIT } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new TypeError(`createTools(): limit is 1 to ${MAX_LIMIT}`);
  }
  const all = db.collections;
  const names = collections === null ? Object.keys(all) : collections;
  if (!Array.isArray(names)) throw new TypeError('createTools(): collections is an array of names');
  const tools = [];
  for (let i = 0; i < names.length; i++) {
    const collection = all[names[i]];
    if (collection === undefined) throw new TypeError(`createTools(): no collection ${names[i]}`);
    const made = toolsOf(db, names[i], collection, { readOnly: readOnly === true, limit });
    for (let j = 0; j < made.length; j++) tools.push(made[j]);
  }
  return tools;
};

module.exports = { createTools, checkArgs, MAX_LIMIT };
