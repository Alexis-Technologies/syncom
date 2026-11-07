'use strict';

// The host's rules, what the procedures of src/sync/hosting.js and src/sync/reads.js stand on: a refusal as it goes
// on the wire (`coded`, `refuse`, `refuseCall`), the peer of a call (`peerOf`: greeted, proven under `prove`), the
// refusals told (`announceRefused`, `refuseOps`), the unit's options checked (`normalizeAllow`, `normalizeLimits`),
// the push limits (`limit`), the scopes a read may cover (`grant`), the proof of the key (`challengeOf`,
// `proveMessage`, the `prove` procedure), and the sessions a revoke reaches (`remember`, `joinRooms`,
// `handPresence`). Requires hooks.js, scope.js, symbols.js only.

const { notify } = require('../hooks.js');
const { proveMessage } = require('./protocol.js');
const { GLOBAL_SCOPE } = require('../scope.js');
const { SIGNER } = require('../symbols.js');

// `unit({ allow })`: which procedures this unit serves; a peer asking for one it does not is refused by code
// (403): `push` as READ_ONLY — the host takes nothing — `snapshot`, `changes` and `blob` as NOT_SERVED. `blob` is
// `'named'` (true: a digest served to a peer that names a record in its scopes holding it — a revoke, a purge, a
// forget follow the record), `'any'` (by digest alone: a capability, a trusted mesh's) or false.
const ALLOW_KEYS = new Set(['push', 'changes', 'snapshot', 'blob']);

const BLOB_MODES = new Set([false, 'named', 'any']);

const normalizeAllow = (allow) => {
  const normalized = { push: true, changes: true, snapshot: true, blob: 'named' };
  if (allow === undefined || allow === null) return normalized;
  if (typeof allow !== 'object') throw new TypeError('unit({ allow }): allow must be an object');
  for (const key of Object.keys(allow)) {
    if (!ALLOW_KEYS.has(key)) throw new TypeError(`unit({ allow }): unknown procedure '${key}'`);
    const value = allow[key];
    if (value === undefined) continue;
    if (key === 'blob') {
      const mode = value === true ? 'named' : value;
      if (!BLOB_MODES.has(mode)) throw new TypeError("unit({ allow }): blob is false, true ('named') or 'any'");
      normalized.blob = mode;
      continue;
    }
    if (typeof value !== 'boolean') throw new TypeError(`unit({ allow }): ${key} must be a boolean`);
    normalized[key] = value;
  }
  return normalized;
};

// A refusal as it goes on the wire: the numeric `code` a transport carries
// (wrpc sends code and message), and `reason` — a constant naming which
// check refused — for the host's own logs and listeners.
const coded = (message, code, reason) => {
  const error = new Error(message);
  error.code = code;
  error.reason = reason;
  error.expose = true;
  return error;
};

const LIMIT_KEYS = new Set(['opsPerPush', 'bytesPerPush', 'opsPerSecond', 'rowsPerQuery']);

// The rows one `query` answers at most, and a scoped `count` reads, when the host says nothing.
const DEFAULT_ROWS_PER_QUERY = 500;

// The ops one push may carry when the host says nothing: twenty pages of a
// dialer's default size. A page that size is a peer gone wrong — or one
// that wants this node's memory — and is refused at a length check, before
// a byte of it is read. `limits: { opsPerPush: Infinity }` lifts it; the
// bytes and the rate have no default (the byte count serializes every page).
const DEFAULT_OPS_PER_PUSH = 10_000;

// `unit({ limits })`: each a positive number (Infinity for none), unknown keys refused. A limit that is Infinity is
// kept as such: a reader tests `=== Infinity`, never the key's absence.
const normalizeLimits = (limits) => {
  const normalized = { opsPerPush: DEFAULT_OPS_PER_PUSH, rowsPerQuery: DEFAULT_ROWS_PER_QUERY };
  if (limits === undefined || limits === null) return normalized;
  if (typeof limits !== 'object') throw new TypeError('unit({ limits }): limits must be an object');
  for (const key of Object.keys(limits)) {
    if (!LIMIT_KEYS.has(key)) throw new TypeError(`unit({ limits }): unknown limit '${key}'`);
    const value = limits[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
      throw new TypeError(`unit({ limits }): ${key} must be a positive number`);
    }
    normalized[key] = value;
  }
  return normalized;
};

