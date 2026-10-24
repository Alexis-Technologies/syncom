'use strict';

// The one local write path: `storage[COMMIT]` lands here, inside the
// mutation queue. The op is built, applied, validated, logged (a durable
// seq), persisted, then announced — in that order, for every kind of local
// write (`write`, `set`, `inc`, `add`, `remove`, `delete`, `purge`; a
// bootstrap's merges go through src/bootstrap.js). `core` is what Storage lends its write paths:
// the log, the clock, the chain, the entries, the hook runner and the
// lensed readers — see Storage#open.

const { encrypt, calculateHash } = require('./crypto.js');
const { applyOp, isAlive, latestClock, observedTags, kindOf, kindsOf, seqIndexOf } = require('./ops.js');
const S = require('./sequence.js');
const T = require('./tree.js');
const { between } = require('./order.js');
const { opKey } = require('./vector.js');
const { notify } = require('./hooks.js');
const { ValidationError, project, unproject, foldSet } = require('./schema.js');
const { traced, now } = require('./telemetry.js');
const { GLOBAL_SCOPE } = require('./scope.js');
const { isPlainObject, asJson, VALIDATED } = require('./shape.js');
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

// The field-kind rule, refused with a hint at the right call.
const HINTS = {
  register: 'a register; use update()',
  counter: 'a counter; use inc()',
  set: 'a set; use add() or remove()',
  list: 'a list; use splice(), push(), setAt() or move()',
  text: 'a text; use splice(), push(), updateText() or mark()',
  tree: 'a tree; use treeMove() or treeRemove()',
  bound: 'past a bound: pending work, a run or the field as a whole (see Costs and limits)',
};
// `malformed` is a payload the engine does not admit after the arguments
// were checked — a bug in the caller or here, never a peer's doing on this
// path — so it is a TypeError, not a coded failure.
const refuse = (id, rejected) => {
  if (rejected.length === 0) return;
  const [{ field, reason, detail, count, max }] = rejected;
  if (reason === 'malformed') {
    throw new TypeError(`Field ${field} of record ${id}: the engine does not admit this payload`);
  }
  const fields = { field, kind: reason };
  if (detail !== undefined) Object.assign(fields, { detail, count, max });
  throw new SyncomError('FIELD_KIND', `Field ${field} of record ${id} is ${HINTS[reason]}`, fields);
};

// A swap's expectation, checked inside the queue against the record as it
// reads: a live one, or an encrypted one's data.
const expectation = async (core, id, current, expect) => {
  let seen = null;
  if (current?.encrypted) seen = current.data;
  else if (current && isAlive(current)) seen = await core.view(id, current);
  if (!seen) throw new SyncomError('NOT_FOUND', `Record ${id} not found`);
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
  const record = await encrypt(data, core.keys.publicKey);
  const blockHash = core.chain ? await core.chain.addBlock({ id, hash: await calculateHash(record) }) : null;
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
  return data;
};

// The op's stream: its scope, and the next seq there (seqs run per stream,
// see vector.js opKey).
const assignScope = (core, op, data) => {
  const scope = core.scopeOf(op.id, data);
  if (scope === GLOBAL_SCOPE) delete op.scope;
  else op.scope = scope;
  op.seq = core.log.seqOf(opKey(op)) + 1;
};

// A splice names an index and a count; what travels is the anchor of the
// new run (or the run of this origin to extend) and the ranges to cut, read
// here, inside the queue — read outside it, a concurrent apply would shift
// the indices. The content names the kind — a string for a text, an array
// for a list — and a call that only cuts takes the field's.
const resolveSplice = (core, id, payload, current) => {
  const { key, index, count, content } = payload;
  const meta = current?.meta;
  const held = meta && Object.hasOwn(meta.seqs ?? {}, key) ? meta.seqs[key] : undefined;
  const marker = content ?? (held?.k === 'l' ? [] : '');
  const idx = held === undefined ? null : seqIndexOf(current, key);
  const length = idx === null ? 0 : idx.length;
  const at = index === null ? length : index;
  if (at > length || at + count > length) {
    const span = count > 0 ? `${at}..${at + count}` : String(at);
    const message = `Index ${span} is out of range for field ${key} of record ${id} (length ${length})`;
    throw new SyncomError('OUT_OF_RANGE', message, { id, field: key, index: at, count, length });
  }
  const value = { content: marker };
  if (count > 0) value.cut = S.rangesOf(idx, at, count);
  if (marker.length > 0) Object.assign(value, idx === null ? { at: S.HEAD } : S.placeInsert(idx, at, core.nodeId));
  return value;
};

