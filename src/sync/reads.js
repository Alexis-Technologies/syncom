'use strict';

// The host's reads — `query`, `count` (`unit({ query })`: a thin client's door through the query plugin, in its
// scopes, never a sealed record) and `blob` (an attachment's bytes, served to a peer that names a record in its
// scopes holding the digest) — over the rules of src/sync/rules.js and the `[CURSOR]`/`[SOURCE]` seams; what a
// thin client's call carries as its hello is taken as a hello is and left on the client no longer than the call
// (`greeted`, `ungreet`). Requires rules.js, protocol.js, safe-regex.js, scope.js, shape.js, symbols.js, pem.js, blobs.js only.

const { refuseCall, peerOf, grant } = require('./rules.js');
const { ATTACHMENTS_FIELD } = require('./protocol.js');
const { safeRegex } = require('../query/safe-regex.js');
const { inScope } = require('../scope.js');
const { isPlainObject } = require('../shape.js');
const { CURSOR, DB, SOURCE } = require('../symbols.js');
const { toBase64 } = require('../crypto/pem.js');
const { isDigest } = require('../blobs.js');

// `unit({ query })`: false (the default: no `query`, no `count` mounted), true, or `{ regex }` — whether a `$regex`
// is taken from the wire: false (the default under true: refused, 400 REGEX), 'safe' (one `safeRegex` passes), or
// true (any; a pattern is a denial of the host's event loop — a trusted mesh's).
const REGEX_MODES = new Set([false, true, 'safe']);

const normalizeQuery = (query) => {
  if (query === undefined || query === false) return false;
  if (query === true) return { regex: false };
  if (!isPlainObject(query)) {
    throw new TypeError("unit({ query }): query must be a boolean or { regex: false | true | 'safe' }");
  }
  for (const key of Object.keys(query)) {
    if (key !== 'regex') throw new TypeError(`unit({ query }): unknown key '${key}'`);
  }
  const { regex = false } = query;
  if (!REGEX_MODES.has(regex)) throw new TypeError("unit({ query }): regex must be false, true or 'safe'");
  return { regex };
};

// Every `$regex` a query carries, down every branch and nest, judged by the unit's `regex` mode: refused where
// off, where unsafe under 'safe'. An iterative walk — a query is a peer's — bounded as the cursor bounds it.
const MAX_QUERY_NODES = 4096;

const regexRefusal = (query, mode) => {
  if (mode === true) return null;
  const stack = [query];
  let seen = 0;
  while (stack.length > 0) {
    const value = stack.pop();
    if (++seen > MAX_QUERY_NODES) return 'a query too large to read';
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === 'object' && value[i] !== null) stack.push(value[i]);
      }
      continue;
    }
    if (!isPlainObject(value)) continue;
    for (const key of Object.keys(value)) {
      const inner = value[key];
      if (key === '$regex' || key === '$options') {
        if (mode === false) return 'this host takes no $regex';
        if (key === '$regex' && !safeRegex(inner)) {
          return 'the $regex is not safe to run here (a nested quantifier, a backreference, a lookaround)';
        }
        continue;
      }
      if (typeof inner === 'object' && inner !== null) stack.push(inner);
    }
  }
  return null;
};

// `query` and `count` (`unit({ query: true })`): a thin client's read of this host's records through the query
// plugin — `{ entity, query, order, limit, offset }` — the rows narrowed to the peer's scopes (as the host scopes a
// record, the scope function reading the row; one it throws on is left out) and capped by `limits.rowsPerQuery`.
const BAD_QUERY = 'BAD_QUERY';

