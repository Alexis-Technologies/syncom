'use strict';

// The one local write path: `storage[COMMIT]` lands here, inside the
// mutation queue. The op is built, applied, validated, logged (a durable
// seq), persisted, then announced — in that order, for every kind of local
// write (`write`, `set`, `inc`, `add`, `remove`, `splice`, `assign`, `move`,
// `mark`, `tree`, `delete`, `purge`; a bootstrap's merges go through
// src/bootstrap.js). `core` is what Storage lends its write paths:
// the log, the clock, the chain, the entries, the hook runner and the
// lensed readers — see Storage#open.

const { applyOp, isAlive, latestClock, observedTags, kindOf, kindsOf } = require('./ops.js');
const { missing } = require('./plugin.js');
const { opKey } = require('./vector.js');
const { notify } = require('./hooks.js');
const { ValidationError } = require('./errors.js');
const { project, unproject, foldSet } = require('./entity.js');
const { fieldName } = require('./args.js');
const { traced, now } = require('./telemetry.js');
const { GLOBAL_SCOPE } = require('./scope.js');
const { isPlainObject, asJson, VALIDATED, MAX_MESSAGE, isRecordId, invalidId } = require('./shape.js');
const { ancestorsOf } = require('./paths.js');
const { compose, composeData } = require('./compose.js');
const { SyncomError, typed } = require('./errors.js');

// What a commit came to: an op, `null` for a write that changed nothing,
// `undefined` for an encrypted record (saved locally, no op), and MISMATCH
// for a swap whose expectation no longer held.
const MISMATCH = Symbol('syncom.mismatch');
const commitResult = (op) => (op === undefined ? 'encrypted' : op === null || op === MISMATCH ? 'noop' : 'applied');

// `$type` names the collection a record belongs to and never changes: a
// whole-record write that does not name it keeps it, and neither a write nor
// a set may name another. A peer's op is applied as it is — it is already in
// the peer's log, and the collection membership it carries is theirs to keep.
const sameType = (type, id, data, current) => {
  const before = current?.$type;
  if (before === undefined) return data;
  if (data.$type === undefined) return type === 'write' ? { ...data, $type: before } : data;
  if (data.$type !== before) throw typed('TYPE_IMMUTABLE', `Record ${id} is a ${before}; $type is immutable`);
  return data;
};

// The field-kind rule, refused with a hint at the right call; a plugin's
// kind brings its own hint (src/plugin.js `hints`).
const HINTS = {
  register: 'a register; use update()',
  counter: 'a counter; use inc()',
  set: 'a set; use add() or remove()',
  bound: "past a bound: pending work, a run, the field as a whole or a counter's range (see Costs and limits)",
};
// `malformed` is a payload the engine does not admit after the arguments
// were checked — a bug in the caller or here, never a peer's doing on this
// path — so it is a TypeError, not a coded failure.
const refuse = (core, id, rejected) => {
  if (rejected.length === 0) return;
  const [{ field, reason, detail, count, max }] = rejected;
  if (reason === 'malformed') {
    throw new TypeError(`Field ${field} of record ${id}: the engine does not admit this payload`);
  }
  if (reason === 'member') {
    const { prefix, member } = rejected[0];
    const message = `Field ${field} of record ${id}: ${prefix} has no element or node ${member}`;
    throw new SyncomError('NOT_FOUND', message, { id, field: prefix, elem: member });
  }
  const fields = { field, kind: reason };
  if (detail !== undefined) Object.assign(fields, { detail, count, max });
  if (rejected[0].prefix !== undefined) fields.prefix = rejected[0].prefix;
  const hint = HINTS[reason] ?? core.plugins.hints[reason] ?? `held by another kind (${reason})`;
  const where = fields.prefix === undefined ? `Field ${field}` : `Field ${field} lies under ${fields.prefix}, which`;
  throw new SyncomError('FIELD_KIND', `${where} of record ${id} is ${hint}`, fields);
};

// A swap's expectation, checked inside the queue against the record as it
// reads: a live one, or an encrypted one's data.
const expectation = async (core, id, current, expect) => {
  let seen = null;
  if (current?.encrypted) seen = current.data;
  else if (current && isAlive(current)) seen = await core.view(id, current);
  if (!seen) throw new SyncomError('NOT_FOUND', `Record ${id} not found`, { id });
  for (const key of Object.keys(expect)) if (seen[key] !== expect[key]) return false;
  return true;
};