// A list's element, by its index: the name it keeps across moves. A field
// with no block has no elements (OUT_OF_RANGE); another kind under the field
// was refused before this is read (`kindClash`).
const elementAt = (core, id, key, index, current) => {
  const meta = current?.meta;
  const held = meta && Object.hasOwn(meta.seqs ?? {}, key) ? meta.seqs[key] : undefined;
  const idx = held === undefined ? null : seqIndexOf(current, key);
  const length = idx === null ? 0 : idx.length;
  if (index >= length) {
    const message = `Index ${index} is out of range for field ${key} of record ${id} (length ${length})`;
    throw new SyncomError('OUT_OF_RANGE', message, { id, field: key, index, count: 0, length });
  }
  return { idx, elem: S.elemAt(idx, index) };
};

const resolveAssign = (core, id, payload, current) => {
  const { key, index, value } = payload;
  return { elem: elementAt(core, id, key, index, current).elem, value };
};

// A move names two indices; what travels is the element, the slot it showed
// at and the anchor of its new position (`to` counts once it is out).
const resolveMove = (core, id, payload, current) => {
  const { key, index: from, to } = payload;
  const { idx, elem } = elementAt(core, id, key, from, current);
  if (to >= idx.length) {
    const message = `Index ${to} is out of range for field ${key} of record ${id} (length ${idx.length})`;
    throw new SyncomError('OUT_OF_RANGE', message, { id, field: key, index: to, count: 0, length: idx.length });
  }
  const place = S.placeInsert(idx, to < from ? to : to + 1, core.nodeId);
  const at = place.at ?? `>${S.elemKey(place.run, place.from - 1)}`;
  return { elem, cut: S.slotAt(idx, from), at, value: S.valueAt(idx, from) };
};

// A mark names a visible range and an expand rule; what travels is the pair
// of anchors — an element and a side — the rule picks (src/sequence.js
// markAnchors), or the id of the mark to switch off.
const resolveMark = (core, id, payload, current) => {
  const { key, off } = payload;
  if (off !== undefined) return { off };
  const { start, end, name, value, expand, many } = payload;
  const meta = current?.meta;
  const held = meta && Object.hasOwn(meta.seqs ?? {}, key) ? meta.seqs[key] : undefined;
  const idx = held === undefined ? null : seqIndexOf(current, key);
  const length = idx === null ? 0 : idx.length;
  if (start > end || end > length) {
    const message = `Range ${start}..${end} is out of range for field ${key} of record ${id} (length ${length})`;
    throw new SyncomError('OUT_OF_RANGE', message, { id, field: key, index: start, count: end - start, length });
  }
  const [from, to] = idx === null ? [S.HEAD, S.END] : S.markAnchors(idx, start, end, expand);
  const out = { start: from, end: to, key: name, value };
  if (many) out.many = true;
  return out;
};

// A tree move names a parent and a sibling to land after or before; what
// travels is the place among the siblings as a fractional index
// (src/order.js) between its neighbours — decided inside the queue, against
// the tree as it is, folded once. A parent in the node's own subtree is
// CYCLE, a sibling not under the parent NOT_FOUND; a move to where the node
// already is makes no op (null). A move that would reach below the level a
// tree reads (T.MAX_DEPTH), or a place with no room left between its
// neighbours (an index past T.MAX_FI), is OUT_OF_RANGE. Siblings that share
// an index order by stamp, and a node put after one of them lands after all
// of them. Another kind under the field is left to applyOp to refuse.
const resolveTree = (core, id, payload, current) => {
  const { key, node, parent, after, before } = payload;
  const meta = current?.meta;
  const held = meta && Object.hasOwn(meta.trees ?? {}, key) ? meta.trees[key] : undefined;
  const tree = held ?? T.createTree();
  const folded = T.childrenOf(tree);
  if (parent !== null && parent !== T.TRASH && T.subtree(tree, node, folded).has(parent)) {
    const where = parent === node ? 'itself' : `${parent}, a node under it`;
    const message = `Node ${node} of field ${key} of record ${id} cannot go under ${where}`;
    throw new SyncomError('CYCLE', message, { id, field: key, node, parent });
  }
  const all = T.siblings(tree, parent, folded);
  const was = all.findIndex((s) => s.id === node);
  const sibs = was < 0 ? all : all.filter((s) => s.id !== node);
  let at = sibs.length;
  const next = after ?? before;
  if (next !== undefined) {
    const i = sibs.findIndex((s) => s.id === next);
    if (i < 0) {
      const message = `Node ${next} is not under ${parent ?? 'the root'} of field ${key} of record ${id}`;
      throw new SyncomError('NOT_FOUND', message, { id, field: key, node: next });
    }
    at = after !== undefined ? i + 1 : i;
  }
  if (was >= 0 && (at === was || parent === T.TRASH)) return null;
  if (parent !== T.TRASH) {
    const depth = (parent === null ? 0 : T.depthOf(folded, parent)) + T.heightOf(folded, node);
    if (depth > T.MAX_DEPTH) {
      const message = `Node ${node} of field ${key} of record ${id} would reach level ${depth}; a tree reads ${T.MAX_DEPTH}`;
      throw new SyncomError('OUT_OF_RANGE', message, { id, field: key, node, depth, max: T.MAX_DEPTH });
    }
  }
  const lower = at > 0 ? sibs[at - 1].fi : null;
  let upper = at < sibs.length ? sibs[at].fi : null;
  if (lower !== null && upper !== null && upper <= lower) {
    upper = null;
    for (let i = at + 1; i < sibs.length; i++) {
      if (sibs[i].fi > lower) {
        upper = sibs[i].fi;
        break;
      }
    }
  }
  const fi = between(lower, upper);
  if (fi.length > T.MAX_FI) {
    const message = `No room left between the neighbours of node ${node} in field ${key} of record ${id}; move a sibling away or reset the field`;
    throw new SyncomError('OUT_OF_RANGE', message, {
      id,
      field: key,
      node,
      reason: 'fi',
      length: fi.length,
      max: T.MAX_FI,
    });
  }
  return { node, parent, fi };
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
  splice: ['list', 'text'],
  assign: ['list'],
  move: ['list'],
  mark: ['text'],
  tree: ['tree'],
};
const kindClash = (type, payload, current) => {
  const takes = TAKES[type];
  if (takes === undefined || !current || current.encrypted) return [];
  const fields = type === 'write' || type === 'set' ? Object.keys(payload.data ?? {}) : [payload.key];
  const rejected = [];
  for (const field of fields) {
    const kind = kindOf(current, field);
    if (kind !== undefined && !takes.includes(kind)) rejected.push({ field, reason: kind });
  }
  return rejected;
};

