'use strict';

// The persisted operation log: every op this node applied — its own and the
// ones it accepted from peers — in the order they landed here. Two things read
// it: a subscriber resuming from an event id (`since`), and the node itself on
// reopen (the tail is replayed onto the records, which is what makes a crash
// between "logged" and "written to data/" recoverable).
//
// The medium is a store (`options.store`): the files engine's journals and
// segments under `<path>/log/` by default (src/files/journal.js — open files
// a group each or a journal a line per group, sealed segments, `corrupt/`,
// `index.json`), a native engine's rows otherwise. The log knows seqs, the
// vector, the streams and what is applied; every file name is the store's.
//
// Ids are `<epoch>.<seq>`. The epoch is minted once, when the log is created,
// so a subscriber holding an id from a previous incarnation (a wiped or
// restored data directory) is told to bootstrap instead of being fed a numeric
// coincidence. `floor` is the lowest seq still retained: below it, and for an
// unknown epoch, `since()` answers null — "I cannot resume you, take a
// snapshot" — never a silent gap.
//
// Every entry an append is handed a fingerprint for keeps it (`fp`, the
// SHA-256 of the op's header, src/header.js), and the log knows, by stream
// (`origin@scope`, vector.js opKey) and seq, the fingerprint of every op it
// retains — and of the newest op of every stream it ever held, its HEAD, kept
// in the index beside the vector, so a stream compacted away still has one.
// Both move with the vector, at the append, and go back with it when a group
// fails: what a writer chains its next op to (`prev`), and what a peer's op is
// held to (src/apply.js).

const defaultFsi = require('./fsi.js');
const { formatEventId, parseEventId, vectorAdvance, opKey } = require('./vector.js');
const { GLOBAL_SCOPE, inScope } = require('./scope.js');
const { writerOf, traced, now } = require('./telemetry/writer.js');
const { scrubOp } = require('./header.js');
const { createJournalStore, fileOf, readFile, segmentOf, readSegment } = require('./files/journal.js');

const DEFAULT_ROLL_AFTER = 64;
const DEFAULT_RETENTION_OPS = 10_000;

// SHA-256 as base64url (src/crypto/digest.js `hashOf`), as src/shape.js checks an op's `prev`.
const FINGERPRINT = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

const DONE = Promise.resolve();

class OpLog {
  // The medium: the files engine's journals and segments (src/files/journal.js),
  // or a native engine's log store — every file name is its, the log knows seqs.
  #store;
  #entries = [];
  #next = 1;
  #latestTs = 0;
  #floor = 1;
  #epoch = null;
  #vector = {};
  // Stream → seq → fingerprint, of every op retained (and every op reserved);
  // stream → [seq, fingerprint] of the newest op ever held, compacted or not.
  #prints = new Map();
  #heads = new Map();
  // Stream → its retained entries in log order (`entries`, the live ones
  // from `head`): what a push picks the ops a peer lacks from — a binary
  // search per stream for the seq it holds — without walking the log.
  // Compaction drops a stream's first entries; a failed group never got here.
  #streams = new Map();
  #rollAfter;
  #retention;
  #log;
  #rollFailures = 0;
  #otel;
  #droppedHeld = 0;
  // The newest stamp among the ops compaction dropped, or that this open
  // could not read: what a reader of the past checks before it trusts the
  // log to be whole from some point on (see `droppedTs`).
  #droppedTs = 0;
  // Whether the open lost entries it could not read (the store says), and
  // the groups whose write failed since this open: what `stats().log` says.
  #lost = false;
  #appendFailures = 0;
  // Entries compaction keeps whatever the retention says (see `retain`),
  // and whatever a reader pinned for the time being (see `pin`).
  #keep = null;
  #pins = new Set();
  #torn = new Set();
  #writes = Promise.resolve();
  // The group of appends being gathered (its entries, with their seqs
  // reserved, and the promise its callers await) and whether a group is on
  // its way to disk: appends that come while one is written join the next,
  // which goes as one file once the first is down — group commit.
  #group = null;
  #flushing = false;
  // Open files whose records may not be written yet: first seq → { first,
  // last, left } with `left` the seqs not yet marked applied — kept in
  // first-seq order, so the oldest is the first value. Only under
  // `sealApplied`; a roll stops short of the oldest.
  // The open groups not applied whole, in seq order: a sorted array read
  // from `#pendingHead` (the groups before it are applied and dropped
  // lazily), so `applied` finds its groups by binary search — a Map walked
  // from its oldest group made marking a flush O(positions × groups).
  #pending = [];
  #pendingHead = 0;
  #sealApplied;
  // Record id → the seqs of its entries: what a scrub rewrites, found
  // without a walk over everything retained.
  #byId = new Map();
  #onRoll = null;
  #onFail = null;