// beforeWrite may hand back the data a write or set should carry instead.
const replaced = async (core, type, payload, ctx) => {
  const replacement = await core.hook('beforeWrite', ctx);
  if (replacement === undefined) return payload;
  if (type !== 'write' && type !== 'set') {
    throw new TypeError('beforeWrite may only replace data for write and set');
  }
  if (!isPlainObject(replacement)) throw new TypeError('beforeWrite must return a plain object or undefined');
  ctx.data = replacement;
  return { ...payload, data: replacement };
};

// Encrypted at rest for THIS node's key: written directly, outside the op
// log, because no peer could read it.
const seal = async (core, id, data) => {
  if (core.seal === null) throw missing('an encrypted record', 'encryption');
  const record = await core.seal.encrypt(data);
  const blockHash = core.chain ? await core.chain.addBlock({ id, hash: await core.hash(record) }) : null;
  await core.entries.writeSealed(id, record, data, blockHash);
  core.flush();
};

const unseal = async (core, id) => {
  await core.entries.remove(id);
  core.flush();
};

// A write to a sealed record: set and write map onto the encrypted save, a
// delete or purge removes it; a counter or a set needs ops.
const commitSealed = async (core, type, id, payload, current, ctx, source) => {
  let data;
  if (type === 'write') data = payload.data;
  else if (type === 'set') data = { ...(current?.data ?? {}), ...payload.data };
  else if (type === 'delete' || type === 'purge') data = null;
  else throw new SyncomError('ENCRYPTED', `Record ${id} is encrypted; ${type} needs a replicated record`);
  if (data === null) await unseal(core, id);
  else await seal(core, id, data);
  try {
    await core.hook('afterWrite', ctx, null);
  } finally {
    core.refresh(id, data, data === null ? {} : { ...data }, source);
  }
  return undefined;
};

// The record as the op leaves it, as far as its scope goes: a write's own
// data, a set's on top of the record's, the record's for the rest (a delete
// or a purge empties it, but the op still belongs where the record was). A
// set's delta alone would name no scope a field-based `sync.scope` reads,
// and the op would go to every peer.
const scopeData = (type, payload, current) => {
  const data = current?.data ?? {};
  if (type === 'write') return payload.data ?? data;
  if (type === 'set') return { ...data, ...payload.data };
  if (type === 'unset') {
    const left = { ...data };
    for (const field of payload.value) delete left[field];
    return left;
  }
  return data;
};

// The op's stream: its scope, and the next seq there (seqs run per stream,
// see vector.js opKey).
const assignScope = (core, op, data) => {
  const scope = core.scopeOf(op.id, composeData(data));
  if (scope === GLOBAL_SCOPE) delete op.scope;
  else op.scope = scope;
  op.seq = core.seqOf(opKey(op)) + 1;
};

// Of a remove's observed tags, those of one origin; an element with none is left out.
const ownTags = (removals, origin) => {
  const out = [];
  for (const [element, tags] of removals) {
    if (Object.hasOwn(tags, origin)) out.push([element, { [origin]: tags[origin] }]);
  }
  return out;
};