// The scopes a read may cover: what hello granted, narrowed to what the
// call asks for. A peer granted `'*'` reads what it asks (nothing asked:
// everything); one granted a list reads the intersection — asking for `'*'`
// or for nothing is asking for its list, asking only for others is 403.
const grant = (asked, granted) => {
  const everything = granted.includes(GLOBAL_SCOPE);
  if (!Array.isArray(asked)) return everything ? null : granted;
  const held = everything ? null : new Set(granted);
  const scopes = [];
  for (let i = 0; i < asked.length; i++) {
    const scope = asked[i];
    if (typeof scope !== 'string') continue;
    if (held === null) scopes.push(scope);
    else if (scope === GLOBAL_SCOPE) return granted;
    else if (held.has(scope)) scopes.push(scope);
  }
  if (held === null) return scopes;
  if (scopes.length === 0) throw coded('Scopes not granted', 403, 'SCOPES');
  return scopes;
};

// Per-peer push limits, the one place that knows the ops and the bytes:
// a page over `opsPerPush` or `bytesPerPush` is 413, a peer over
// `opsPerSecond` is 429 — a token bucket in its state, refilled at that
// rate, holding one second's worth. Codes, not a hang-up: the dialer
// reports them, marks the host behind and pushes again from the vector at
// the next sign of life on the link (`#recover` in src/sync/manager.js).
const encoder = new TextEncoder();
const limit = (otel, state, args, ops, limits) => {
  const { opsPerPush, bytesPerPush, opsPerSecond } = limits;
  if (opsPerPush !== undefined && ops.length > opsPerPush) {
    otel.recordLimited('ops');
    throw coded(`Push of ${ops.length} ops exceeds opsPerPush ${opsPerPush}`, 413, 'OPS_PER_PUSH');
  }
  if (bytesPerPush !== undefined) {
    const bytes = encoder.encode(JSON.stringify(args?.ops ?? null)).length;
    if (bytes > bytesPerPush) {
      otel.recordLimited('bytes');
      throw coded(`Push of ${bytes} bytes exceeds bytesPerPush ${bytesPerPush}`, 413, 'BYTES_PER_PUSH');
    }
  }
  if (opsPerSecond !== undefined) {
    const at = Date.now();
    const bucket = (state.bucket ??= { tokens: opsPerSecond, at });
    bucket.tokens = Math.min(opsPerSecond, bucket.tokens + ((at - bucket.at) / 1000) * opsPerSecond);
    bucket.at = at;
    if (ops.length > bucket.tokens) {
      otel.recordLimited('rate');
      throw coded(`Rate limited: ${ops.length} ops over opsPerSecond ${opsPerSecond}`, 429, 'OPS_PER_SECOND');
    }
    bucket.tokens -= ops.length;
  }
};

// A refusal before the handler: counted by code and reason; 428 is the normal course
// of a wrpc reconnect (a new server-side client) and only counted.
const refuse = (host, message, code, reason, node = null) => {
  host.otel.recordRefusal(code, reason);
  if (code !== 428) host.logger.warn({ event: 'sync.hello.refused', code, reason, node });
  return coded(message, code, reason);
};