  constructor(basePath, options = {}) {
    this.#log = options.logger ?? null;
    // The medium handed in (a database's engine), else the files engine's
    // journal over the fsi given or the platform's, under `<basePath>/log`.
    this.#store =
      options.store ?? createJournalStore(options.fsi ?? defaultFsi, `${basePath}/log`, { logger: this.#log });
    this.#rollAfter = options.rollAfter ?? DEFAULT_ROLL_AFTER;
    // `'all'` keeps everything: the log of a node that must answer any version.
    const retention = options.retention === 'all' ? { ops: Infinity } : options.retention;
    this.#retention = { ops: DEFAULT_RETENTION_OPS, ...retention };
    this.#otel = writerOf(options.telemetry);
    // The storage asks for `sealApplied`: a roll then seals only the batches
    // it has marked applied (see `applied`), so an op whose record write
    // failed stays in the open files, replayed at every reopen until it
    // lands. A log on its own seals everything, as before.
    this.#sealApplied = options.sealApplied === true;
    // Told after every seal — what the storage turns into its `log` event.
    this.#onRoll = typeof options.onRoll === 'function' ? options.onRoll : null;
    // Told the moment a group fails, with the first seq taken back — before
    // any ticket rejects — so the owner drops what it built on those seqs.
    this.#onFail = typeof options.onFail === 'function' ? options.onFail : null;
    return this.#init();
  }

  async #init() {
    const loaded = await this.#store.load();
    const { index } = loaded;
    if (index) {
      this.#epoch = index.epoch;
      this.#floor = index.floor;
      this.#vector = index.vector;
      this.#takeHeads(index.heads);
      this.#droppedHeld = index.droppedHeld;
      // Seeded from the index; what the files hold only moves it up.
      this.#latestTs = index.latestTs;
      this.#droppedTs = index.droppedTs;
    } else {
      // No (readable) index: a new incarnation. Existing segments are still
      // picked up below, but their ids belong to an epoch nobody can resume.
      this.#epoch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      // Without an index everything the medium holds is retained from its first entry.
      this.#floor = loaded.floor;
    }
    this.#lost = loaded.lost;
    // The entries, sorted and unique (the store read them from segments and
    // open files alike): the vector, the clock, the index and the prints move
    // with each; the streams are made from the sorted entries, once.
    this.#take(loaded.entries);
    // An open group's seqs a segment does not hold yet wait for their records.
    if (this.#sealApplied) for (let i = 0; i < loaded.groups.length; i++) this.#hold(loaded.groups[i].unsealed);
    // A position handed out is never handed out again in its epoch: where the
    // newest file did not read, the counter the index kept is the floor of
    // the next — a peer that resumes from an id of this epoch gets no reused seq.
    if (index !== null && Number.isSafeInteger(index.next) && index.next > this.#next) this.#next = index.next;
    for (let i = 0; i < this.#entries.length; i++) this.#stream(this.#entries[i]);
    // Entries this open could not read, or an incarnation that starts above
    // seq 1 without an index to say what it dropped: as good as compacted,
    // up to the newest stamp known.
    if (this.#lost || (!index && this.#floor > 1)) this.#droppedTs = Math.max(this.#droppedTs, this.#latestTs);
    if (!index) {
      // Every subscriber of this node will be told to bootstrap: worth a
      // line when there was a log here, a whisper for a brand-new one.
      const level = this.#entries.length > 0 ? 'warn' : 'debug';
      const reason = loaded.hasIndex ? 'unreadable index' : 'no index';
      this.#log?.[level]?.({ event: 'log.epoch.new', epoch: this.#epoch, reason, entries: this.#entries.length });
      await this.#writeIndex();
    }
    return this;
  }

  // The newest seq a segment holds, or below the floor when none does: what
  // a reopen replays from.
  get #sealedTo() {
    return this.#store.sealedTo ?? this.#floor - 1;
  }

  // The entries the store loaded — sorted, unique — taken in: the counter,
  // the vector, the clock, the index by id and the fingerprints.
  #take(entries) {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      this.#entries.push(entry);
      if (entry.seq >= this.#next) this.#next = entry.seq + 1;
      if (entry.op) {
        vectorAdvance(this.#vector, entry.op);
        this.#observe(entry.op);
        this.#indexEntry(entry);
        if (typeof entry.fp === 'string') this.#print(entry);
      }
    }
  }

  // An open file's seqs, waiting for their records.
  #hold(seqs) {
    if (seqs.length === 0) return;
    let first = Infinity;
    let last = -Infinity;
    for (const seq of seqs) {
      if (seq < first) first = seq;
      if (seq > last) last = seq;
    }
    this.#pending.push({ first, last, left: new Set(seqs) });
  }

  // An entry's fingerprint, by its stream and seq; the stream's head moves
  // to it when it is the newest.
  #print(entry) {
    const { op, fp } = entry;
    const key = opKey(op);
    let seqs = this.#prints.get(key);
    if (seqs === undefined) this.#prints.set(key, (seqs = new Map()));
    seqs.set(op.seq, fp);
    // The head moves in place: a group keeps a copy of what it was (`append`).
    const head = this.#heads.get(key);
    if (head === undefined) this.#heads.set(key, [op.seq, fp]);
    else if (head[0] <= op.seq) {
      head[0] = op.seq;
      head[1] = fp;
    }
  }

  #unprint(entry) {
    if (entry.fp === undefined || !entry.op) return;
    const key = opKey(entry.op);
    const seqs = this.#prints.get(key);
    if (seqs === undefined) return;
    seqs.delete(entry.op.seq);
    if (seqs.size === 0) this.#prints.delete(key);
  }

  // Heads as the index or a REWOUND proof hands them — `{ key: [seq, fp] }`
  // — own keys, a positive safe seq, a fingerprint's shape; newer than what
  // is held.
  #takeHeads(heads) {
    if (heads === null || typeof heads !== 'object' || Array.isArray(heads)) return;
    const keys = Object.keys(heads);
    for (let i = 0; i < keys.length; i++) {
      const head = heads[keys[i]];
      if (!Array.isArray(head) || !Number.isSafeInteger(head[0]) || head[0] < 1) continue;
      if (typeof head[1] !== 'string' || !FINGERPRINT.test(head[1])) continue;
      const held = this.#heads.get(keys[i]);
      if (held === undefined || held[0] < head[0]) this.#heads.set(keys[i], [head[0], head[1]]);
    }
  }

