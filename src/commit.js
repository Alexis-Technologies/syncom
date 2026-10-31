'use strict';

// The one local write path: `storage[COMMIT]` lands here, inside the
// mutation queue. The op is built, applied, validated, logged (a durable
// seq), persisted, then announced — in that order, for every kind of local
// write (`write`, `set`, `inc`, `add`, `remove`, `splice`, `assign`, `move`,
// `mark`, `tree`, `delete`, `purge`; a bootstrap's merges go through
// src/bootstrap.js). `core` is what Storage lends its write paths:
// the log, the clock, the chain, the entries, the hook runner and the
// lensed readers — see Storage#open.

const { assignData } = require('./lazy.js');
const { applyOp, isAlive, latestHeld, observedTags, kindOf, kindsOf } = require('./ops.js');
const { missing } = require('./plugin.js');
const { opKey } = require('./vector.js');
const { digest, headerText } = require('./header.js');
const { hashText } = require('./crypto/digest.js');
const { ValidationError } = require('./errors.js');
const { project, unproject, foldSet } = require('./schema/entity.js');
const { fieldName } = require('./args.js');
const { traced, now } = require('./telemetry/writer.js');
const { GLOBAL_SCOPE } = require('./scope.js');
const { isPlainObject, asJson, VALIDATED, MAX_MESSAGE, isRecordId, invalidId } = require('./shape.js');
const { nestsWithin, MAX_JSON_DEPTH, MAX_WIRE_DEPTH } = require('./shape.js');
const { ancestorsOf } = require('./paths.js');
const { compose } = require('./compose.js');
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
  bound:
    "past a bound: pending work, a run, the field as a whole, a tree's moves or a counter's range (see Costs and limits)",
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
  core.saveCatalog();
};

const unseal = async (core, id) => {
  await core.entries.remove(id);
  core.saveCatalog();
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
    if (core.hooks.afterWrite !== null) await core.hook('afterWrite', ctx, null);
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
// see vector.js opKey). The record (`dataOf()`) is read for it only where a
// scope function was given (`core.scoped`); `scopeOf` composes it.
const assignScope = (core, op, dataOf) => {
  const scope = core.scoped ? core.scopeOf(op.id, dataOf()) : GLOBAL_SCOPE;
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
// Nothing refused — shared, never pushed to: the common answer allocates nothing.
const NONE = Object.freeze([]);
// One field's refusals pushed onto `rejected` (made when the first one is): a
// prefix a counter, a set or a text holds refuses every op under it; under a
// list or a tree the next segment must name a member that is there
// (NOT_FOUND otherwise, raised by the caller from `member`). A field with no
// `/` has no prefix to read.
const fieldClash = (field, takes, current, plugins, rejected) => {
  if (typeof field !== 'string') return rejected;
  if (field.includes('/')) {
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
        if (!mod.holds(current, prefix, member)) (rejected ??= []).push({ field, reason: 'member', prefix, member });
        continue;
      }
      (rejected ??= []).push({ field, reason: above, prefix });
      break;
    }
  }
  if (takes === undefined) return rejected;
  const kind = kindOf(current, field, plugins);
  if (kind !== undefined && !takes.includes(kind)) (rejected ??= []).push({ field, reason: kind });
  return rejected;
};
const kindClash = (type, payload, current, plugins) => {
  const takes = takesOf(type, payload, plugins);
  if (!current || current.encrypted) return NONE;
  if (type !== 'write' && type !== 'set') return fieldClash(payload.key, takes, current, plugins, null) ?? NONE;
  let rejected = null;
  for (const field of Object.keys(payload.data ?? {})) rejected = fieldClash(field, takes, current, plugins, rejected);
  return rejected ?? NONE;
};