// The op as this node mints it: stamped above everything the node already
// holds for the record, so a local write never sorts below state the node
// knows about and is silently dropped (the log seeds the clock at open; this
// covers what the log no longer has), numbered in its stream.
// The kinds each op may land on. Locally, a field of another kind is refused
// — with the hint for the right call — before a stamp is minted or an index
// read, for a call and for a patch alike; applyOp would let the higher rank
// win (src/ops.js yieldTo), which is a peer's right, not a local caller's.
const TAKES = {
  write: ['register'],
  set: ['register'],
  inc: ['counter'],
  add: ['set'],
  remove: ['set'],
};
// A plugin's op names the kinds it takes itself (a splice by its content —
// a string a text, an array a list — and one that only removes takes the
// field's).
const takesOf = (type, payload, plugins) => plugins.byType[type]?.takes(type, payload) ?? TAKES[type];
const kindClash = (type, payload, current, plugins) => {
  const takes = takesOf(type, payload, plugins);
  if (!current || current.encrypted) return [];
  const fields = type === 'write' || type === 'set' ? Object.keys(payload.data ?? {}) : [payload.key];
  const rejected = [];
  for (const field of fields) {
    if (typeof field !== 'string') continue;
    // A prefix a counter, a set or a text holds refuses every op under it;
    // under a list or a tree the next segment must name a member that is
    // there (NOT_FOUND otherwise, raised by the caller from `member`).
    let member = null;
    for (const prefix of ancestorsOf(field)) {
      if (member !== null) {
        member = null;
        continue;
      }
      const above = kindOf(current, prefix, plugins);
      if (above === undefined || above === 'register') continue;
      const mod = plugins.byName[above];
      if (mod?.nests?.[above] === true) {
        member = field.slice(prefix.length + 1).split('/')[0];
        if (!mod.holds(current, prefix, member)) rejected.push({ field, reason: 'member', prefix, member });
        continue;
      }
      rejected.push({ field, reason: above, prefix });
      break;
    }
    if (takes === undefined) continue;
    const kind = kindOf(current, field, plugins);
    if (kind !== undefined && !takes.includes(kind)) rejected.push({ field, reason: kind });
  }
  return rejected;
};

const prepareOp = (core, type, id, payload, current, who, from) => {
  refuse(core, id, kindClash(type, payload, current, core.plugins));
  core.observe(latestClock(current?.meta, true));
  const op = { origin: core.nodeId, seq: 0, ts: core.clock.now(), type, id };
  if (from) op.from = from;
  // The writer's schema version rides on the op: what a reader on another
  // version lenses the record through.
  if (core.version !== null) op.v = core.version;
  if (who !== null) op.actor = who;
  assignScope(core, op, scopeData(type, payload, current));
  if (payload.data !== undefined) op.data = payload.data;
  if (payload.key !== undefined) op.key = payload.key;
  if (payload.value !== undefined) op.value = payload.value;
  // An unset names the fields the record holds — or has something under
  // (a prefix of paths); the others are nothing to remove.
  if (type === 'unset') {
    const held = new Set();
    if (current && !current.encrypted) {
      for (const key of Object.keys(current.data)) {
        held.add(key);
        const above = ancestorsOf(key);
        for (let i = 0; i < above.length; i++) held.add(above[i]);
      }
    }
    const fields = [];
    for (let i = 0; i < payload.value.length; i++) if (held.has(payload.value[i])) fields.push(payload.value[i]);
    op.value = fields;
  }
  // A remove names the tags this node observed, read here, inside the
  // queue — read outside it, a concurrent apply could add between the two —
  // or exactly the tags a patch names (an undo revokes its own add alone).
  if (type === 'remove') {
    op.value = payload.removals ?? observedTags(current?.meta ?? null, payload.key, payload.value);
    // `own`: this node's adds alone — an undo revokes what this node added
    // and leaves what a peer added meanwhile.
    if (payload.own === true) op.value = ownTags(op.value, core.nodeId);
  }
  // A plugin's op: what travels is resolved inside the queue, against the
  // record as it is — an index into an anchor, a sibling into a place.
  const mod = core.plugins.byType[type];
  if (mod !== undefined) op.value = mod.resolve(core, id, type, payload, current);
  else if (!Object.hasOwn(TAKES, type) && !CORE.has(type)) throw missing(`a ${type} op`);
  return op;
};

// The ops the core makes itself; every other type of the protocol is a plugin's.
const CORE = new Set(['write', 'set', 'unset', 'inc', 'add', 'remove', 'delete', 'purge', 'merge']);

// A unique key another record holds: refused here, where one writer can be
// told. Two concurrent writers on two nodes cannot be — see the `conflict`
// event on the apply path.
const assertUnique = async (core, id, entry) => {
  const conflicts = await core.conflicts(id, entry);
  if (conflicts.length === 0) return;
  const issues = [];
  for (let i = 0; i < conflicts.length; i++) {
    const { fields, other } = conflicts[i];
    issues.push({ path: fields, message: `is not unique (held by ${other})`, code: 'unique', conflict: other });
  }
  throw new ValidationError(entry.data.$type, issues);
};