const cursorOf = (host, args, procedure, state) => {
  if (!host.query) throw refuseCall(host, procedure, 'This host answers no queries', 403, 'QUERY_DISABLED', state.node);
  if (!isPlainObject(args) || typeof args.entity !== 'string') {
    throw refuseCall(host, procedure, `${procedure} needs an entity`, 400, BAD_QUERY, state.node);
  }
  const query = args.query === undefined || args.query === null ? {} : args.query;
  if (!isPlainObject(query)) throw refuseCall(host, procedure, 'query must be an object', 400, BAD_QUERY, state.node);
  // A pattern from the wire runs on this host's event loop: refused unless the unit takes them (REGEX).
  const refused = regexRefusal(query, host.query.regex);
  if (refused !== null) throw refuseCall(host, procedure, refused, 400, 'REGEX', state.node);
  let cursor;
  try {
    // Through the seam as it is: the collection's sealed records are the key holder's and never a peer's.
    cursor = host.storage[CURSOR](args.entity, query);
    if (Array.isArray(args.order)) {
      for (let i = 0; i < args.order.length; i++) {
        const key = args.order[i];
        if (typeof key === 'string') cursor = cursor.order(key);
        else if (isPlainObject(key) && typeof key.field === 'string') {
          cursor = key.desc === true ? cursor.desc(key.field) : cursor.order(key.field);
        } else throw new TypeError('order: a field name or { field, desc }');
      }
    }
  } catch (error) {
    throw refuseCall(host, procedure, error.message, 400, BAD_QUERY, state.node);
  }
  return cursor;
};

// The peer of a read: greeted before, or — a thin client over a stateless transport, where one request is one
// client and no hello can come first — greeting with the call itself, `args.hello` the hello's own arguments, taken
// as a hello is (authorize, the scopes, the revocations) and kept nowhere: `ephemeral` says so, and the read takes
// the state off the client when it is done (a persistent socket greeted by a read would otherwise push and
// subscribe on a state no session knows of, which no revoke could reach).
const greeted = async (host, context, args, procedure) => {
  let ephemeral = false;
  if (!context?.client?.data?.syncom && isPlainObject(args?.hello)) {
    await host.greet(context, args.hello, false);
    ephemeral = true;
  }
  return { state: peerOf(host, context, procedure), ephemeral };
};

// What a read greeted for the call alone leaves: nothing.
const ungreet = (context, ephemeral) => {
  if (ephemeral && context?.client?.data !== undefined) delete context.client.data.syncom;
};

// A scoped read walks the cursor — in its order, `batch` rows a page — until the window is full or the read budget
// (`limits.rowsPerQuery`: the rows READ, not answered) is spent: a peer whose rows lie past the first ones reads
// them all the same, and `capped` says when the budget ended the walk before the window was full. A sealed row is
// never a peer's (the seam leaves them out; the catalog's row is asked once more, belt and braces).
const SCOPED_BATCH = 100;

const walkScoped = async (host, cursor, scopes, { limit, offset, budget }) => {
  const { row } = host.storage[SOURCE];
  const rows = [];
  let read = 0;
  let skipped = 0;
  const bounded = budget === Infinity ? cursor : cursor.limit(budget);
  for await (const candidate of bounded.stream({ batch: SCOPED_BATCH })) {
    read++;
    if (row(candidate.id)?.encrypted === true) continue;
    let scope;
    try {
      scope = host.scopeOf(candidate.id, candidate);
    } catch (error) {
      host.logger.warn({ event: 'sync.query.scope', id: candidate.id, err: error });
      continue;
    }
    if (!inScope(scope, scopes)) continue;
    if (skipped < offset) {
      skipped++;
      continue;
    }
    rows.push(candidate);
    if (rows.length >= limit) break;
  }
  return { rows, capped: read >= budget && rows.length < limit };
};

const query = (host) => async (context, args) => {
  const { state, ephemeral } = await greeted(host, context, args, 'query');
  try {
    let cursor = cursorOf(host, args, 'query', state);
    const cap = host.limits.rowsPerQuery;
    const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, cap) : cap;
    const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 0;
    const scopes = grant(args.scopes, state.scopes);
    try {
      // A grant of everything: the window is the cursor's, the cap the rows answered. A scoped peer: the cap bounds
      // what is read, the window what goes out.
      if (scopes !== null) {
        const answer = await walkScoped(host, cursor, scopes, { limit, offset, budget: cap });
        host.otel.recordRead('query', answer.capped ? 'capped' : 'ok', answer.rows.length);
        return answer;
      }
      if (limit !== Infinity) cursor = cursor.limit(limit);
      if (offset > 0) cursor = cursor.offset(offset);
      const rows = await cursor.fetch();
      host.otel.recordRead('query', 'ok', rows.length);
      return { rows, capped: false };
    } catch (error) {
      throw refuseCall(host, 'query', error.message, 400, BAD_QUERY, state.node);
    }
  } finally {
    ungreet(context, ephemeral);
  }
};