  #indexEntry(entry) {
    const id = entry.op?.id;
    if (typeof id !== 'string') return;
    let seqs = this.#byId.get(id);
    if (!seqs) this.#byId.set(id, (seqs = new Set()));
    seqs.add(entry.seq);
  }

  #unindexEntry(entry) {
    const id = entry.op?.id;
    if (typeof id !== 'string') return;
    const seqs = this.#byId.get(id);
    if (!seqs) return;
    seqs.delete(entry.seq);
    if (seqs.size === 0) this.#byId.delete(id);
  }

  // An entry joins its stream: last, as seqs run up a stream in log order —
  // one that would not (a log fed by hand) goes where its seq sorts.
  #stream(entry) {
    const { op } = entry;
    if (!op) return;
    const key = opKey(op);
    let stream = this.#streams.get(key);
    if (stream === undefined) this.#streams.set(key, (stream = { entries: [], head: 0 }));
    const list = stream.entries;
    let at = list.length;
    while (at > stream.head && list[at - 1].op.seq > op.seq) at--;
    if (at === list.length) list.push(entry);
    else list.splice(at, 0, entry);
  }

  // An entry compaction dropped leaves its stream: its first, as a rule.
  #unstream(entry) {
    const { op } = entry;
    if (!op) return;
    const key = opKey(op);
    const stream = this.#streams.get(key);
    if (stream === undefined) return;
    if (stream.entries[stream.head] === entry) stream.head++;
    else {
      const at = stream.entries.indexOf(entry, stream.head);
      if (at !== -1) stream.entries.splice(at, 1);
    }
    if (stream.head === stream.entries.length) this.#streams.delete(key);
    else if (stream.head >= 64 && stream.head * 2 > stream.entries.length) {
      stream.entries = stream.entries.slice(stream.head);
      stream.head = 0;
    }
  }

  /**
   * Every stream the log retains an entry of, as `[key, entries, from]`:
   * its entries in log order from index `from` on — read, never changed.
   */
  *streams() {
    for (const [key, stream] of this.#streams) yield [key, stream.entries, stream.head];
  }

  /** The retained entry of stream `key` at seq `seq` (its op's), or undefined — a binary search. */
  entryOf(key, seq) {
    const stream = this.#streams.get(key);
    if (stream === undefined) return undefined;
    const list = stream.entries;
    let low = stream.head;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (list[mid].op.seq < seq) low = mid + 1;
      else high = mid;
    }
    return low < list.length && list[low].op.seq === seq ? list[low] : undefined;
  }

  // The entry with `seq`, or undefined.
  #entryAt(seq) {
    const entry = this.#entries[this.#lowerBound(seq)];
    return entry?.seq === seq ? entry : undefined;
  }

  get epoch() {
    return this.#epoch;
  }

  get floor() {
    return this.#floor;
  }

  /** How many ops the log keeps at least (`retention.ops`); Infinity when no count bounds it. */
  get retainedOps() {
    const { ops } = this.#retention;
    return typeof ops === 'number' && ops > 0 ? ops : Infinity;
  }

  /** Sealed segments on disk. */
  get segments() {
    return this.#store.segments.length;
  }

  get next() {
    return this.#next;
  }

  #observe(op) {
    if (typeof op.ts === 'number' && op.ts > this.#latestTs) this.#latestTs = op.ts;
  }

  /**
   * The newest `ts` this log has held since it was opened, over everything
   * still on disk at open time and everything appended since. A reopened
   * node seeds its clock from it, so its stamps never run backwards even
   * when the wall clock did — or when a peer's ran ahead.
   */
  get latestTs() {
    return this.#latestTs;
  }

  /** The highest per-origin seq this log has ever held — survives compaction. */
  get vector() {
    return { ...this.#vector };
  }

  /** One key of the vector, without copying it: what a local write mints its seq from. */
  seqOf(key) {
    return this.#vector[key] ?? 0;
  }

  /**
   * The fingerprint of the op at `seq` of the stream `key` (an `opKey`), as
   * this log holds it — retained, reserved, or the stream's head — or
   * undefined.
   */
  fingerprintOf(key, seq) {
    const fp = this.#prints.get(key)?.get(seq);
    if (fp !== undefined) return fp;
    const head = this.#heads.get(key);
    return head !== undefined && head[0] === seq ? head[1] : undefined;
  }

  /** `[seq, fingerprint]` of the newest op of the stream `key` this log held, or undefined. */
  headOf(key) {
    const head = this.#heads.get(key);
    return head === undefined ? undefined : [head[0], head[1]];
  }

  /**
   * Heads of streams whose ops this log does not hold — this node's own, taken
   * back from a host on its proof (REWOUND) — `{ key: [seq, fingerprint] }`;
   * persisted with the next index. A head older than the one held is left.
   */
  adoptHeads(heads) {
    this.#takeHeads(heads);
  }

  get length() {
    return this.#entries.length;
  }

  /**
   * The batches within `from..to` are reflected in the records. With
   * `sealApplied` a roll seals nothing from the oldest batch not yet applied
   * onwards, so the tail a reopen replays always holds every batch whose
   * records may not have been written: the one a crash interrupted (which
   * used to be sealed by the roll its own append triggered, before its
   * records existed) and one whose record write failed while later writes
   * went through.
   */
  applied(from, to = from) {
    if (!Number.isInteger(from) || !Number.isInteger(to)) return;
    const pending = this.#pending;
    // The first group that may hold `from`: its last seq at or past it.
    let low = this.#pendingHead;
    let high = pending.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (pending[mid].last < from) low = mid + 1;
      else high = mid;
    }
    for (let i = low; i < pending.length; i++) {
      const group = pending[i];
      if (group.first > to) break;
      if (group.left.size === 0) continue;
      const end = Math.min(to, group.last);
      for (let seq = Math.max(from, group.first); seq <= end; seq++) group.left.delete(seq);
    }
    // Applied whole at the front: dropped; the array compacted now and then.
    let head = this.#pendingHead;
    while (head < pending.length && pending[head].left.size === 0) head++;
    if (head === pending.length) {
      this.#pending = [];
      this.#pendingHead = 0;
    } else if (head > 1024 && head * 2 > pending.length) {
      this.#pending = pending.slice(head);
      this.#pendingHead = 0;
    } else this.#pendingHead = head;
  }

  // The first seq of the oldest open file not applied whole, or Infinity.
  get #unappliedFrom() {
    const pending = this.#pending;
    for (let i = this.#pendingHead; i < pending.length; i++) if (pending[i].left.size > 0) return pending[i].first;
    return Infinity;
  }

  /** The id of the newest entry; resuming from it replays nothing. */
  get lastEventId() {
    return formatEventId(this.#epoch, this.#next - 1);
  }

  formatId(seq) {
    return formatEventId(this.#epoch, seq);
  }

  // Appends run one at a time: two batches must not race for the same seqs.
  #serialize(task) {
    const run = this.#writes.then(task, task);
    this.#writes = run.catch(() => {});
    return run;
  }

  /**
   * Appends a batch: the seqs are reserved at once — the vector moves, so
   * the next op of a stream is numbered after this one before it is on
   * disk — and the returned promise (a ticket: `ticket.entries` holds the
   * entries with their seqs from the start) resolves once the batch is on
   * disk, with the entries. Appends that come while a group is being
   * written join the next group, written as one file when the first is
   * down — a group commit — and are published (read, served, counted) in
   * seq order, each group as its file lands. A write that fails rejects
   * every ticket of its group and of the group gathered behind it, takes
   * their seqs back and leaves nothing published: the next append gets the
   * first of them again. Rolls the open files into a segment when enough
   * have accumulated. Ops in `skipped` were accepted but not applied here
   * (a beforeApply hook said no, the record failed its schema, or the op is
   * from a newer schema version — then `held` maps it to that version):
   * they are logged and served like any other, and flagged so a reopen's
   * replay of the tail leaves them alone too; a held one is applied once
   * this node runs its version.
   */
  append(ops, options) {
    const { entries, done } = this.enqueue(ops, options);
    const ticket = done.then(() => entries);
    ticket.entries = entries;
    return ticket;
  }

  /**
   * What `append` does, for the storage's write paths: `{ entries, done }` —
   * the entries, their seqs reserved, and `done`, the group's promise,
   * settled once the group is on disk (or failed) and shared by every append
   * in it, so an append makes no promise of its own. `onDurable` runs once
   * the group is durable, before `done` settles, in append order.
   */
  enqueue(
    ops,
    { skipped = null, held = null, ready = null, fps = null, headers = null, scrubbed = null, onDurable = null } = {},
  ) {
    const entries = [];
    if (ops.length === 0) return { entries, done: DONE };
    const group = (this.#group ??= this.#newGroup());
    // The fingerprints by op: an array beside `ops` (what `link` hands back),
    // or a map (a peer's page, of which some ops are taken).
    const byIndex = Array.isArray(fps);
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const seq = this.#next++;
      const entry = { seq, op };
      if (skipped?.has(op)) entry.skipped = true;
      // Logged as a scrub leaves it (the caller took the payload): no rewrite to come.
      if (scrubbed?.has(op)) entry.scrubbed = true;
      if (held?.has(op)) entry.held = held.get(op);
      const fp = fps === null ? undefined : byIndex ? fps[i] : fps.get(op);
      entries.push(entry);
      group.entries.push(entry);
      // The header texts a writer made (`link`): the group's line takes them as they are.
      if (headers !== null) {
        if (group.headers === null) {
          group.headers = [];
          for (let k = 0; k < group.entries.length - 1; k++) group.headers.push(undefined);
        }
        group.headers.push(headers[i]);
      } else if (group.headers !== null) group.headers.push(undefined);
      const stream = opKey(op);
      if (!group.undo.has(stream)) {
        group.undo.set(stream, Object.hasOwn(this.#vector, stream) ? this.#vector[stream] : undefined);
      }
      vectorAdvance(this.#vector, op);
      if (fp !== undefined) {
        entry.fp = fp;
        // The stream's head before the group, once: what a failure puts back.
        const key = opKey(op);
        if (!group.heads.has(key)) {
          const head = this.#heads.get(key);
          group.heads.set(key, head === undefined ? undefined : [head[0], head[1]]);
        }
        this.#print(entry);
      }
      this.#observe(op);
    }
    // What the ops still wait for before they can be written (a signature
    // being made): the group's file waits for it.
    if (ready !== null) group.ready.push(ready);
    // What runs once the group is durable, before its callers hear it: in
    // append order, the roll the group triggered done.
    if (onDurable !== null) (group.durable ??= []).push(onDurable);
    this.#schedule();
    return { entries, done: group.promise };
  }

  /**
   * The op the gathering group ends with — a group not on its way to the
   * disk yet, whose ops may still change: what a write made at once may
   * extend (src/commit.js, a plugin's `coalesce`) — or null when nothing
   * gathers or the last entry is flagged. An op is never changed once its
   * group has started writing.
   */
  lastGathered() {
    const group = this.#group;
    if (group === null) return null;
    const last = group.entries[group.entries.length - 1];
    if (last === undefined || last.skipped || last.scrubbed || last.held !== undefined) return null;
    return last.op;
  }

  // A group to gather appends into: what the vector and the counter were
  // before it, and the heads of the streams it touches, for a write that
  // fails.
  #newGroup() {
    const group = {
      entries: [],
      ready: [],
      from: this.#next,
      // What a failure puts back, key by key: the seq each stream the group
      // moved held before it (undefined: none). The whole vector was copied
      // for every group — thousands of streams on a hub, for each append.
      undo: new Map(),
      heads: new Map(),
      // Beside `entries`, where an append handed its header texts in; null where none did.
      headers: null,
      durable: null,
      resolve: null,
      reject: null,
    };
    group.promise = new Promise((resolve, reject) => {
      group.resolve = resolve;
      group.reject = reject;
    });
    // A rejection nobody awaits yet is not unhandled: every ticket chains on it.
    group.promise.catch(() => {});
    return group;
  }

  // The groups go one after another, through the same lane as a scrub or a
  // roll, until none is left to write.
  #schedule() {
    if (this.#flushing) return;
    this.#flushing = true;
    const drain = async () => {
      try {
        while (this.#group !== null) await this.#flushGroup();
      } finally {
        this.#flushing = false;
      }
    };
    // `#flushGroup` settles every group it takes; what could still throw
    // here is a bug, said out loud rather than lost.
    this.#serialize(drain).catch((error) => this.#log?.error?.({ event: 'log.flush.failed', err: error }));
  }

  async #flushGroup() {
    const group = this.#group;
    this.#group = null;
    const { entries } = group;
    const first = entries[0].seq;
    const last = entries[entries.length - 1].seq;
    const started = this.#otel.enabled ? now() : 0;
    // What the ops still wait for before they can be written (a signature being made).
    if (group.ready.length > 0) {
      try {
        await Promise.all(group.ready);
      } catch (error) {
        this.#fail(group, error);
        return;
      }
    }
    // The medium writes the group — a journal line, a file of its own, rows —
    // and tells `#fail` at once when it cannot: its seqs go to the next group,
    // and what the failed write left behind never comes back at a reopen.
    const landed = await this.#store.append(entries, group.headers, {
      first,
      last,
      sealedTo: this.#sealedTo,
      onFail: (error) => this.#fail(group, error),
      entriesBetween: (from, to) => this.#between(from, to),
    });
    if (!landed) return;
    // The group is on disk: from here on its callers are answered whatever
    // happens — a throw past this point would leave them, and every write
    // landing behind them in log order, waiting for good.
    try {
      if (started) this.#otel.recordAppend(now() - started, entries.length);
      const seqs = this.#sealApplied ? [] : null;
      for (const entry of entries) {
        this.#entries.push(entry);
        this.#indexEntry(entry);
        this.#stream(entry);
        if (seqs !== null) seqs.push(entry.seq);
      }
      if (seqs !== null) this.#hold(seqs);
      // A roll is what makes one append slow every `rollAfter` groups: its
      // callers wait for it, as they did before groups. A roll that fails
      // (the disk full as a segment is written) seals nothing: the groups
      // stay open, durable, and the next append rolls again.
      if (this.#store.open >= this.#rollAfter) {
        try {
          await this.#roll();
        } catch (error) {
          this.#rollFailures++;
          this.#log?.error?.({ event: 'log.roll.failed', err: error, open: this.#store.open });
        }
      }
    } catch (error) {
      this.#log?.error?.({ event: 'internal.error', name: 'log', err: error });
    }
    // A callback that throws is a bug of its caller's: said, and the rest run.
    if (group.durable !== null) {
      for (let i = 0; i < group.durable.length; i++) {
        try {
          group.durable[i]();
        } catch (error) {
          this.#log?.error?.({ event: 'internal.error', name: 'log', err: error });
        }
      }
    }
    group.resolve();
  }

  // A group that did not reach the disk, and the one gathered behind it
  // (its seqs follow): their callers told, the counter, the vector and the
  // heads put back to before the first of them, so the seqs are handed out
  // again and the next op of a stream chains to what is durable.
  #fail(group, error) {
    this.#appendFailures++;
    this.#otel.recordAppendFailure();
    this.#log?.error?.({ event: 'log.append.failed', from: group.from, ops: group.entries.length, err: error });
    const later = this.#group;
    this.#group = null;
    this.#next = group.from;
    // The later group first: the seqs and heads before the first are the ones kept.
    for (const failed of later === null ? [group] : [later, group]) {
      for (const [stream, seq] of failed.undo) {
        if (seq === undefined) delete this.#vector[stream];
        else this.#vector[stream] = seq;
      }
      for (const entry of failed.entries) this.#unprint(entry);
      for (const [key, head] of failed.heads) {
        if (head === undefined) this.#heads.delete(key);
        else this.#heads.set(key, head);
      }
    }
    if (this.#onFail !== null) {
      try {
        this.#onFail(error, group.from);
      } catch (thrown) {
        this.#log?.warn?.({ event: 'listener.error', name: 'log', err: thrown });
      }
    }
    group.reject(error);
    if (later !== null) later.reject(error);
  }

  // Sealing: write the segment, then the index, then remove the open files.
  // Any crash in between leaves duplicates, which #adopt tolerates. Under
  // `sealApplied` only the batches marked applied go; a batch is applied
  // whole, so the cut never falls inside an open file.
  async #roll() {
    if (this.#store.open === 0) return;
    const sealedFrom = this.#sealedTo + 1;
    const limit = this.#sealApplied ? this.#unappliedFrom - 1 : Infinity;
    if (limit < sealedFrom) return;
    const entries = this.#entries.slice(this.#lowerBound(sealedFrom), this.#lowerBound(limit + 1));
    if (entries.length === 0) return;
    const otel = this.#otel;
    if (!otel.enabled) return void (await this.#seal(entries));
    // Spanned on its own: a roll is why one append (and so one commit) is
    // slow every `rollAfter` writes, which a duration histogram alone hides.
    const after = ({ dropped }) => ({
      'syncom.log.sealed': entries.length,
      'syncom.log.dropped': dropped,
      'syncom.log.floor': this.#floor,
    });
    const { dropped } = await traced(otel, 'syncom.log.roll', {}, () => this.#seal(entries), after);
    otel.recordLogRoll(entries.length, dropped);
  }

  async #seal(entries) {
    const from = entries[0].seq;
    const to = entries[entries.length - 1].seq;
    await this.#store.seal(entries, from, to);
    // The index changes at a roll only where compaction dropped something:
    // the vector, the heads and the newest stamp a reopen reads from the
    // files, the segment among them.
    const dropped = await this.#compact();
    if (dropped > 0) await this.#writeIndex();
    // The open files whose groups the segment holds go: a group is applied
    // whole, so the cut never falls inside one.
    await this.#store.sealed(to);
    if (this.#onRoll !== null) {
      try {
        this.#onRoll({ sealed: entries.length, dropped, floor: this.#floor, segments: this.#store.segments.length });
      } catch (error) {
        this.#log?.warn?.({ event: 'listener.error', name: 'log', err: error });
      }
    }
    return { dropped };
  }

  // The retained entries with seqs in [from, to], a copy.
  #between(from, to) {
    return this.#entries.slice(this.#lowerBound(from), this.#lowerBound(to + 1));
  }

  // Drops whole sealed segments from the front while the log exceeds its
  // retention; the floor moves up and `vector` keeps what was dropped.
  // Returns how many segments went.
  async #compact() {
    const { ops, days } = this.#retention;
    const cutoff = days ? Date.now() - days * 86_400_000 : null;
    let dropped = 0;
    const segments = this.#store.segments;
    while (segments.length > 1) {
      const oldest = segments[0];
      const overOps = ops ? this.#entries.length - oldest.count >= ops : false;
      const lastTs = this.#entryAt(oldest.to)?.op?.ts ?? Infinity;
      const overAge = cutoff !== null && lastTs < cutoff;
      const tooMany = ops ? this.#entries.length > ops : false;
      if (!(tooMany && overOps) && !overAge) break;
      if (this.#keeps(oldest.to)) break;
      for (const entry of this.#entries) {
        if (entry.seq > oldest.to) break;
        if (entry.held !== undefined) this.#droppedHeld++;
        if (typeof entry.op?.ts === 'number' && entry.op.ts > this.#droppedTs) this.#droppedTs = entry.op.ts;
        this.#unindexEntry(entry);
        this.#unprint(entry);
        this.#unstream(entry);
      }
      this.#entries = this.#entries.slice(this.#lowerBound(oldest.to + 1));
      this.#floor = oldest.to + 1;
      await this.#store.drop(oldest);
      dropped++;
    }
    return dropped;
  }

  // Whether an entry up to `to` must stay: the segment that holds it does.
  #keeps(to) {
    if (this.#keep === null && this.#pins.size === 0) return false;
    for (const entry of this.#entries) {
      if (entry.seq > to) return false;
      if (this.#keep !== null && this.#keep(entry)) return true;
      for (const pin of this.#pins) if (pin(entry)) return true;
    }
    return false;
  }

  /**
   * Like `retain`, for a reader: entries `keep(entry)` answers true for stay,
   * with their segment and everything after it, until the returned function
   * is called. Pins add up — one per reader of the past — and leave `retain`
   * to the sync manager.
   */
  pin(keep) {
    if (typeof keep !== 'function') throw new TypeError('pin(keep): keep must be a function');
    this.#pins.add(keep);
    return () => void this.#pins.delete(keep);
  }

  /** How many readers hold segments past retention (`pin`). */
  get pins() {
    return this.#pins.size;
  }

  /**
   * Entries compaction must not drop, whatever the retention: `keep(entry)`
   * answers true for one that must stay, and the segment holding it stays
   * with everything after it. The sync manager of a node that dials keeps
   * its own ops until every node it syncs with has them. `null` clears it.
   */
  retain(keep) {
    if (keep !== null && typeof keep !== 'function') {
      throw new TypeError('retain(keep): keep must be a function or null');
    }
    this.#keep = keep;
  }

  async #writeIndex() {
    const index = {
      epoch: this.#epoch,
      floor: this.#floor,
      next: this.#next,
      vector: this.#vector,
      heads: Object.fromEntries(this.#heads),
      droppedHeld: this.#droppedHeld,
      latestTs: this.#latestTs,
      droppedTs: this.#droppedTs,
    };
    await this.#store.saveIndex(index);
  }

  /** The entries held for a newer schema version, oldest first. */
  held() {
    const held = [];
    for (let i = 0; i < this.#entries.length; i++) {
      if (this.#entries[i].held !== undefined) held.push(this.#entries[i]);
    }
    return held;
  }

  /**
   * The newest `ts` among the ops this log no longer holds — compacted away,
   * or in a segment an open could not read — persisted with the index. Zero
   * while nothing was ever dropped: every op this node applied is still here,
   * and a fold of the retained entries is the whole past. Above zero, the
   * past of a record is whole only from an op stamped after it that resets
   * the record (a `write`, a `delete`, a `purge`) — everything dropped was
   * stamped at or below it, and a reset discards what is below it anyway.
   */
  get droppedTs() {
    return this.#droppedTs;
  }

  /** Files whose checksum did not match at this open — a segment lost or an open file dropped for it. */
  get corrupt() {
    return this.#store.corrupt;
  }

  /** Rolls that failed since the open (`log.roll.failed`): the groups they would have sealed stay open and durable. */
  get rollFailures() {
    return this.#rollFailures;
  }

  /**
   * What the open groups are — `{ journaled, open, unapplied, torn, lost,
   * appendFailures }`: whether the backend appends (a journal) or each
   * group is a file, the groups not sealed yet, those not yet applied to
   * the records (a reopen replays them), the journal lines an open left out
   * as torn, whether an open lost entries it could not read, and the groups
   * whose write failed since this open.
   */
  get health() {
    let unapplied = 0;
    for (let i = this.#pendingHead; i < this.#pending.length; i++) if (this.#pending[i].left.size > 0) unapplied++;
    const { journaled, open, torn, lost } = this.#store.health;
    return { journaled, open, unapplied, torn, lost, appendFailures: this.#appendFailures };
  }

  /** Every record id the retained entries name, unsorted. */
  ids() {
    return [...this.#byId.keys()];
  }

  /** How many held entries compaction has dropped — lost for good — since the last reset. */
  get droppedHeld() {
    return this.#droppedHeld;
  }

  resetDroppedHeld() {
    return this.#serialize(async () => {
      if (this.#droppedHeld === 0) return;
      this.#droppedHeld = 0;
      await this.#writeIndex();
    });
  }

  /**
   * Adopts a peer's vector after a snapshot of its state was joined: every op
   * up to it is reflected in what was merged, so it need not be offered again.
   * Persisted with the index, like the rest of the vector.
   */
  advance(vector) {
    return this.#serialize(async () => {
      let moved = false;
      const keys = Object.keys(vector);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const seq = vector[key];
        if (Number.isSafeInteger(seq) && (this.#vector[key] ?? 0) < seq) {
          this.#vector[key] = seq;
          moved = true;
        }
      }
      if (moved) await this.#writeIndex();
    });
  }

  /** Forces a roll + compaction now; otherwise they happen every rollAfter appends. */
  flush() {
    return this.#serialize(() => this.#roll());
  }

  /**
   * Strips the payload of every entry of `id` — `data`, `meta`, `key`,
   * `value`, and the `nonce` that salted their digest — in memory and in
   * the files that hold them, flagging each `scrubbed`; the op keeps its
   * position, origin, seq and stamp, its signature and digest, so the
   * vector and a resuming peer are unaffected (a scrubbed `write` applies
   * as a no-op, and its header still verifies). Returns how many entries. A file is rewritten in place: a
   * crash in the middle tears it — a torn segment is skipped at the next
   * open (what it held is gone from `since`, and a peer resuming through it
   * bootstraps), a torn open file is dropped — the price of forgetting over
   * a backend with no rename.
   */
  scrub(id) {
    return this.#serialize(() => {
      const otel = this.#otel;
      if (!otel.enabled) return this.#scrub(id);
      return traced(
        otel,
        'syncom.log.scrub',
        {},
        () => this.#scrub(id),
        (fresh) => ({ 'syncom.log.scrubbed': fresh }),
      );
    });
  }

  async #scrub(id) {
    // Every entry of the id (from the index, not a walk), for the files to
    // rewrite; the ones still holding a payload, for the count. A rewrite
    // that failed last time left the files behind memory: the id stays
    // marked torn, and the next scrub rewrites them whether or not
    // anything is fresh.
    const seqs = this.#byId.get(id) ?? new Set();
    const torn = this.#torn.has(id);
    // The files to rewrite are the ones holding what this scrub takes —
    // every file of the id only after a rewrite that failed: a file whose
    // entries of the id were scrubbed before is as it should be, and a peer
    // that sends op after op for a purged id must not cost a rewrite of
    // every segment that ever held it.
    const taken = [];
    let fresh = 0;
    for (const seq of seqs) {
      const entry = this.#entryAt(seq);
      if (!entry) continue;
      if (!entry.scrubbed) {
        scrubOp(entry.op);
        entry.scrubbed = true;
        fresh++;
        taken.push(seq);
      } else if (torn) taken.push(seq);
    }
    if (taken.length === 0) return 0;
    this.#torn.add(id);
    // The lane is this scrub's: no append or roll changes `seqs` meanwhile.
    // The medium writes the files (or rows) holding what was taken again, as
    // the entries are now; a copy kept as evidence that names the id goes whole.
    const sorted = taken.sort((a, b) => a - b);
    await this.#store.scrub(sorted, {
      id,
      sealedTo: this.#sealedTo,
      entriesBetween: (from, to) => this.#between(from, to),
    });
    this.#torn.delete(id);
    return fresh;
  }

  /**
   * Everything after `eventId`, oldest first, or `null` when the caller
   * cannot be resumed: an id from another epoch, or one that fell below the
   * floor. No id at all resumes from the very beginning — possible only while
   * nothing has been compacted away.
   */
  /**
   * The entries after `eventId` — `{ entries, last }`: the entries in
   * `scopes` (all of them, or the first `limit`), and `last`, the seq of the
   * last entry EXAMINED, in scope or not — where a reader's cursor may move
   * to, so that an entry of another scope is looked at once rather than on
   * every read; `null` when nothing was examined. A real entry's position,
   * unlike `lastEventId`, which runs ahead of the entries while an append is
   * in flight. The whole answer is `null` when the position cannot be
   * resumed: another epoch, or compacted past.
   */
  read(eventId, { scopes = null, limit = Infinity } = {}) {
    let after;
    if (eventId === undefined || eventId === null) {
      if (this.#floor > 1) return null;
      after = 0;
    } else {
      const parsed = parseEventId(eventId);
      if (!parsed || parsed.epoch !== this.#epoch) return null;
      if (parsed.seq < this.#floor - 1) return null;
      after = parsed.seq;
    }
    const entries = [];
    let last = null;
    let index = this.#lowerBound(after + 1);
    for (; index < this.#entries.length && entries.length < limit; index++) {
      const entry = this.#entries[index];
      last = entry.seq;
      // An op without a scope (or scoped '*') is global and reaches every
      // subscriber; a scoped one only those who asked for that scope.
      if (!inScope(entry.op.scope ?? GLOBAL_SCOPE, scopes)) continue;
      entries.push(entry);
    }
    return { entries, last };
  }

  /** The entries after `eventId` in `scopes` (see `read`), or null when the position cannot be resumed. */
  since(eventId, options) {
    return this.read(eventId, options)?.entries ?? null;
  }

  /** Every retained entry, oldest first, without a copy — for a selection over the whole log (src/sync/outbound.js). */
  *scan() {
    yield* this.#entries;
  }

  /** Every retained entry of the record `id`, oldest first — what `repair()` rebuilds from. */
  entriesOf(id) {
    const seqs = this.#byId.get(id);
    if (!seqs) return [];
    const entries = [];
    for (const seq of [...seqs].sort((a, b) => a - b)) {
      const entry = this.#entryAt(seq);
      if (entry !== undefined) entries.push(entry);
    }
    return entries;
  }

  // Index of the first entry whose seq >= target (entries are sorted).
  #lowerBound(target) {
    let low = 0;
    let high = this.#entries.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.#entries[mid].seq < target) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  /** The unsealed tail — what a reopen replays onto the records. */
  tail() {
    return this.#entries.slice(this.#lowerBound(this.#sealedTo + 1));
  }

  /** Seals what can be sealed and writes the index: a reopen after a clean close replays nothing it need not. */
  close() {
    return this.#serialize(async () => {
      await this.#roll();
      await this.#writeIndex();
    });
  }
}

// Whether this node applied a log entry: not skipped, or held for a schema
// version this node has since reached (and replayed). What a replay, a
// repair and a version of the past read the log by.
const appliedHere = (entry, version) =>
  !entry.skipped || (entry.held !== undefined && version !== null && entry.held <= version);

module.exports = {
  OpLog,
  appliedHere,
  // A log file's text, written and read, and a segment's (src/files/journal.js): for the tests that alter one.
  fileOf,
  readFile,
  segmentOf,
  readSegment,
};