// The op applied, and validated as the record will be after it. What the
// validator gives back (defaults, aliases, stripped keys) becomes the op:
// the peers receive the validated record, not the one that was typed. A
// throw leaves nothing durable. An `inc`, `add` or `remove` is checked but
// carries no data to fold. Returns `{ entry, delta }`, or null for an op that
// changes nothing.
const validateLocal = async (core, op, current, visible, ctx) => {
  const { id, type } = op;
  let { entry, changed, delta, rejected, changes } = applyOp(current, op, core.limits);
  refuse(core, id, rejected);
  if (!changed) return null;
  const def = core.definitionOf(entry.data);
  if (def?.validator && VALIDATED.has(type)) {
    // Through the lens: a record of an older version is validated as it
    // reads, and a set is folded against how it read before the write.
    const output = await def.validator(project(def, id, await core.view(id, entry)));
    if (type === 'write' || type === 'set') {
      const validated = unproject(def, output, entry.data.$type);
      if (type === 'write') op.data = validated;
      else op.data = foldSet(op.data, validated, visible ? project(def, id, await core.view(id, current)) : {});
      ctx.data = op.data;
      ({ entry, changed, delta, rejected, changes } = applyOp(current, op, core.limits));
      refuse(core, id, rejected);
      if (!changed) return null;
    }
  }
  if (VALIDATED.has(type)) await assertUnique(core, id, entry);
  return { entry, delta, changes };
};

// Inside the queue: signed, then appended — the seq reserved, the ticket
// the durability — and the entry made the record's in-flight state, what
// the next write of the record builds on. The signature is made here and
// nowhere earlier: validateLocal rewrote `op.data`, and what the peers
// receive is what must verify. The queue is free from here: the disk is
// waited for outside it.
const issue = async (core, op, entry) => {
  // Alone, the op is signed here; with writes queued behind it, on the
  // thread pool while the queue moves on — the group's file waits for it.
  let ready = null;
  if (core.sign !== null) {
    if (core.pipelined()) ready = core.sign(op, true);
    else await core.sign(op, false);
  }
  const ticket = core.log.append([op], ready === null ? undefined : { ready });
  const position = ticket.entries[0].seq;
  core.inflight(op.id, entry, position);
  return { ticket, position };
};

// Outside the queue, in log order: once the op is on disk, the chain block
// and the record file (or the deferred slot, under `open({ defer })`), the
// log told the batch landed, the entry no longer in flight. A group that
// did not reach the disk rejects the ticket — the storage has dropped the
// in-flight entry already — and the write fails with it.
const land = async (core, op, entry, { ticket, position }) => {
  const { id } = op;
  await ticket;
  // Logged: the write is durable from here and replicates from the log.
  // Under `open({ defer })` the file and the block wait for the flush
  // (Storage#deferWrite): held in memory, the batch unapplied until then.
  if (core.defer > 0) {
    await core.deferred(id, entry, position);
    core.settled(id, position);
    core.flush();
    return position;
  }
  // A block or a file that fails now holds the entry in memory, leaves the
  // batch unapplied (the next open replays it) and is reported — the write
  // itself stands.
  try {
    let blockHash = null;
    if (core.chain) {
      const hash = await core.hash(entry.data);
      blockHash = await core.chain.addBlock({ id, hash, from: core.log.formatId(position) });
    }
    await core.entries.write(id, entry, blockHash);
    core.log.applied(position);
  } catch (error) {
    await core.unpersisted(new Map([[id, entry]]), error);
  }
  core.settled(id, position);
  core.flush();
  return position;
};

// afterWrite sees a durable op; whatever it does, the record views and the
// `change` listeners (the relay among them) hear about the op. `via` is null
// for a local write; a merge made from a peer's snapshot names that peer, so
// the relay does not hand its own state straight back to it.
const announce = async (core, op, entry, delta, ctx, source, via, committed = null, changes = []) => {
  const alive = isAlive(entry);
  try {
    await core.hook('afterWrite', ctx, op);
  } finally {
    core.refresh(op.id, alive ? entry.data : null, delta, source, entry);
    // What an undo manager keeps of a local commit: the record before and
    // after, as copies, and every field's kind — built only for a listener.
    if (committed !== null && core.storage.listenerCount('commit') > 0) {
      notify(core.storage, core.logger, 'commit', commitEvent(core, op, entry, alive, committed, source, changes));
    }
    notify(core.storage, core.logger, 'change', op, via, { changes });
  }
};