const prepareOp = (core, type, id, payload, current, who, from) => {
  refuse(core, id, kindClash(type, payload, current, core.plugins));
  core.observe(latestHeld(current?.meta), id);
  const op = { origin: core.nodeId, seq: 0, ts: core.clock.now(), type, id };
  if (from) op.from = from;
  // The writer's schema version rides on the op: what a reader on another
  // version lenses the record through.
  if (core.version !== null) op.v = core.version;
  if (who !== null) op.actor = who;
  assignScope(core, op, () => scopeData(type, payload, current));
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
  const applied = applyLocal(core, op, current);
  if (applied === null) return null;
  let { entry, delta, changes } = applied;
  const def = core.definitionOf(entry.data);
  if (def?.validator && VALIDATED.has(type)) {
    // Through the lens: a record of an older version is validated as it
    // reads, and a set is folded against how it read before the write.
    const output = await def.validator(project(def, id, await core.view(id, entry)));
    if (type === 'write' || type === 'set') {
      const validated = unproject(def, output, entry.data.$type);
      if (type === 'write') op.data = validated;
      else op.data = foldSet(op.data, validated, visible ? project(def, id, await core.view(id, current)) : {});
      if (ctx !== null) ctx.data = op.data;
      const again = applyLocal(core, op, current);
      if (again === null) return null;
      ({ entry, delta, changes } = again);
    }
  }
  // Unique keys are the entity's: a record of none has none to check.
  if (VALIDATED.has(type) && def?.unique?.length > 0) await assertUnique(core, id, entry);
  return { entry, delta, changes };
};

// One reading of a record: the same object, or the same data and meta — the
// cache holds an entry's data and meta in an object of its own (EntryStore.hold).
const sameEntry = (a, b) =>
  a === b || (a !== null && b !== null && !a.encrypted && !b.encrypted && a.data === b.data && a.meta === b.meta);

// Whether a write of `type` to `entry` is checked beyond the op: a validator, unique keys.
const validates = (core, entry, type) => {
  if (!VALIDATED.has(type) || entry === null || entry.encrypted) return false;
  const def = core.definitionOf(entry.data);
  return Boolean(def?.validator) || def?.unique?.length > 0;
};

// The op applied to the record as it is: `{ entry, delta, changes }`, null
// for an op that changes nothing; a refusal throws.
const applyLocal = (core, op, current) => {
  const { entry, changed, delta, rejected, changes } = applyOp(current, op, core.limits);
  refuse(core, op.id, rejected);
  return changed ? { entry, delta, changes } : null;
};

/**
 * Ops of this node's own, final but for the chain, linked in order: each
 * names as `prev` the fingerprint of the op before it in its stream — one
 * before it in `ops`, else what `held(key, seq)` answers (the log's), nothing
 * when the stream starts there or this node does not hold that op — has its
 * payload digested when the node signs (`signs`: the digest is how the
 * header, and so the fingerprint, covers the payload — src/header.js), and
 * is fingerprinted. Before the op is signed and appended, at every place
 * that mints one: here, a transaction, a bootstrap's merges and advance
 * (src/bootstrap.js). Returns the fingerprints beside `ops`, what the log keeps.
 */
const link = async (ops, held, signs) => {
  const fps = [];
  const headers = [];
  // The newest op of each stream in `ops` so far: kept only for several.
  let last = null;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const key = opKey(op);
    const before = last === null ? undefined : last.get(key);
    const prev = before !== undefined && before[0] === op.seq - 1 ? before[1] : held(key, op.seq - 1);
    if (prev !== undefined) op.prev = prev;
    if (signs) await digest(op);
    // The header text once: what the fingerprint hashes and the log line holds.
    const header = headerText(op);
    const fp = hashText(header);
    fps.push(fp);
    headers.push(header);
    if (ops.length > 1) (last ??= new Map()).set(key, [op.seq, fp]);
  }
  return { fps, headers };
};

