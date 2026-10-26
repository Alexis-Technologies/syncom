'use strict';

// The persisted operation log: every op this node applied — its own and the
// ones it accepted from peers — in the order they landed here. Two things read
// it: a subscriber resuming from an event id (`since`), and the node itself on
// reopen (the tail is replayed onto the records, which is what makes a crash
// between "logged" and "written to data/" recoverable).
//
// Layout under `<path>/log/`, over fsi (whole-file read/write, no rename):
//   open/<seq>-<n>.jsonl  a JOURNAL, where the backend can append: one line
//                       per GROUP of appends — every append that came while
//                       the line before it was being written — named by the
//                       first seq it holds and a token unique to this open;
//                       begun again at every roll, removed once every group
//                       in it is sealed, rewritten only by a scrub. A torn
//                       write can only damage its last line, whose group was
//                       never announced to anyone
//   open/<seq>.json     the same group as a file of its own, where the
//                       backend cannot append (and from before journals)
//   seg-<from>.json     sealed segments: the open files rolled together once
//                       enough of them accumulate
//   corrupt/<name>      an open group file that read whole but failed its
//                       checksum: kept aside as the evidence, its entries
//                       lost from this node (`droppedTs`, `corrupt`)
//   index.json          { epoch, floor, next, vector, heads, segments,
//                       droppedHeld, latestTs, droppedTs } — a summary;
//                       the files are the source of truth and anything the
//                       index lacks is rebuilt from a directory listing
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
const { checksum } = require('./hash.js');
const { GLOBAL_SCOPE, inScope } = require('./scope.js');
const { writerOf, traced, now } = require('./telemetry.js');
const { SyncomError } = require('./errors.js');
const { scrubOp } = require('./header.js');

const OPEN = 'open';
const CORRUPT = 'corrupt';
const JOURNAL = '.jsonl';
const INDEX = 'index.json';
const DEFAULT_ROLL_AFTER = 64;
const DEFAULT_RETENTION_OPS = 10_000;

// SHA-256 as base64url (src/digest.js `hashOf`), as src/shape.js checks an op's `prev`.
const FINGERPRINT = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

const pad = (n) => String(n).padStart(10, '0');
const segmentName = (from) => `seg-${pad(from)}.json`;

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// A log file: its entries and their checksum (xxHash32 of the entries'
// JSON), so a torn or altered file is told from a whole one at open. A file
// without one (an older format) is taken as it is.
const fileOf = (entries) => {
  const text = JSON.stringify(entries);
  return `{"entries":${text},"hash":"${checksum(text)}"}`;
};
// A file the listing or the index names that is not there — removed
// between the two — reads as nothing. Any other failure to read it (EIO,
// EMFILE, a quota) fails the open: one that went on without it could hand
// its seqs out again, and a transient error would cost what it held.
const isAbsent = (error) => error?.code === 'ENOENT' || error?.name === 'NotFoundError';
const readOrNull = async (fsi, dir, name) => {
  try {
    return await fsi.read(dir, name);
  } catch (error) {
    if (isAbsent(error)) return null;
    throw new SyncomError('CORRUPT', `The log file ${dir}/${name} cannot be read`, { cause: error, file: name });
  }
};

const readFile = (text) => {
  const parsed = text === null ? null : parseJson(text);
  if (!parsed || !Array.isArray(parsed.entries)) return { entries: null, reason: 'malformed' };
  if (parsed.hash !== undefined && checksum(JSON.stringify(parsed.entries)) !== parsed.hash) {
    return { entries: null, reason: 'checksum' };
  }
  return { entries: parsed.entries, reason: null };
};

// Whether the ascending `seqs` hold one in [from, to].
const anyWithin = (seqs, from, to) => {
  let low = 0;
  let high = seqs.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (seqs[mid] < from) low = mid + 1;
    else high = mid;
  }
  return low < seqs.length && seqs[low] <= to;
};

// What the log does not replay is written whole or not at all (see src/fsi.js).
const ATOMIC = Object.freeze({ atomic: true });