// The `commit` event: `before` and `after` are copies of the record and
// `embeds` what its fields hold beside the reading (a text's markers), each
// side — all three taken at the first read and kept, never on the write
// path: an undo manager keeps a step's first `before` and last `after`, and
// copying a large record twice per keystroke cost the record (the data
// objects are never changed in place, so a late copy is the same copy).
const commitEvent = (core, op, entry, alive, committed, source, changes) => {
  const { seq, before, previous, txn } = committed;
  const data = alive ? entry.data : null;
  const kinds = { ...kindsOf(previous, core.plugins), ...kindsOf(entry, core.plugins) };
  let beforeCopy;
  let afterCopy;
  let embeds;
  return {
    op,
    seq,
    txn,
    source,
    kinds,
    changes,
    get before() {
      if (beforeCopy === undefined) beforeCopy = asJson(before) ?? null;
      return beforeCopy;
    },
    get after() {
      if (afterCopy === undefined) afterCopy = data === null ? null : asJson(data);
      return afterCopy;
    },
    // What a field holds beside its reading, each side — null on both when
    // nothing does: an inverse that lays a cut marker again needs its value.
    get embeds() {
      if (embeds === undefined) {
        const was = valuesOf(core.plugins, previous);
        const now = alive ? valuesOf(core.plugins, entry) : null;
        embeds = was === null && now === null ? null : { before: was, after: now };
      }
      return embeds ?? undefined;
    },
  };
};

// One turn's worth of ops announced as a whole — a local write, a
// transaction, a peer's page, a joined snapshot — with every change tagged
// by its record: what a view updates itself by, once.
const transacted = (core, { local, via, source, message, ops, changes }) => {
  if (ops.length === 0 || core.storage.listenerCount('transaction') === 0) return;
  const ts = ops[ops.length - 1].ts;
  notify(core.storage, core.logger, 'transaction', { local, via, source, message, ops, changes, ts });
};

// The changes of an op tagged with its record, for a transaction event:
// pushed onto `into`.
const tagged = (op, changes, into = []) => {
  for (let i = 0; i < changes.length; i++) into.push({ id: op.id, ...changes[i] });
  return into;
};

// Per field, what a plugin's kind holds beside the reading — a text's
// embed markers by index — or null when nothing does.
const valuesOf = (plugins, entry) => {
  if (entry === null || !isAlive(entry)) return null;
  let out = null;
  const kinds = kindsOf(entry, plugins);
  for (const field of Object.keys(kinds)) {
    const mod = Object.hasOwn(plugins.byName, kinds[field]) ? plugins.byName[kinds[field]] : undefined;
    const values = mod?.values?.(entry, field);
    if (values != null) (out ??= {})[field] = asJson(values);
  }
  return out;
};

// The payload taken as JSON — a copy, like the disk and the peers hold it —
// before anything keeps a reference to it: the data, a value, a content, the
// tags a remove names.
const copyPayload = (payload) => {
  if (payload.data !== undefined) payload = { ...payload, data: asJson(payload.data) };
  if (payload.value !== undefined && typeof payload.value === 'object') {
    payload = { ...payload, value: asJson(payload.value) };
  }
  if (payload.content !== undefined) payload = { ...payload, content: asJson(payload.content) };
  if (payload.removals !== undefined) payload = { ...payload, removals: asJson(payload.removals) };
  if (payload.vals !== undefined) payload = { ...payload, vals: asJson(payload.vals) };
  return payload;
};

// Every op of a batch resolved and applied over a scratch record, in order,
// each against the result of the one before — what applyPatches() does
// before it appends anything, so an index out of range, a kind clash, a
// cycle or a type change refuses the batch whole. Hooks and validators are
// not run here; they run on the real commits, which may still refuse.
const rehearse = async (core, id, ops) => {
  let current = await core.current(id);
  if (current?.encrypted) return;
  for (const [type, given] of ops) {
    const payload = copyPayload(given);
    const visible = current && isAlive(current) ? compose(current, core.plugins) : null;
    if (type === 'write' || type === 'set') payload.data = sameType(type, id, payload.data, visible);
    const op = prepareOp(core, type, id, payload, current, null, null);
    // A plugin's op that resolved to nothing (a tree move to where the node is): nothing to write.
    if (op.value === null) continue;
    if (type === 'unset' && op.value.length === 0) continue;
    const { entry, changed, rejected } = applyOp(current, op, core.limits);
    refuse(core, id, rejected);
    if (changed) current = entry;
  }
};