// Inside the queue: chained, signed, then appended — the seq reserved, the
// ticket the durability — and the entry made the record's in-flight state,
// what the next write of the record builds on. The digest, the link to the
// op before it in its stream (`prev`) and the signature are made here and
// nowhere earlier: validateLocal rewrote `op.data`, and what the peers
// receive is what must verify. The queue is free from here: the disk is
// waited for outside it.
const issue = async (core, op, entry) => {
  const { fps, headers } = await link([op], core.fingerprintOf, core.sign !== null);
  // Alone, the op is signed here; with writes queued behind it, on the
  // thread pool while the queue moves on — the group's file waits for it.
  let ready = null;
  if (core.sign !== null) {
    if (core.pipelined()) ready = core.sign(op, true);
    else await core.sign(op, false);
  }
  const ticket = core.log.enqueue([op], { ready, fps, headers });
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
  await ticket.done;
  // Logged: the write is durable from here and replicates from the log.
  // Under `open({ defer })` the file and the block wait for the flush
  // (Storage#deferWrite): held in memory, the batch unapplied until then.
  if (core.defer > 0) {
    await core.deferred(id, entry, position);
    core.settled(id, position);
    core.saveCatalog();
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
  core.saveCatalog();
  return position;
};

// afterWrite sees a durable op; whatever it does, the record views and the
// `change` listeners (the relay among them) hear about the op. `via` is null
// for a local write; a merge made from a peer's snapshot names that peer, so
// the relay does not hand its own state straight back to it.
// `refresh` false: a transaction's op that a later op of its record
// follows — the live Record is refreshed once, by the last (`transact`).
// `entry` null: an op that kept nothing of the record (no `commit` listener
// when it was made) — no commit event for it.
// Done at once without an afterWrite hook — a promise only with one.
const announce = (core, op, entry, delta, ctx, source, via, committed = null, changes = [], refresh = true) => {
  if (core.hooks.afterWrite === null) {
    announced(core, op, entry, delta, source, via, committed, changes, refresh);
    return undefined;
  }
  return afterWritten(core, op, entry, delta, ctx, source, via, committed, changes, refresh);
};

const afterWritten = async (core, op, entry, delta, ctx, source, via, committed, changes, refresh) => {
  try {
    await core.hook('afterWrite', ctx, op);
  } finally {
    announced(core, op, entry, delta, source, via, committed, changes, refresh);
  }
};

const announced = (core, op, entry, delta, source, via, committed, changes, refresh) => {
  if (refresh) core.refresh(op.id, isAlive(entry) ? entry.data : null, delta, source, entry);
  // What an undo manager keeps of a local commit: the record before and
  // after, as copies, and every field's kind — built only for a listener.
  if (committed !== null && entry !== null && core.listening('commit')) {
    const event = commitEvent(core, op, entry, isAlive(entry), committed, source, changes);
    core.emit('commit', event);
  }
  core.emit('change', op, via, { changes });
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
  if (ops.length === 0 || !core.listening('transaction')) return;
  const ts = ops[ops.length - 1].ts;
  core.emit('transaction', { local, via, source, message, ops, changes, ts });
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

// What a write takes nests at most MAX_JSON_DEPTH levels — the data, a
// value, a content, the markers, the tags a remove names, each as given —
// checked before the copy, which would recurse into it.
const PAYLOAD = ['data', 'value', 'content', 'vals', 'removals'];
const shallow = (payload) => {
  for (let i = 0; i < PAYLOAD.length; i++) {
    const name = PAYLOAD[i];
    if (nestsWithin(payload[name], MAX_JSON_DEPTH)) continue;
    throw new TypeError(`A write's ${name} nests deeper than ${MAX_JSON_DEPTH} levels`);
  }
};

// The payload taken as JSON — a copy, like the disk and the peers hold it —
// before anything keeps a reference to it: the data, a value, a content, the
// tags a remove names. A string is its own copy (a text's content, a
// primitive value): only an object is copied, into one new payload.
const isObject = (value) => value !== null && typeof value === 'object';
const copyPayload = (payload) => {
  shallow(payload);
  const { data, value, content, removals, vals } = payload;
  if (data === undefined && !isObject(value) && !isObject(content) && removals === undefined && vals === undefined) {
    return payload;
  }
  const copy = { ...payload };
  if (data !== undefined) copy.data = asJson(data);
  if (isObject(value)) copy.value = asJson(value);
  if (isObject(content)) copy.content = asJson(content);
  if (removals !== undefined) copy.removals = asJson(removals);
  if (vals !== undefined) copy.vals = asJson(vals);
  return copy;
};

// Every op of a batch resolved and applied over a scratch record, in order,
// each against the result of the one before — what applyPatches() does
// before it appends anything, so an index out of range, a kind clash, a
// cycle or a type change refuses the batch whole. Hooks and validators are
// not run here; they run on the real commits, which may still refuse.
const rehearse = async (core, id, ops) => {
  let current = await core.current(id);
  if (current?.encrypted) return;
  const scratch = { ...core, editing: null };
  for (const [type, given] of ops) {
    const payload = copyPayload(given);
    const visible = current && isAlive(current) ? compose(current, core.plugins) : null;
    if (type === 'write' || type === 'set') payload.data = sameType(type, id, payload.data, visible);
    // A rehearsal reserves nothing a writer would (`editing`: src/text/kind.js extendsRun).
    const op = prepareOp(scratch, type, id, payload, current, null, null);
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
  // The hook context — what beforeWrite and afterWrite are handed — is made
  // only where one of them is set; null otherwise.
  const { beforeWrite, afterWrite } = core.hooks;
  const hooked = beforeWrite !== null || afterWrite !== null;
  const whole = type === 'write' || type === 'set';
  // The record as the application reads it — its paths composed — for the
  // hooks, a write's `$type` and a set's validator; the op model keeps the
  // paths apart.
  const visible =
    (hooked || whole) && current && (current.encrypted || isAlive(current)) ? compose(current, core.plugins) : null;
  // An actor function is awaited; a given actor, or none, is read at once.
  let who = core.actorOf(actor);
  if (who !== null && typeof who === 'object') who = await who;
  const ctx = hooked
    ? { type, id, ...payload, current: visible, encrypted: sealed, source, via, from, v: core.version, actor: who }
    : null;
  if (beforeWrite !== null) payload = await replaced(core, type, payload, ctx);
  if (sealed) return { op: await commitSealed(core, type, id, payload, current, ctx, source), sealed: true };
  const op = opOf(core, type, id, payload, current, visible, who, from, msg, ctx);
  if (op === null) return { op: null };
  const applied = await validateLocal(core, op, current, visible, ctx);
  if (applied === null) return { op: null };
  return prepared(core, op, applied, current, ctx, source, via);
};

// The op a local write makes, before it is applied: a write's or a set's
// keys checked and its `$type` kept, the op stamped, scoped and resolved —
// null when it writes nothing.
const opOf = (core, type, id, payload, current, visible, who, from, msg, ctx) => {
  if (type === 'write' || type === 'set') {
    // Every key a field name or a path of them: a key that is neither would
    // be left out of the op without a word.
    for (const key of Object.keys(payload.data ?? {})) fieldName(type === 'write' ? 'set' : 'update', key);
    const data = sameType(type, id, payload.data, visible);
    if (ctx !== null) ctx.data = data;
    payload = { ...payload, data };
  }
  const op = prepareOp(core, type, id, payload, current, who, from);
  if (msg !== undefined) op.msg = msg;
  // A plugin's op that resolved to nothing — a tree move to where the node
  // already is — writes nothing.
  if (op.value === null && core.plugins.byType[type] !== undefined) return null;
  // An unset of nothing the record holds writes nothing.
  if (type === 'unset' && op.value.length === 0) return null;
  return op;
};

// What `prepare` hands on once the op is applied (and validated).
const prepared = (core, op, applied, current, ctx, source, via) => {
  // The data a beforeWrite hook or a validator handed back, as the op
  // carries it: never deeper than a peer takes.
  if (op.data !== undefined && !nestsWithin(op.data, MAX_WIRE_DEPTH)) {
    throw new TypeError(`Record ${op.id}: its data nests deeper than ${MAX_WIRE_DEPTH} levels`);
  }
  // The validator may have filled the field the scope reads (a default):
  // the stream is the one of the record as it is written.
  if (op.type === 'write' || op.type === 'set') assignScope(core, op, () => applied.entry.data);
  const previous = current && !current.encrypted ? current : null;
  // The commit event's `before` is the record in the op model's terms — the
  // paths apart, as the entry holds them — what an undo takes a step back by.
  const before = previous !== null && isAlive(previous) ? previous.data : null;
  const { entry, delta, changes } = applied;
  return { op, entry, delta, changes, ctx, source, via, before, previous };
};

const NOOP = () => {};

/**
 * A local write made at once, outside the mutation queue — what the storage
 * runs on an idle queue for a live record it holds, with nothing
 * asynchronous configured: no hook, no signature, no validator or unique
 * key, no telemetry, no lens, the record files deferred (Storage#fastCommit
 * decides). The op is made and applied over `current`, chained, appended and
 * made the record's in-flight state before this returns; it lands and is
 * announced as its group is written (the log's `onDurable`), and the
 * landings behind it wait for that (`core.landed`). Resolves once announced
 * — to the op with `answer`, else to nothing; a throw is a rejection with
 * nothing appended.
 */
const commitAtOnce = (core, type, id, payload, options, current, answer) => {
  const { source = null, via = null, from = null, actor, message } = options;
  const msg = messageArg(message);
  payload = copyPayload(payload);
  const visible = (type === 'write' || type === 'set') && isAlive(current) ? compose(current, core.plugins) : null;
  const op = opOf(core, type, id, payload, current, visible, core.actorOf(actor), from, msg, null);
  if (op === null) return Promise.resolve(answer ? null : undefined);
  const applied = applyLocal(core, op, current);
  if (applied === null) return Promise.resolve(answer ? null : undefined);
  const made = prepared(core, op, applied, current, null, source, via);
  // A keystroke that continues the one before it in the group still
  // gathering is that op, grown (the plugin's `coalesce`): no op of its own.
  const into = coalesced(core, op, made, current);
  if (into !== null) return answer ? into.done.then(() => into.op) : into.done;
  // The chain at once: `hashText` is at once on both platforms.
  const key = opKey(op);
  const prev = core.fingerprintOf(key, op.seq - 1);
  if (prev !== undefined) op.prev = prev;
  const header = headerText(op);
  let position = 0;
  const onDurable = () => landNow(core, made, position);
  const ticket = core.log.enqueue([op], { fps: [hashText(header)], headers: [header], onDurable });
  position = ticket.entries[0].seq;
  core.inflight(id, made.entry, position);
  core.landed(ticket.done);
  made.position = position;
  made.done = ticket.done;
  lastOf(core).made = made;
  // The group's promise settles once its writes have landed: what a write
  // that answers nothing resolves with.
  return answer ? ticket.done.then(() => op) : ticket.done;
};

// The write made at once last, per storage (by its log): what the next
// one may grow instead of making an op of its own.
const LAST = new WeakMap();
const lastOf = (core) => {
  let last = LAST.get(core.log);
  if (last === undefined) LAST.set(core.log, (last = { made: null }));
  return last;
};

// `op`, just made over `current`, folded into the write made at once before
// it — the last op of the group still gathering, the newest of its record and
// of its stream, unsigned, of the same field, actor, version and message —
// where the plugin's `coalesce` says the two are one: that op's value grows,
// its header (so its fingerprint and the next op's `prev`) stays, and its
// landing takes the newer entry, the deltas laid one over the other and the
// changes of both, in order. Answers the made write it grew, or null.
const coalesced = (core, op, made, current) => {
  const coalesce = core.plugins.byType[op.type]?.coalesce;
  if (coalesce === undefined) return null;
  const last = lastOf(core);
  const before = last.made;
  if (before === null || before.entry !== current) return null;
  const a = before.op;
  if (core.log.lastGathered() !== a || a.sig !== undefined || a.digest !== undefined) return null;
  if (!continues(a, op)) return null;
  const value = coalesce(a, op);
  if (value === null) return null;
  a.value = value;
  before.entry = made.entry;
  before.delta = assignData(before.delta ?? {}, made.delta);
  for (let i = 0; i < made.changes.length; i++) before.changes.push(made.changes[i]);
  core.inflight(op.id, made.entry, before.position);
  return before;
};

// `op` is the next op of `a`'s stream on `a`'s record and field, made by
// the same actor under the same version and message: what may be one op.
const continues = (a, op) =>
  a.id === op.id &&
  a.key === op.key &&
  a.seq === op.seq - 1 &&
  opKey(a) === opKey(op) &&
  a.actor === op.actor &&
  a.v === op.v &&
  a.msg === op.msg &&
  a.from === op.from;

// A write made at once, landed as its group is written: the deferred slot
// (at once — no lens), the entry no longer in flight, the catalog saved, the
// announce (no afterWrite hook) — what `land` and `announce` do, in order.
const landNow = (core, made, position) => {
  const { op, entry, delta, changes, source, via, before, previous } = made;
  core.deferred(op.id, entry, position);
  core.settled(op.id, position);
  core.saveCatalog();
  announce(core, op, entry, delta, null, source, via, { seq: position, before, previous, txn: position }, changes);
  if (core.listening('transaction')) {
    transacted(core, { local: true, via, source, message: op.msg ?? null, ops: [op], changes: tagged(op, changes) });
  }
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
    // Built only while something listens (`transacted` says nothing otherwise).
    if (core.listening('transaction')) {
      transacted(core, { local: true, via, source, message, ops: [op], changes: tagged(op, changes) });
    }
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
  const items = [];
  const touched = new Map();
  const reserved = new Map();
  // Per record: the index of its newest op here, and its ops' deltas laid
  // one over the other — what the live Record is refreshed by, once.
  const lastOf = new Map();
  const deltas = new Map();
  // An op a later op of its record follows keeps its op and its changes
  // until the landing; the record it left only for a `commit` listener, its
  // hook context only for an `afterWrite` hook. Kept whole, N ops of one
  // large record held N copies of it — 2 000 moves of a tree, 926 MB.
  const release = (made) => {
    made.delta = null;
    if (!core.hooks.afterWrite) made.ctx = null;
    if (!core.listening('commit')) {
      made.entry = null;
      made.before = null;
      made.previous = null;
    }
  };
  const tx = {
    ...core,
    current: (id) => (touched.has(id) ? touched.get(id) : core.current(id)),
    // A stream's seq counts the ops made here and not yet appended.
    seqOf: (key) => Math.max(core.seqOf(key), reserved.get(key) ?? 0),
    run: (task) => task(),
    conflicts: (id, entry) => conflictsIn(core, touched, id, entry),
  };
  // An op made here that continues the one made just before it — of its
  // record, the record's newest, its stream, field, actor and message — is
  // that op, grown where the plugin's `coalesce` says the two are one
  // (TXN-3): keystrokes typed through a transaction. The ops are signed
  // after `fn`, so a signing node folds them too; an `afterWrite` hook sees
  // every op as it was made, so with one none is folded. The stream's seq
  // stays the grown op's.
  const grows = (made) => {
    const i = items.length - 1;
    const { op } = made;
    const coalesce = core.plugins.byType[op.type]?.coalesce;
    if (i < 0 || coalesce === undefined || core.hooks.afterWrite !== null || lastOf.get(op.id) !== i) return null;
    const before = items[i];
    const a = before.op;
    if (!continues(a, op)) return null;
    const value = coalesce(a, op);
    if (value === null) return null;
    a.value = value;
    before.entry = made.entry;
    for (let k = 0; k < made.changes.length; k++) before.changes.push(made.changes[k]);
    deltas.set(op.id, assignData(deltas.get(op.id) ?? {}, made.delta));
    touched.set(op.id, made.entry);
    return a;
  };
  // An op made here joins the transaction: grown into the one before it, or an item of its own.
  const join = (made) => {
    const grown = grows(made);
    if (grown !== null) return grown;
    const { op } = made;
    const { id } = op;
    const was = lastOf.get(id);
    if (was !== undefined) release(items[was]);
    lastOf.set(id, items.length);
    deltas.set(id, assignData(deltas.get(id) ?? {}, made.delta));
    items.push(made);
    touched.set(id, made.entry);
    reserved.set(opKey(op), op.seq);
    return op;
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
    return join(made);
  };
  // An op made outside the queue, over another reading of its record — an
  // editor's handle's (src/text/handle.js), resolved and stamped as it was
  // typed: it takes its stream and seq here, is validated over the record as
  // the transaction has it, and goes with the rest. Null for one that
  // changes nothing (a keystroke a peer's reset made moot). `made` is what
  // the op made where it was typed — `{ from, entry, delta, changes }`: where
  // the transaction reads the record as that very `from` and nothing
  // validates the record, it is what applying the op again would make.
  tx.commitResolved = async (op, made) => {
    const { id, type } = op;
    const current = await tx.current(id);
    if (current?.encrypted === true) {
      throw new SyncomError('ENCRYPTED', `Record ${id} is encrypted: an encrypted write stays outside a transaction`);
    }
    if (msg !== undefined) op.msg = msg;
    assignScope(tx, op, () => scopeData(type, {}, current));
    const ctx =
      core.hooks.beforeWrite !== null || core.hooks.afterWrite !== null
        ? {
            type,
            id,
            key: op.key,
            value: op.value,
            current: null,
            encrypted: false,
            source,
            via: null,
            from: null,
            v: core.version,
            actor: op.actor ?? null,
          }
        : null;
    // beforeWrite may refuse a keystroke as it would a call; it replaces no data here.
    if (core.hooks.beforeWrite !== null) await core.hook('beforeWrite', ctx);
    const applied =
      made !== undefined && sameEntry(made.from, current) && !validates(core, made.entry, type)
        ? made
        : await validateLocal(tx, op, current, null, ctx);
    if (applied === null) return null;
    return join(prepared(tx, op, applied, current, ctx, source, null));
  };
  tx.commit = commitIn;
  tx.write = (type, id, payload, options) => commitIn(type, id, payload, options).then(NOOP);
  tx.commitNow = async (type, id, payload, options) => outcome(await commitIn(type, id, payload, options));
  // A plugin method that transacts (`applyDelta`), called inside a
  // transaction, runs within it: one append, the outer's actor, source and
  // message. (The storage's `transact` would queue a second turn — behind
  // the one this transaction holds.)
  tx.transact = async (inner) => ({ result: await inner(tx), done: null, ops: 0 });
  const result = await fn(tx);
  if (items.length === 0) return { result, done: null, ops: 0 };
  const count = items.length;
  const ops = [];
  for (let i = 0; i < count; i++) ops.push(items[i].op);
  // Chained in order once every op is final — an op names the one made
  // before it in its stream, here or in the log — then signed: on the thread
  // pool when there are several, or writes queued behind; alone and
  // unhurried, here.
  const { fps, headers } = await link(ops, core.fingerprintOf, core.sign !== null);
  const signing = core.sign !== null && (count > 1 || core.pipelined()) ? [] : null;
  if (signing !== null) for (let i = 0; i < count; i++) signing.push(core.sign(ops[i], true));
  let ready = null;
  if (signing !== null) ready = Promise.all(signing);
  else if (core.sign !== null) await core.sign(ops[0], false);
  const ticket = core.log.enqueue(ops, { ready, fps, headers });
  const positions = [];
  for (let i = 0; i < count; i++) positions.push(ticket.entries[i].seq);
  // A record in flight is its newest entry, at its newest position.
  for (const [id, last] of lastOf) core.inflight(id, touched.get(id), positions[last]);
  const done = core.landing(async () => {
    await ticket.done;
    const from = positions[0];
    const to = positions[positions.length - 1];
    if (core.defer > 0) {
      const held = new Map();
      for (let i = 0; i < count; i++) {
        const list = held.get(ops[i].id);
        if (list === undefined) held.set(ops[i].id, [positions[i]]);
        else list.push(positions[i]);
      }
      for (const [id, list] of held) await core.deferred(id, touched.get(id), list);
    } else if (await core.land(touched, from, to)) {
      // One append: the positions run from `from` to `to` without a gap.
      core.log.applied(from, to);
    }
    for (const [id, last] of lastOf) core.settled(id, positions[last]);
    core.saveCatalog();
    // The transaction event's changes, built only while something listens.
    const listening = core.listening('transaction');
    const changes = [];
    for (let i = 0; i < count; i++) {
      const { op, entry, ctx, before, previous } = items[i];
      const last = lastOf.get(op.id) === i;
      const committed = { seq: positions[i], before, previous, txn: positions[0] };
      const delta = last ? deltas.get(op.id) : null;
      await announce(core, op, entry, delta, ctx, source, null, committed, items[i].changes, last);
      if (listening) tagged(op, items[i].changes, changes);
    }
    transacted(core, { local: true, via: null, source, message: msg ?? null, ops, changes });
  });
  return { result, done, ops: items.length };
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

module.exports = { commit, commitAtOnce, transact, rehearse, link, prepareOp, applyLocal, MISMATCH };