// What a hello hands a peer to sign: 32 random bytes as base64url, bound to both node ids in the message.
const challengeOf = () => {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// A call this unit does not serve, or cannot: counted, logged under the procedure's event, refused by code.
const refuseCall = (host, procedure, message, code, reason, node = null) => {
  host.otel.recordRefusal(code, reason);
  host.logger.warn({ event: `sync.${procedure}.refused`, code, reason, node });
  return coded(message, code, reason);
};

const peerOf = (host, context, procedure = null) => {
  const state = context?.client?.data?.syncom;
  if (!state) throw refuse(host, 'Say hello first', 428, 'HELLO_FIRST');
  // Under `prove` nothing is taken or handed before the peer signed the challenge its hello was given.
  if (procedure !== null && host.prove && state.proven !== true) {
    throw refuseCall(host, procedure, 'Prove the key first (syncom/prove)', 403, 'UNPROVEN', state.node);
  }
  return state;
};

// Ops of a peer this host would not take, logged and announced through the
// `refused` event — where the host ties a refusal to the client that pushed.
const announceRefused = (host, node, reason, count) => {
  host.logger.warn({ event: 'sync.op.refused', node, reason, count });
  notify(host.manager, host.logger, 'refused', { node, reason, count });
};

// Refused HERE, before anything sees them: counted too — `reason` is what
// the `syncom.ops.rejected` metric carries. (A signature refusal is counted
// per op in applyRemote already, and only announced here.)
const refuseOps = (host, node, reason, count) => {
  for (let i = 0; i < count; i++) host.otel.recordRejected(reason);
  announceRefused(host, node, reason, count);
};

// The rooms of the scopes a persistent peer asked for: where a presence update of a scope is relayed.
const joinRooms = (context, scopes) => {
  if (typeof context.client.join !== 'function') return;
  for (const scope of scopes) context.client.join(`syncom:${scope}`);
};

// The live session of a greeted peer, by node, for `sync.revoke(node, scopes)`: told at once through the
// server (`syncom/revoke`), its grant narrowed, its feeds ended. A session is let go of when the same client
// greets again, when its socket closes (the client's `close` — wrpc hands a reconnect a new client, so a session
// outlived by its socket would stay for good), and the node's set with its last one.
const remember = (host, context, state) => {
  const { client, server } = context;
  let sessions = host.sessions.get(state.node);
  if (sessions === undefined) host.sessions.set(state.node, (sessions = new Set()));
  for (const session of sessions) if (session.client === client) sessions.delete(session);
  const session = {
    client,
    revoke(scopes) {
      const taken = new Set(scopes);
      const kept = [];
      for (let i = 0; i < state.scopes.length; i++) if (!taken.has(state.scopes[i])) kept.push(state.scopes[i]);
      state.scopes = kept;
      state.generation++;
      if (server && typeof server.sendTo === 'function' && client?.id !== undefined) {
        server.sendTo(client.id, 'syncom/revoke', { scopes: scopes.slice() });
      }
    },
  };
  sessions.add(session);
  if (typeof client?.once === 'function') {
    client.once('close', () => {
      const held = host.sessions.get(state.node);
      if (held === undefined) return;
      held.delete(session);
      if (held.size === 0) host.sessions.delete(state.node);
    });
  }
};

// `prove`: the challenge hello handed this peer, signed under its key — the key that is its node id.
const prove = (host) => async (context, args) => {
  const state = peerOf(host, context);
  const sig = args?.sig;
  if (state.challenge === null || typeof sig !== 'string') {
    throw refuseCall(host, 'prove', 'Nothing to prove, or no signature', 400, 'BAD_PROOF', state.node);
  }
  const signer = host.storage[SIGNER];
  let ok = false;
  try {
    ok = await signer.verifyMessage(proveMessage(state.challenge, host.storage.nodeId, state.node), sig, state.node);
  } catch {
    ok = false;
  }
  if (ok !== true) {
    throw refuseCall(host, 'prove', 'The signature does not prove the key', 403, 'BAD_PROOF', state.node);
  }
  state.proven = true;
  state.challenge = null;
  // Proven: the rooms joined and the presence handed now, what hello withheld.
  if (state.keep === true) {
    joinRooms(context, state.scopes);
    handPresence(host, context, state.scopes);
  }
  return { proven: true };
};

// What a newcomer is handed at hello: the room's states of every scope it asked for.
const handPresence = (host, context, scopes) => {
  const server = context?.server;
  const client = context?.client;
  if (!server || typeof server.sendTo !== 'function' || !client || client.id === undefined) return;
  const floor = Date.now() - host.presence.timeout;
  const self = client.data?.syncom?.node;
  const { rooms } = host.presence;
  const seen = new Set();
  for (let i = 0; i < scopes.length; i++) {
    const scope = scopes[i];
    if (seen.has(scope)) continue;
    seen.add(scope);
    const room = rooms.get(scope);
    if (room === undefined) continue;
    const s = [];
    for (const entry of room.values()) if (entry[2] >= floor && entry[0] !== self) s.push(entry);
    if (s.length > 0) server.sendTo(client.id, 'syncom/presence', { p: 1, scope, s });
  }
};

module.exports = {
  coded,
  refuse,
  refuseCall,
  peerOf,
  announceRefused,
  refuseOps,
  normalizeAllow,
  normalizeLimits,
  limit,
  grant,
  challengeOf,
  proveMessage,
  prove,
  joinRooms,
  remember,
  handPresence,
};