// What a commit came to, for the facade: the op (or null, undefined,
// MISMATCH — see commitResult) and `done`, the landing the caller awaits —
// the disk, the file, the hooks and the listeners, in log order — or null
// when nothing was appended.
const outcome = (op, done = null) => ({ op, done });

// A message on the ops of a transaction or a patch batch: a string of at
// most MAX_MESSAGE characters, in the signed header, listed by history().
const messageArg = (message) => {
  if (message === undefined || message === null) return undefined;
  if (typeof message !== 'string' || message.length > MAX_MESSAGE) {
    throw new TypeError(`message takes a string of at most ${MAX_MESSAGE} characters`);
  }
  return message;
};

// The op of a local write, made and applied inside the queue — the hooks,
// the validator, the unique keys — up to the append: `{ op }` alone when
// nothing is to be appended (null, undefined or MISMATCH, see
// commitResult; `sealed` for an encrypted write, which is on disk already),
// else the op with the entry it leaves, the delta, the hook context and
// what the commit event needs.
const prepare = async (core, type, id, payload, options) => {
  const { source = null, via = null, from = null, encrypted = false, actor, expect = null, message } = options;
  const msg = messageArg(message);
  const current = await core.current(id);
  if (encrypted && current && !current.encrypted) {
    throw new SyncomError('ENCRYPTED', `Record ${id} is replicated and cannot become encrypted`);
  }
  if (expect !== null && !(await expectation(core, id, current, expect))) return { op: MISMATCH };
  payload = copyPayload(payload);
  // Sealed: this write is encrypted, or the record already is. An
  // encrypted record has no op log — writes to it stay local.
  const sealed = encrypted || current?.encrypted === true;
  // The record as the application reads it — its paths composed — for the
  // hooks and the commit event; the op model keeps the paths apart.
  const visible = current && (current.encrypted || isAlive(current)) ? compose(current, core.plugins) : null;
  const who = await core.actorOf(actor);
  const ctx = {
    type,
    id,
    ...payload,
    current: visible,
    encrypted: sealed,
    source,
    via,
    from,
    v: core.version,
    actor: who,
  };
  payload = await replaced(core, type, payload, ctx);
  if (sealed) return { op: await commitSealed(core, type, id, payload, current, ctx, source), sealed: true };
  if (type === 'write' || type === 'set') {
    // Every key a field name or a path of them: a key that is neither would
    // be left out of the op without a word.
    for (const key of Object.keys(payload.data ?? {})) fieldName(type === 'write' ? 'set' : 'update', key);
    ctx.data = sameType(type, id, payload.data, visible);
    payload = { ...payload, data: ctx.data };
  }
  const op = prepareOp(core, type, id, payload, current, who, from);
  if (msg !== undefined) op.msg = msg;
  // A plugin's op that resolved to nothing — a tree move to where the node
  // already is — writes nothing.
  if (op.value === null && core.plugins.byType[type] !== undefined) return { op: null };
  // An unset of nothing the record holds writes nothing.
  if (type === 'unset' && op.value.length === 0) return { op: null };
  const applied = await validateLocal(core, op, current, visible, ctx);
  if (applied === null) return { op: null };
  // The validator may have filled the field the scope reads (a default):
  // the stream is the one of the record as it is written.
  if (type === 'write' || type === 'set') assignScope(core, op, applied.entry.data);
  const previous = current && !current.encrypted ? current : null;
  // The commit event's `before` is the record in the op model's terms — the
  // paths apart, as the entry holds them — what an undo takes a step back by.
  const before = previous !== null && isAlive(previous) ? previous.data : null;
  const { entry, delta, changes } = applied;
  return { op, entry, delta, changes, ctx, source, via, before, previous };
};

const commitLocal = async (core, type, id, payload, options) => {
  const prepared = await prepare(core, type, id, payload, options);
  const { op } = prepared;
  if (op === null || op === undefined || op === MISMATCH || prepared.sealed === true) return outcome(op);
  const { entry, delta, changes, ctx, source, via, before, previous } = prepared;
  const issued = await issue(core, op, entry);
  const done = core.landing(async () => {
    const seq = await land(core, op, entry, issued);
    await announce(core, op, entry, delta, ctx, source, via, { seq, before, previous, txn: seq }, changes);
    const message = op.msg ?? null;
    transacted(core, { local: true, via, source, message, ops: [op], changes: tagged(op, changes) });
  });
  return outcome(op, done);
};