// An attachment's bytes (`syncom/blob { digest, id, name }`): a wrpc stream of the bytes where the transport carries
// one, the bytes as base64 otherwise. Under `allow.blob` 'named' (the default) the call names the record and the
// attachment: served only where a live record in the peer's scopes names the digest under that name — a record
// forgotten, purged, sealed, out of scope, or naming another digest is one answer, 404 `BLOB_NOT_FOUND`, so nothing
// of what this host holds is told; a revoke, a purge, a forget follow the record for free. Under 'any' the digest
// alone serves (a capability: a trusted mesh's). 403 `NOT_SERVED` where `allow.blob` is off, 400 `BAD_DIGEST` for
// what is no digest, 404 where this host holds no bytes (or has no blobs store).

const blobNamed = async (host, state, digest, id, name) => {
  if (typeof id !== 'string' || typeof name !== 'string') return false;
  const { row, load } = host.storage[SOURCE];
  const held = row(id);
  if (held === null || held.gone === true || held.encrypted === true) return false;
  let data;
  try {
    data = await load(id);
  } catch {
    return false;
  }
  if (data === null) return false;
  const named = data[ATTACHMENTS_FIELD];
  const entry = isPlainObject(named) ? named[name] : undefined;
  if (!isPlainObject(entry) || entry.digest !== digest) return false;
  if (state.scopes === null) return true;
  try {
    return inScope(host.scopeOf(id, data), state.scopes);
  } catch {
    return false;
  }
};

const blob = (host) => async (context, args) => {
  const state = peerOf(host, context, 'blob');
  if (host.allow.blob === false) {
    throw refuseCall(host, 'blob', 'This host serves no blobs', 403, 'NOT_SERVED', state.node);
  }
  const digest = args?.digest;
  if (!isDigest(digest)) {
    throw refuseCall(host, 'blob', 'blob needs a digest (SHA-256, hex)', 400, 'BAD_DIGEST', state.node);
  }
  const notFound = () => refuseCall(host, 'blob', `No blob ${digest} here`, 404, 'BLOB_NOT_FOUND', state.node);
  if (host.allow.blob === 'named' && !(await blobNamed(host, state, digest, args.id, args.name))) throw notFound();
  const store = host.storage[DB]?.blobs;
  const bytes = store === undefined ? null : await store.get(digest);
  if (bytes === null) throw notFound();
  host.otel.recordBlob('served', 'ok', bytes.length);
  const client = context?.client;
  if (client && client.binary !== false && typeof client.createStream === 'function') {
    const stream = client.createStream('syncom/blob', bytes.length);
    queueMicrotask(() => {
      stream.write(bytes);
      stream.end();
    });
    return { id: stream.id, size: bytes.length, digest };
  }
  return { digest, size: bytes.length, base64: toBase64(bytes) };
};

const count = (host) => async (context, args) => {
  const { state, ephemeral } = await greeted(host, context, args, 'count');
  try {
    const cursor = cursorOf(host, args, 'count', state);
    const scopes = grant(args.scopes, state.scopes);
    try {
      if (scopes === null) {
        const total = await cursor.count();
        host.otel.recordRead('count', 'ok', total);
        return { count: total, capped: false };
      }
      // A scoped count reads the rows (the catalog knows no scopes), as many as the budget allows: `capped` says
      // when it ended the count.
      const budget = host.limits.rowsPerQuery;
      const { rows, capped } = await walkScoped(host, cursor, scopes, { limit: Infinity, offset: 0, budget });
      host.otel.recordRead('count', capped ? 'capped' : 'ok', rows.length);
      return { count: rows.length, capped };
    } catch (error) {
      throw refuseCall(host, 'count', error.message, 400, BAD_QUERY, state.node);
    }
  } finally {
    ungreet(context, ephemeral);
  }
};

/**
 * The unit `manager.unit(options)` returns. `access` defaults to wrpc's own
 * default, 'session'; `authorize(context, hello)` gates a peer by whatever
 * the transport presented. `drift(schema, peer)` is the manager's report of
 * a schema that disagrees with this node's.
 */

module.exports = { normalizeQuery, query, count, blob };