const prepareOp = (core, type, id, payload, current, who, from) => {
  refuse(id, kindClash(type, payload, current));
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
  // A remove names the tags this node observed, read here, inside the
  // queue — read outside it, a concurrent apply could add between the two —
  // or exactly the tags a patch names (an undo revokes its own add alone).
  if (type === 'remove') {
    op.value = payload.removals ?? observedTags(current?.meta ?? null, payload.key, payload.value);
    // `own`: this node's adds alone — an undo revokes what this node added
    // and leaves what a peer added meanwhile.
    if (payload.own === true) op.value = ownTags(op.value, core.nodeId);
  }
  if (type === 'splice') op.value = resolveSplice(core, id, payload, current);
  if (type === 'assign') op.value = resolveAssign(core, id, payload, current);
  if (type === 'move') op.value = resolveMove(core, id, payload, current);
  if (type === 'mark') op.value = resolveMark(core, id, payload, current);
  if (type === 'tree') op.value = resolveTree(core, id, payload, current);
  return op;
};

// A unique key another record holds: refused here, where one writer can be
// told. Two concurrent writers on two nodes cannot be — see the `conflict`
// event on the apply path.
const assertUnique = async (core, id, entry) => {
  const conflicts = await core.conflicts(id, entry);
  if (conflicts.length === 0) return;
  const issues = conflicts.map(({ fields, other }) => ({
    path: fields,
    message: `is not unique (held by ${other})`,
    code: 'unique',
    conflict: other,
  }));
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
  let { entry, changed, delta, rejected } = applyOp(current, op, core.limits);
  refuse(id, rejected);
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
      ({ entry, changed, delta, rejected } = applyOp(current, op, core.limits));
      refuse(id, rejected);
      if (!changed) return null;
    }
  }
  if (VALIDATED.has(type)) await assertUnique(core, id, entry);
  return { entry, delta };
};

// Signed, then logged (the seq is durable from here), then the chain block,
// then the record file; the log is told the batch landed. The signature is
// made here and nowhere earlier: validateLocal rewrote `op.data`, and what
// the peers receive is what must verify.
const persistLocal = async (core, op, entry) => {
  const { id } = op;
  if (core.sign !== null) await core.sign(op);
  const [{ seq: position }] = await core.log.append([op]);
  // Logged: the write is durable from here and replicates from the log. A
  // block or a file that fails now holds the entry in memory, leaves the
  // batch unapplied (the next open replays it) and is reported — the write
  // itself stands.
  try {
    let blockHash = null;
    if (core.chain) {
      const hash = await calculateHash(entry.data);
      blockHash = await core.chain.addBlock({ id, hash, from: core.log.formatId(position) });
    }
    await core.entries.write(id, entry, blockHash);
  } catch (error) {
    await core.unpersisted(new Map([[id, entry]]), error);
    core.flush();
    return position;
  }
  core.log.applied(position);
  core.flush();
  return position;
};