// The unique keys a transaction's own writes would share: the records it
// touched are not in the catalog nor in flight yet, so they are checked by
// hand, after the storage's own check.
const conflictsIn = async (core, touched, id, entry) => {
  const found = await core.conflicts(id, entry);
  const def = core.definitionOf(entry.data);
  if (!def || def.unique.length === 0) return found;
  const view = await core.view(id, entry);
  // Each (holder, key) once: the storage's own finds first.
  const seen = new Set();
  for (let i = 0; i < found.length; i++) seen.add(`${found[i].other}\0${found[i].fields.join(',')}`);
  // This record's keys, read once for every record the transaction touched.
  const mine = [];
  for (const key of def.unique) mine.push(core.catalog.uniqueKey(view, key));
  for (const [other, held] of touched) {
    if (other === id || !isAlive(held) || held.data.$type !== entry.data.$type) continue;
    const theirs = await core.view(other, held);
    for (let k = 0; k < def.unique.length; k++) {
      const key = def.unique[k];
      if (mine[k] === null || mine[k] !== core.catalog.uniqueKey(theirs, key)) continue;
      const pair = `${other}\0${key.join(',')}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      found.push({ fields: [...key], other });
    }
  }
  return found;
};

/**
 * Several writes as one, inside the queue: `fn(tx)` runs over a core whose
 * `current` sees the writes made before it and whose `commit` makes an op
 * without appending it — the hooks, the validator and the unique keys run
 * as each op is made. When `fn` returns, the ops are signed, appended as
 * one group, landed as one batch (one chain block, each touched record's
 * file written once) and announced in order, the `message` on every op. A
 * throw from `fn`, or a refusal of any op, leaves nothing appended. Resolves
 * to `{ result, done }`: what `fn` returned and the landing (null when no op
 * was made).
 */
// An op made inside a transaction is a `syncom.commit` span of its own —
// the op built, applied, validated — and a commit metric; the append and
// the landing are the transaction's.
const tracedPrepare = async (core, type, id, payload, options) => {
  const { otel } = core;
  if (!otel.enabled) return prepare(core, type, id, payload, options);
  const started = now();
  try {
    const attributes = { 'syncom.op.type': type, 'syncom.record.id': id };
    const made = await traced(
      otel,
      'syncom.commit',
      attributes,
      () => prepare(core, type, id, payload, options),
      ({ op }) => ({
        'syncom.result': commitResult(op),
        'syncom.scope': op && op !== MISMATCH ? (op.scope ?? GLOBAL_SCOPE) : undefined,
      }),
    );
    otel.recordCommit(type, commitResult(made.op), now() - started);
    return made;
  } catch (error) {
    otel.recordCommit(type, 'error', now() - started);
    throw error;
  }
};

const transact = async (core, fn, { actor, source = null, message } = {}) => {
  const msg = messageArg(message);
  const prepared = [];
  const touched = new Map();
  const reserved = new Map();
  const tx = {
    ...core,
    current: (id) => (touched.has(id) ? touched.get(id) : core.current(id)),
    // A stream's seq counts the ops made here and not yet appended.
    seqOf: (key) => Math.max(core.seqOf(key), reserved.get(key) ?? 0),
    run: (task) => task(),
    conflicts: (id, entry) => conflictsIn(core, touched, id, entry),
  };
  const commitIn = async (type, id, payload, options = {}) => {
    if (!isRecordId(id)) throw invalidId(id);
    if (options.encrypted === true || (await tx.current(id))?.encrypted === true) {
      throw new SyncomError('ENCRYPTED', `Record ${id} is encrypted: an encrypted write stays outside a transaction`);
    }
    const given = { ...options, source, message: msg };
    if (given.actor === undefined) given.actor = actor;
    const made = await tracedPrepare(tx, type, id, payload, given);
    const { op } = made;
    if (op === null || op === undefined || op === MISMATCH) return op;
    prepared.push(made);
    touched.set(id, made.entry);
    reserved.set(opKey(op), op.seq);
    return op;
  };
  tx.commit = commitIn;
  tx.commitNow = async (type, id, payload, options) => outcome(await commitIn(type, id, payload, options));
  // A plugin method that transacts (`applyDelta`), called inside a
  // transaction, runs within it: one append, the outer's actor, source and
  // message. (The storage's `transact` would queue a second turn — behind
  // the one this transaction holds.)
  tx.transact = async (inner) => ({ result: await inner(tx), done: null, ops: 0 });
  const result = await fn(tx);
  if (prepared.length === 0) return { result, done: null, ops: 0 };
  const count = prepared.length;
  // Signed once every op is final: on the thread pool when there are
  // several, or writes queued behind; alone and unhurried, here.
  const signing = core.sign !== null && (count > 1 || core.pipelined()) ? [] : null;
  const ops = [];
  for (let i = 0; i < count; i++) {
    ops.push(prepared[i].op);
    if (signing !== null) signing.push(core.sign(ops[i], true));
  }
  let ready = null;
  if (signing !== null) ready = Promise.all(signing);
  else if (core.sign !== null) await core.sign(ops[0], false);
  const ticket = core.log.append(ops, ready === null ? undefined : { ready });
  const positions = [];
  for (let i = 0; i < count; i++) {
    positions.push(ticket.entries[i].seq);
    core.inflight(ops[i].id, prepared[i].entry, positions[i]);
  }
  const done = core.landing(async () => {
    await ticket;
    const from = positions[0];
    const to = positions[positions.length - 1];
    if (core.defer > 0) {
      for (let i = 0; i < prepared.length; i++) await core.deferred(ops[i].id, prepared[i].entry, positions[i]);
    } else if (await core.land(touched, from, to)) {
      // One append: the positions run from `from` to `to` without a gap.
      core.log.applied(from, to);
    }
    for (let i = 0; i < prepared.length; i++) core.settled(ops[i].id, positions[i]);
    core.flush();
    const changes = [];
    for (let i = 0; i < prepared.length; i++) {
      const { op, entry, delta, ctx, before, previous } = prepared[i];
      const committed = { seq: positions[i], before, previous, txn: positions[0] };
      await announce(core, op, entry, delta, ctx, source, null, committed, prepared[i].changes);
      tagged(op, prepared[i].changes, changes);
    }
    transacted(core, { local: true, via: null, source, message: msg ?? null, ops, changes });
  });
  return { result, done, ops: prepared.length };
};

// The span starts when the write RUNS, not when it was queued: waiting on
// the mutation queue is the caller's contention, not the write's cost. It
// covers the queue's part — the op built, applied, validated, appended;
// the duration recorded covers the landing too, up to the `change`
// listeners, because that is what the caller awaits. (A bootstrap's merges
// are counted, never spanned.)
const tracedCommit = async (core, type, id, payload, options) => {
  const { otel } = core;
  const started = now();
  let out;
  try {
    const task = () => commitLocal(core, type, id, payload, options);
    const attributes = { 'syncom.op.type': type, 'syncom.record.id': id };
    out = await traced(otel, 'syncom.commit', attributes, task, ({ op }) => ({
      'syncom.result': commitResult(op),
      'syncom.scope': op ? (op.scope ?? GLOBAL_SCOPE) : undefined,
    }));
  } catch (error) {
    otel.recordCommit(type, 'error', now() - started);
    throw error;
  }
  const result = commitResult(out.op);
  if (out.done === null) {
    otel.recordCommit(type, result, now() - started);
    return out;
  }
  const done = out.done.then(
    () => otel.recordCommit(type, result, now() - started),
    (error) => {
      otel.recordCommit(type, 'error', now() - started);
      throw error;
    },
  );
  return outcome(out.op, done);
};

/**
 * One local write, run inside the mutation queue: `{ op, done }` — the op
 * (null, undefined or MISMATCH when nothing was appended) and the landing
 * to await for it to be durable, written and announced (null when there
 * is none).
 */
const commit = (core, type, id, payload, options = {}) => {
  if (!core.otel.enabled) return commitLocal(core, type, id, payload, options);
  return tracedCommit(core, type, id, payload, options);
};

module.exports = { commit, transact, rehearse, MISMATCH };