class OpLog {
  #path;
  #openPath;
  #entries = [];
  // The groups the open files hold, in seq order: `{ first, last, file }`.
  #open = [];
  // Where the backend can append, the groups go as lines of a journal: the
  // one being written, this open's token for its names, how many it began.
  #journaled = false;
  #journal = null;
  #session = Date.now().toString(36);
  #journals = 0;
  #segments = [];
  #next = 1;
  #latestTs = 0;
  #floor = 1;
  #epoch = null;
  #vector = {};
  // Stream → seq → fingerprint, of every op retained (and every op reserved);
  // stream → [seq, fingerprint] of the newest op ever held, compacted or not.
  #prints = new Map();
  #heads = new Map();
  #rollAfter;
  #retention;
  #log;
  #rollFailures = 0;
  #otel;
  #fsi;
  #droppedHeld = 0;
  // The newest stamp among the ops compaction dropped, or that this open
  // could not read: what a reader of the past checks before it trusts the
  // log to be whole from some point on (see `droppedTs`).
  #droppedTs = 0;
  // Files whose checksum did not match at open: altered or torn on disk.
  #corrupt = 0;
  #lost = false;
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
  #seen = null;

  constructor(basePath, options = {}) {
    this.#path = `${basePath}/log`;
    this.#openPath = `${this.#path}/${OPEN}`;
    this.#fsi = options.fsi ?? defaultFsi;
    this.#journaled = typeof this.#fsi.append === 'function';
    this.#rollAfter = options.rollAfter ?? DEFAULT_ROLL_AFTER;
    // `'all'` keeps everything: the log of a node that must answer any version.
    const retention = options.retention === 'all' ? { ops: Infinity } : options.retention;
    this.#retention = { ops: DEFAULT_RETENTION_OPS, ...retention };
    this.#log = options.logger ?? null;
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
    const hasIndex = await this.#fsi.exists(this.#path, INDEX);
    const index = hasIndex ? parseJson(await this.#fsi.read(this.#path, INDEX)) : null;
    if (index) {
      this.#epoch = index.epoch;
      this.#floor = index.floor ?? 1;
      this.#vector = index.vector ?? {};
      this.#takeHeads(index.heads);
      this.#segments = Array.isArray(index.segments) ? index.segments : [];
      this.#droppedHeld = Number.isInteger(index.droppedHeld) ? index.droppedHeld : 0;
      // Seeded from the index; what the files hold only moves it up.
      if (typeof index.latestTs === 'number') this.#latestTs = index.latestTs;
      // An index from before droppedTs was kept, with something already
      // compacted: what went is unknown, so nothing retained is vouched for.
      if (typeof index.droppedTs === 'number') this.#droppedTs = index.droppedTs;
      else if (this.#floor > 1) this.#lost = true;
    } else {
      // No (readable) index: a new incarnation. Existing segments are still
      // picked up below, but their ids belong to an epoch nobody can resume.
      this.#epoch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      this.#segments = [];
    }
    await this.#loadSegments(hasIndex);
    await this.#loadOpen();
    this.#seen = null;
    // Entries this open could not read, or an incarnation that starts above
    // seq 1 without an index to say what it dropped: as good as compacted,
    // up to the newest stamp known.
    if (this.#lost || (!index && this.#floor > 1)) this.#droppedTs = Math.max(this.#droppedTs, this.#latestTs);
    if (!index) {
      // Every subscriber of this node will be told to bootstrap: worth a
      // line when there was a log here, a whisper for a brand-new one.
      const level = this.#entries.length > 0 ? 'warn' : 'debug';
      const reason = hasIndex ? 'unreadable index' : 'no index';
      this.#log?.[level]?.({ event: 'log.epoch.new', epoch: this.#epoch, reason, entries: this.#entries.length });
      await this.#writeIndex();
    }
    return this;
  }

  async #loadSegments(hasIndex) {
    const known = new Set();
    for (let i = 0; i < this.#segments.length; i++) known.add(this.#segments[i].name);
    const names = await this.#fsi.list(this.#path);
    for (const name of names) {
      if (!name.startsWith('seg-') || known.has(name)) continue;
      // A segment the index does not know: rolled, then crashed before the
      // index was rewritten. Adopt it.
      const from = Number(name.slice(4, -5));
      if (Number.isInteger(from)) this.#segments.push({ name, from, to: from, count: 0 });
    }
    this.#segments.sort((a, b) => a.from - b.from);
    for (const segment of this.#segments) {
      const text = await readOrNull(this.#fsi, this.#path, segment.name);
      const { entries, reason } = readFile(text);
      if (entries === null) {
        this.#log?.error?.({ event: 'log.segment.unreadable', segment: segment.name, reason });
        this.#lost = true;
        if (reason === 'checksum') this.#corrupt++;
        continue;
      }
      this.#adopt(entries);
      if (entries.length > 0) {
        segment.to = entries[entries.length - 1].seq;
        segment.count = entries.length;
      }
    }
    // The floor is durable in the index; a fresh index means everything on
    // disk is retained from its first entry.
    if (!hasIndex && this.#entries.length > 0) this.#floor = this.#entries[0].seq;
  }

  async #loadOpen() {
    const names = await this.#fsi.list(this.#openPath);
    const sealedTo = this.#sealedTo;
    // Newest first: a group whose write failed may have left its line at the
    // end of a journal, and the group that took its seqs back went to a
    // newer file — #adopt keeps the first copy of a seq it sees.
    names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    // Journals a newer one shadows a line of: rewritten below.
    const stale = new Set();
    for (const name of names) {
      const text = await readOrNull(this.#fsi, this.#openPath, name);
      // Gone since the listing: nothing to read.
      if (text === null) continue;
      if (name.endsWith(JOURNAL)) {
        if (this.#loadJournal(name, text, sealedTo)) stale.add(name);
        continue;
      }
      const { entries, reason } = readFile(text);
      if (entries === null) {
        if (reason === 'checksum') {
          // Whole once — its hash is there — and changed since: answered
          // entries, lost here. Kept aside as the evidence, never deleted.
          this.#log?.error?.({ event: 'log.open.unreadable', file: name, reason, kept: `${CORRUPT}/${name}` });
          this.#corrupt++;
          this.#lost = true;
          await this.#fsi.write(`${this.#path}/${CORRUPT}`, name, text);
        } else {
          // Torn on the way down: its write never finished, so its batch was
          // never announced — dropped.
          this.#log?.info?.({ event: 'log.open.torn', file: name, reason });
        }
        await this.#fsi.remove(this.#openPath, name);
        continue;
      }
      this.#opened(name, entries, sealedTo);
    }
    // The groups in seq order, like the appends that made them.
    this.#open.sort((a, b) => a.first - b.first);
    this.#pending.sort((a, b) => a.first - b.first);
    // A shadowed line is a copy left behind — by a scrub or a group's
    // failed append cut short — and may hold a payload a scrub took away:
    // its journal goes, rewritten with the groups it still holds.
    for (const name of stale) await this.#rewriteJournal(name, sealedTo);
  }

  // A journal written again under a new name with the groups of it still
  // open, then removed: never rewritten in place (see #scrub).
  async #rewriteJournal(file, sealedTo) {
    const groups = [];
    for (const group of this.#open) if (group.file === file) groups.push(group);
    if (groups.length > 0) {
      let content = '';
      for (const group of groups) {
        const from = Math.max(group.first, sealedTo + 1);
        content += `${fileOf(this.#entries.slice(this.#lowerBound(from), this.#lowerBound(group.last + 1)))}\n`;
      }
      const copy = this.#journalName(groups[0].first);
      await this.#fsi.write(this.#openPath, copy, content);
      for (const group of groups) group.file = copy;
      if (this.#journal === file) this.#journal = null;
    }
    await this.#fsi.remove(this.#openPath, file);
  }

  // A journal read back, line by line. Its last line may be torn — its group
  // was never acknowledged, and its seqs were handed out again — and is left
  // out; a line before it that does not read was acknowledged once and is
  // lost now. A journal is never appended to by a later open.
  // A line is a group, whole or not at all: one with a seq a newer journal
  // holds already is shadowed — the line of a group whose append failed
  // (its seqs went to the group after it, which may be shorter), or a copy
  // a scrub left behind — and none of it comes back. Answers whether a line
  // was shadowed.
  #loadJournal(name, text, sealedTo) {
    const lines = text.split('\n');
    let end = lines.length;
    while (end > 0 && lines[end - 1] === '') end--;
    let shadowed = false;
    for (let i = 0; i < end; i++) {
      if (lines[i] === '') continue;
      const { entries, reason } = readFile(lines[i]);
      if (entries !== null) {
        if (this.#shadowed(entries, sealedTo)) shadowed = true;
        else this.#opened(name, entries, sealedTo);
        continue;
      }
      if (reason === 'checksum') this.#corrupt++;
      if (i === end - 1) {
        this.#log?.info?.({ event: 'log.open.torn', file: name, reason });
      } else {
        this.#log?.error?.({ event: 'log.open.unreadable', file: name, reason });
        this.#lost = true;
      }
    }
    return shadowed;
  }

  // Whether a group read from a journal has a seq past the segments that a
  // newer journal gave already (a seq a segment holds is a roll cut short,
  // not a shadow).
  #shadowed(entries, sealedTo) {
    const seen = this.#seen;
    if (seen === null) return false;
    for (let i = 0; i < entries.length; i++) {
      const seq = entries[i]?.seq;
      if (Number.isInteger(seq) && seq > sealedTo && seen.has(seq)) return true;
    }
    return false;
  }

  // A group read back from an open file: adopted, kept with its file, and
  // held until the owner's replay says its records were written — unless a
  // segment has it already (a crash mid-roll left it in both).
  #opened(file, entries, sealedTo) {
    this.#adopt(entries);
    let first = Infinity;
    let last = -Infinity;
    // The seqs a segment does not have yet, for the hold.
    const unsealed = [];
    for (const entry of entries) {
      if (!Number.isInteger(entry.seq)) continue;
      if (entry.seq > sealedTo) unsealed.push(entry.seq);
      if (entry.seq < first) first = entry.seq;
      if (entry.seq > last) last = entry.seq;
    }
    if (first === Infinity) return;
    this.#open.push({ first, last, file });
    if (this.#sealApplied) this.#hold(unsealed);
  }

  // The newest seq a segment holds, or below the floor when none does.
  get #sealedTo() {
    return this.#segments.length > 0 ? this.#segments[this.#segments.length - 1].to : this.#floor - 1;
  }

  // A journal's name: the first seq it holds, then this open's token and how
  // many journals it has begun — never a name a failed group's line is in.
  #journalName(first) {
    return `${pad(first)}-${this.#session}${(++this.#journals).toString(36).padStart(4, '0')}${JOURNAL}`;
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

  // Merges loaded entries in, deduplicating by seq (a crash mid-roll leaves
  // the same batch both sealed and open) and keeping the order by seq.
  #adopt(entries) {
    // The seqs already held, built once per open rather than once per file.
    let seen = this.#seen;
    if (seen === null) {
      seen = new Set();
      for (let i = 0; i < this.#entries.length; i++) seen.add(this.#entries[i].seq);
      this.#seen = seen;
    }
    let added = false;
    for (const entry of entries) {
      if (!entry || !Number.isInteger(entry.seq) || seen.has(entry.seq)) continue;
      seen.add(entry.seq);
      this.#entries.push(entry);
      added = true;
      if (entry.seq >= this.#next) this.#next = entry.seq + 1;
      if (entry.op) {
        vectorAdvance(this.#vector, entry.op);
        this.#observe(entry.op);
        this.#indexEntry(entry);
        if (typeof entry.fp === 'string') this.#print(entry);
      }
    }
    if (added) this.#entries.sort((a, b) => a.seq - b.seq);
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
    return this.#segments.length;
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
  append(ops, { skipped = null, held = null, ready = null, fps = null, scrubbed = null } = {}) {
    const entries = [];
    if (ops.length === 0) {
      const ticket = Promise.resolve(entries);
      ticket.entries = entries;
      return ticket;
    }
    const group = (this.#group ??= this.#newGroup());
    for (const op of ops) {
      const seq = this.#next++;
      const entry = { seq, op };
      if (skipped?.has(op)) entry.skipped = true;
      // Logged as a scrub leaves it (the caller took the payload): no rewrite to come.
      if (scrubbed?.has(op)) entry.scrubbed = true;
      if (held?.has(op)) entry.held = held.get(op);
      const fp = fps?.get(op);
      entries.push(entry);
      group.entries.push(entry);
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
    this.#schedule();
    const ticket = group.promise.then(() => entries);
    ticket.entries = entries;
    return ticket;
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
    let file;
    try {
      if (group.ready.length > 0) await Promise.all(group.ready);
      if (this.#journaled) {
        file = this.#journal ??= this.#journalName(first);
        await this.#fsi.append(this.#openPath, file, `${fileOf(entries)}\n`);
      } else {
        file = `${pad(first)}.json`;
        await this.#fsi.write(this.#openPath, file, fileOf(entries));
      }
    } catch (error) {
      // What a failed append left of its line stays at the end of its
      // journal, and its seqs go to the next group: that one begins a new
      // journal, which a reopen reads first.
      this.#journal = null;
      this.#fail(group, error);
      return;
    }
    // The group is on disk: from here on its callers are answered whatever
    // happens — a throw past this point would leave them, and every write
    // landing behind them in log order, waiting for good.
    try {
      if (started) this.#otel.recordAppend(now() - started);
      const seqs = this.#sealApplied ? [] : null;
      for (const entry of entries) {
        this.#entries.push(entry);
        this.#indexEntry(entry);
        if (seqs !== null) seqs.push(entry.seq);
      }
      this.#open.push({ first, last, file });
      if (seqs !== null) this.#hold(seqs);
      // A roll is what makes one append slow every `rollAfter` groups: its
      // callers wait for it, as they did before groups. A roll that fails
      // (the disk full as a segment is written) seals nothing: the groups
      // stay open, durable, and the next append rolls again.
      if (this.#open.length >= this.#rollAfter) {
        try {
          await this.#roll();
        } catch (error) {
          this.#rollFailures++;
          this.#log?.error?.({ event: 'log.roll.failed', err: error, open: this.#open.length });
        }
      }
    } catch (error) {
      this.#log?.error?.({ event: 'internal.error', name: 'log', err: error });
    }
    group.resolve();
  }

  // A group that did not reach the disk, and the one gathered behind it
  // (its seqs follow): their callers told, the counter, the vector and the
  // heads put back to before the first of them, so the seqs are handed out
  // again and the next op of a stream chains to what is durable.
  #fail(group, error) {
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
    if (this.#open.length === 0) return;
    const sealedFrom = this.#segments.length > 0 ? this.#segments[this.#segments.length - 1].to + 1 : this.#floor;
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
    const name = segmentName(from);
    await this.#fsi.write(this.#path, name, fileOf(entries), ATOMIC);
    this.#segments.push({ name, from, to: entries[entries.length - 1].seq, count: entries.length });
    const dropped = await this.#compact();
    await this.#writeIndex();
    // A group is applied whole, so the cut never falls inside one: a group
    // is sealed with the segment or kept, and a file goes once every group
    // it holds is sealed. A journal is begun again at every roll, so it
    // stays finite and does go.
    const to = entries[entries.length - 1].seq;
    const kept = [];
    const sealed = new Set();
    const keptFiles = new Set();
    for (const group of this.#open) {
      if (group.last <= to) sealed.add(group.file);
      else {
        kept.push(group);
        keptFiles.add(group.file);
      }
    }
    this.#open = kept;
    this.#journal = null;
    for (const file of sealed) if (!keptFiles.has(file)) await this.#fsi.remove(this.#openPath, file);
    if (this.#onRoll !== null) {
      try {
        this.#onRoll({ sealed: entries.length, dropped, floor: this.#floor, segments: this.#segments.length });
      } catch (error) {
        this.#log?.warn?.({ event: 'listener.error', name: 'log', err: error });
      }
    }
    return { dropped };
  }

  // Drops whole sealed segments from the front while the log exceeds its
  // retention; the floor moves up and `vector` keeps what was dropped.
  // Returns how many segments went.
  async #compact() {
    const { ops, days } = this.#retention;
    const cutoff = days ? Date.now() - days * 86_400_000 : null;
    let dropped = 0;
    while (this.#segments.length > 1) {
      const oldest = this.#segments[0];
      const overOps = ops ? this.#entries.length - oldest.count >= ops : false;
      const lastTs = this.#entryAt(oldest.to)?.op?.ts ?? Infinity;
      const overAge = cutoff !== null && lastTs < cutoff;
      const tooMany = ops ? this.#entries.length > ops : false;
      if (!(tooMany && overOps) && !overAge) break;
      if (this.#keeps(oldest.to)) break;
      this.#segments.shift();
      for (const entry of this.#entries) {
        if (entry.seq > oldest.to) break;
        if (entry.held !== undefined) this.#droppedHeld++;
        if (typeof entry.op?.ts === 'number' && entry.op.ts > this.#droppedTs) this.#droppedTs = entry.op.ts;
        this.#unindexEntry(entry);
        this.#unprint(entry);
      }
      this.#entries = this.#entries.slice(this.#lowerBound(oldest.to + 1));
      this.#floor = oldest.to + 1;
      await this.#fsi.remove(this.#path, oldest.name);
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
      segments: this.#segments,
      droppedHeld: this.#droppedHeld,
      latestTs: this.#latestTs,
      droppedTs: this.#droppedTs,
    };
    await this.#fsi.write(this.#path, INDEX, JSON.stringify(index), ATOMIC);
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
    return this.#corrupt;
  }

  /** Rolls that failed since the open (`log.roll.failed`): the groups they would have sealed stay open and durable. */
  get rollFailures() {
    return this.#rollFailures;
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
    {
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
      const sorted = taken.sort((a, b) => a - b);
      for (const segment of this.#segments) {
        if (!anyWithin(sorted, segment.from, segment.to)) continue;
        const entries = this.#entries.slice(this.#lowerBound(segment.from), this.#lowerBound(segment.to + 1));
        await this.#fsi.write(this.#path, segment.name, fileOf(entries), ATOMIC);
      }
      // An open file is rewritten whole: a journal a line per group it holds
      // (a torn last line goes with the rewrite), a file of its own its group.
      // A journal is never rewritten in place — a write cut short there would
      // read back as a torn last line and take acknowledged groups with it
      // (their seqs then handed out again): the copy goes under a new name,
      // which a reopen reads first, and the old journal is removed after it.
      // Cut short between the two, both are there and the newer shadows the
      // older seq by seq; cut short inside the copy, its torn last line is
      // left out and the old journal still has that group.
      const sealedTo = this.#sealedTo;
      const byFile = new Map();
      for (const group of this.#open) {
        let groups = byFile.get(group.file);
        if (groups === undefined) byFile.set(group.file, (groups = []));
        groups.push(group);
      }
      for (const [file, groups] of byFile) {
        let touched = false;
        for (let i = 0; !touched && i < groups.length; i++) {
          touched = anyWithin(sorted, groups[i].first, groups[i].last);
        }
        if (!touched) continue;
        const journal = file.endsWith(JOURNAL);
        let content = '';
        for (const group of groups) {
          const from = Math.max(group.first, sealedTo + 1);
          const text = fileOf(this.#entries.slice(this.#lowerBound(from), this.#lowerBound(group.last + 1)));
          if (!journal) {
            content = text;
            break;
          }
          content += `${text}\n`;
        }
        if (!journal) {
          await this.#fsi.write(this.#openPath, file, content);
          continue;
        }
        const copy = this.#journalName(groups[0].first);
        await this.#fsi.write(this.#openPath, copy, content);
        for (const group of groups) group.file = copy;
        if (this.#journal === file) this.#journal = null;
        await this.#fsi.remove(this.#openPath, file);
      }
      this.#torn.delete(id);
      return fresh;
    }
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

  /** Every retained entry, oldest first, without a copy — for a selection over the whole log (src/outbound.js). */
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
};