// afterWrite sees a durable op; whatever it does, the record views and the
// `change` listeners (the relay among them) hear about the op. `via` is null
// for a local write; a merge made from a peer's snapshot names that peer, so
// the relay does not hand its own state straight back to it.
const announce = async (core, op, entry, delta, ctx, source, via, committed = null) => {
  const alive = isAlive(entry);
  try {
    await core.hook('afterWrite', ctx, op);
  } finally {
    core.refresh(op.id, alive ? entry.data : null, delta, source);
    // What an undo manager keeps of a local commit: the record before and
    // after, as copies, and every field's kind — built only for a listener.
    if (committed !== null && core.storage.listenerCount('commit') > 0) {
      const { seq, before, previous } = committed;
      const kinds = { ...kindsOf(previous), ...kindsOf(entry) };
      const after = alive ? asJson(entry.data) : null;
      notify(core.storage, core.logger, 'commit', { op, seq, source, before: asJson(before), after, kinds });
    }
    notify(core.storage, core.logger, 'change', op, via);
  }
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
  return payload;
};

// Every op of a batch resolved and applied over a scratch record, in order,
// each against the result of the one before — what applyPatches() does
// before it appends anything, so an index out of range, a kind clash, a
// cycle or a type change refuses the batch whole. Hooks and validators are
// not run here; they run on the real commits, which may still refuse.
const rehearse = async (core, id, ops) => {
  let current = await core.entries.load(id);
  if (current?.encrypted) return;
  for (const [type, given] of ops) {
    const payload = copyPayload(given);
    const visible = current && isAlive(current) ? current.data : null;
    if (type === 'write' || type === 'set') payload.data = sameType(type, id, payload.data, visible);
    const op = prepareOp(core, type, id, payload, current, null, null);
    if (type === 'tree' && op.value === null) continue;
    const { entry, changed, rejected } = applyOp(current, op, core.limits);
    refuse(id, rejected);
    if (changed) current = entry;
  }
};

const commitLocal = async (core, type, id, payload, options) => {
  const { source = null, via = null, from = null, encrypted = false, actor, expect = null } = options;
  const current = await core.entries.load(id);
  if (encrypted && current && !current.encrypted) {
    throw new SyncomError('ENCRYPTED', `Record ${id} is replicated and cannot become encrypted`);
  }
  if (expect !== null && !(await expectation(core, id, current, expect))) return MISMATCH;
  payload = copyPayload(payload);
  // Sealed: this write is encrypted, or the record already is. An
  // encrypted record has no op log — writes to it stay local.
  const sealed = encrypted || current?.encrypted === true;
  const visible = current && (current.encrypted || isAlive(current)) ? current.data : null;
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
  if (sealed) return commitSealed(core, type, id, payload, current, ctx, source);
  if (type === 'write' || type === 'set') {
    ctx.data = sameType(type, id, payload.data, visible);
    payload = { ...payload, data: ctx.data };
  }
  const op = prepareOp(core, type, id, payload, current, who, from);
  // A tree move to where the node already is: nothing to write (resolveTree
  // hands back null instead of a place).
  if (type === 'tree' && op.value === null) return null;
  const applied = await validateLocal(core, op, current, visible, ctx);
  if (applied === null) return null;
  // The validator may have filled the field the scope reads (a default):
  // the stream is the one of the record as it is written.
  if (type === 'write' || type === 'set') assignScope(core, op, applied.entry.data);
  const seq = await persistLocal(core, op, applied.entry);
  const committed = { seq, before: visible, previous: current && !current.encrypted ? current : null };
  await announce(core, op, applied.entry, applied.delta, ctx, source, via, committed);
  return op;
};

// The span starts when the write RUNS, not when it was queued: waiting on
// the mutation queue is the caller's contention, not the write's cost. It
// ends after the `change` listeners, because that is what the caller awaits.
// (A bootstrap's merges are counted, never spanned.)
const tracedCommit = async (core, type, id, payload, options) => {
  const { otel } = core;
  const started = now();
  let result = 'error';
  try {
    const task = () => commitLocal(core, type, id, payload, options);
    const attributes = { 'syncom.op.type': type, 'syncom.record.id': id };
    const op = await traced(otel, 'syncom.commit', attributes, task, (op) => ({
      'syncom.result': commitResult(op),
      'syncom.scope': op ? (op.scope ?? GLOBAL_SCOPE) : undefined,
    }));
    result = commitResult(op);
    return op;
  } finally {
    otel.recordCommit(type, result, now() - started);
  }
};

/** One local write, run inside the mutation queue. Returns the op, null, undefined or MISMATCH. */
const commit = (core, type, id, payload, options = {}) => {
  if (!core.otel.enabled) return commitLocal(core, type, id, payload, options);
  return tracedCommit(core, type, id, payload, options);
};

module.exports = { commit, rehearse, MISMATCH };
