'use strict';

// The persisted operation log: every op this node applied — its own and the
// ones it accepted from peers — in the order they landed here. Two things read
// it: a subscriber resuming from an event id (`since`), and the node itself on
// reopen (the tail is replayed onto the records, which is what makes a crash
// between "logged" and "written to data/" recoverable).
//
// Layout under `<path>/log/`, over fsi (whole-file read/write, no rename):
//   open/<seq>.json     one file per append batch, never rewritten — a torn
//                       write can only damage the newest batch, which has not
//                       been announced to anyone yet
//   seg-<from>.json     sealed segments: the open files rolled together once
//                       enough of them accumulate
//   index.json          { epoch, floor, next, vector, segments } — a summary;
//                       the files are the source of truth and anything the
//                       index lacks is rebuilt from a directory listing
//
// Ids are `<epoch>.<seq>`. The epoch is minted once, when the log is created,
// so a subscriber holding an id from a previous incarnation (a wiped or
// restored data directory) is told to bootstrap instead of being fed a numeric
// coincidence. `floor` is the lowest seq still retained: below it, and for an
// unknown epoch, `since()` answers null — "I cannot resume you, take a
// snapshot" — never a silent gap.

const defaultFsi = require('./fsi.js');
const { formatEventId, parseEventId, vectorAdvance } = require('./vector.js');
const { createTelemetry, traced, now } = require('./telemetry.js');

const OPEN = 'open';
const INDEX = 'index.json';
const DEFAULT_ROLL_AFTER = 64;
const DEFAULT_RETENTION_OPS = 10_000;

const pad = (n) => String(n).padStart(10, '0');
const segmentName = (from) => `seg-${pad(from)}.json`;

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

class OpLog {
  #path;
  #openPath;
  #entries = [];
  #openFiles = [];
  #segments = [];
  #next = 1;
  #latestTs = 0;
  #floor = 1;
  #epoch = null;
  #vector = {};
  #rollAfter;
  #retention;
  #log;
  #otel;
  #fsi;
  #droppedHeld = 0;
  #torn = new Set();
  #writes = Promise.resolve();
  // Batches appended whose records may not be written yet: first seq → last
  // seq. Only kept under `sealApplied`; a roll stops short of the oldest.
  #pending = new Map();
  #sealApplied;
  // Record id → the seqs of its entries: what a scrub rewrites, found
  // without a walk over everything retained.
  #byId = new Map();

  constructor(basePath, options = {}) {
    this.#path = `${basePath}/log`;
    this.#openPath = `${this.#path}/${OPEN}`;
    this.#fsi = options.fsi ?? defaultFsi;
    this.#rollAfter = options.rollAfter ?? DEFAULT_ROLL_AFTER;
    this.#retention = { ops: DEFAULT_RETENTION_OPS, ...options.retention };
    this.#log = options.logger ?? null;
    this.#otel = createTelemetry(options.telemetry);
    // The storage asks for `sealApplied`: a roll then seals only the batches
    // it has marked applied (see `applied`), so an op whose record write
    // failed stays in the open files, replayed at every reopen until it
    // lands. A log on its own seals everything, as before.
    this.#sealApplied = options.sealApplied === true;
    return this.#init();
  }

  async #init() {
    const hasIndex = await this.#fsi.exists(this.#path, INDEX);
    const index = hasIndex ? parseJson(await this.#fsi.read(this.#path, INDEX)) : null;
    if (index) {
      this.#epoch = index.epoch;
      this.#floor = index.floor ?? 1;
      this.#vector = index.vector ?? {};
      this.#segments = Array.isArray(index.segments) ? index.segments : [];
      this.#droppedHeld = Number.isInteger(index.droppedHeld) ? index.droppedHeld : 0;
    } else {
      // No (readable) index: a new incarnation. Existing segments are still
      // picked up below, but their ids belong to an epoch nobody can resume.
      this.#epoch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      this.#segments = [];
    }
    await this.#loadSegments(hasIndex);
    await this.#loadOpen();
    if (!index) await this.#writeIndex();
    return this;
  }

  async #loadSegments(hasIndex) {
    const known = new Set(this.#segments.map((segment) => segment.name));
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
      const text = await this.#fsi.read(this.#path, segment.name).catch(() => null);
      const parsed = text === null ? null : parseJson(text);
      if (!parsed || !Array.isArray(parsed.entries)) {
        this.#log?.warn?.({ event: 'log.segment.unreadable', segment: segment.name });
        continue;
      }
      this.#adopt(parsed.entries);
      if (parsed.entries.length > 0) {
        segment.to = parsed.entries[parsed.entries.length - 1].seq;
        segment.count = parsed.entries.length;
      }
    }
    // The floor is durable in the index; a fresh index means everything on
    // disk is retained from its first entry.
    if (!hasIndex && this.#entries.length > 0) this.#floor = this.#entries[0].seq;
  }

  async #loadOpen() {
    const names = await this.#fsi.list(this.#openPath);
    for (const name of names) {
      const text = await this.#fsi.read(this.#openPath, name).catch(() => null);
      const parsed = text === null ? null : parseJson(text);
      if (!parsed || !Array.isArray(parsed.entries)) {
        // Torn on the way down: the batch was never announced, drop it.
        this.#log?.warn?.({ event: 'log.open.unreadable', file: name });
        await this.#fsi.remove(this.#openPath, name);
        continue;
      }
      this.#adopt(parsed.entries);
      this.#openFiles.push(name);
      // Nothing says these records were written: pending until the owner's
      // replay says so.
      if (this.#sealApplied && parsed.entries.length > 0) {
        const seqs = parsed.entries.map((entry) => entry.seq).filter(Number.isInteger);
        if (seqs.length > 0) this.#pending.set(Math.min(...seqs), Math.max(...seqs));
      }
    }
  }

  // Merges loaded entries in, deduplicating by seq (a crash mid-roll leaves
  // the same batch both sealed and open) and keeping the order by seq.
  #adopt(entries) {
    const seen = new Set(this.#entries.map((entry) => entry.seq));
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
      }
    }
    if (added) this.#entries.sort((a, b) => a.seq - b.seq);
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
    for (const [first, last] of this.#pending) if (first >= from && last <= to) this.#pending.delete(first);
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
   * Appends a batch; resolves once it is on disk. Returns the entries with
   * their seqs, so the caller can announce them by id. Rolls the open files
   * into a segment when enough have accumulated. Ops in `skipped` were
   * accepted but not applied here (a beforeApply hook said no, the record
   * failed its schema, or the op is from a newer schema version — then
   * `held` maps it to that version): they are logged and served like any
   * other, and flagged so a reopen's replay of the tail leaves them alone
   * too; a held one is applied once this node runs its version.
   */
  append(ops, { skipped = null, held = null } = {}) {
    return this.#serialize(async () => {
      if (ops.length === 0) return [];
      const entries = [];
      for (const op of ops) {
        const seq = this.#next++;
        const entry = { seq, op };
        if (skipped?.has(op)) entry.skipped = true;
        if (held?.has(op)) entry.held = held.get(op);
        entries.push(entry);
      }
      const name = `${pad(entries[0].seq)}.json`;
      const started = this.#otel.enabled ? now() : 0;
      await this.#fsi.write(this.#openPath, name, JSON.stringify({ entries }));
      if (started) this.#otel.recordAppend(now() - started);
      for (const entry of entries) {
        this.#entries.push(entry);
        this.#indexEntry(entry);
      }
      for (const op of ops) {
        vectorAdvance(this.#vector, op);
        this.#observe(op);
      }
      this.#openFiles.push(name);
      if (this.#sealApplied) this.#pending.set(entries[0].seq, entries[entries.length - 1].seq);
      if (this.#openFiles.length >= this.#rollAfter) await this.#roll();
      return entries;
    });
  }

  // Sealing: write the segment, then the index, then remove the open files.
  // Any crash in between leaves duplicates, which #adopt tolerates. Under
  // `sealApplied` only the batches marked applied go; a batch is applied
  // whole, so the cut never falls inside an open file.
  async #roll() {
    if (this.#openFiles.length === 0) return;
    const sealedFrom = this.#segments.length > 0 ? this.#segments[this.#segments.length - 1].to + 1 : this.#floor;
    const limit = this.#sealApplied && this.#pending.size > 0 ? Math.min(...this.#pending.keys()) - 1 : Infinity;
    const entries = this.#entries.filter((entry) => entry.seq >= sealedFrom && entry.seq <= limit);
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
    await this.#fsi.write(this.#path, name, JSON.stringify({ entries }));
    this.#segments.push({ name, from, to: entries[entries.length - 1].seq, count: entries.length });
    const dropped = await this.#compact();
    await this.#writeIndex();
    // An open file is named by its first seq and holds one batch: sealed
    // with the segment when that seq is inside it, kept otherwise.
    const to = entries[entries.length - 1].seq;
    const kept = [];
    for (const file of this.#openFiles) {
      if (Number(file.slice(0, -5)) <= to) await this.#fsi.remove(this.#openPath, file);
      else kept.push(file);
    }
    this.#openFiles = kept;
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
      const lastTs = this.#entries.find((entry) => entry.seq === oldest.to)?.op?.ts ?? Infinity;
      const overAge = cutoff !== null && lastTs < cutoff;
      const tooMany = ops ? this.#entries.length > ops : false;
      if (!(tooMany && overOps) && !overAge) break;
      this.#segments.shift();
      for (const entry of this.#entries) {
        if (entry.seq > oldest.to) break;
        if (entry.held !== undefined) this.#droppedHeld++;
        this.#unindexEntry(entry);
      }
      this.#entries = this.#entries.filter((entry) => entry.seq > oldest.to);
      this.#floor = oldest.to + 1;
      await this.#fsi.remove(this.#path, oldest.name);
      dropped++;
    }
    return dropped;
  }

  async #writeIndex() {
    const index = {
      epoch: this.#epoch,
      floor: this.#floor,
      next: this.#next,
      vector: this.#vector,
      segments: this.#segments,
      droppedHeld: this.#droppedHeld,
    };
    await this.#fsi.write(this.#path, INDEX, JSON.stringify(index));
  }

  /** The entries held for a newer schema version, oldest first. */
  held() {
    return this.#entries.filter((entry) => entry.held !== undefined);
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
      for (const key in vector) {
        const seq = vector[key];
        if (Number.isInteger(seq) && (this.#vector[key] ?? 0) < seq) {
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
   * `value` — in memory and in the files that hold them, flagging each
   * `scrubbed`; the op keeps its position, origin, seq and stamp, so the
   * vector and a resuming peer are unaffected (a scrubbed `write` applies
   * as a no-op). Returns how many entries. A file is rewritten in place:
   * a crash in the middle tears it, and a peer resuming through it
   * bootstraps instead — the price of forgetting over a backend with no
   * rename.
   */
  scrub(id) {
    return this.#serialize(async () => {
      // Every entry of the id (from the index, not a walk), for the files to
      // rewrite; the ones still holding a payload, for the count. A rewrite
      // that failed last time left the files behind memory: the id stays
      // marked torn, and the next scrub rewrites them whether or not
      // anything is fresh.
      const seqs = this.#byId.get(id) ?? new Set();
      let fresh = 0;
      for (const seq of seqs) {
        const entry = this.#entryAt(seq);
        if (!entry || entry.scrubbed) continue;
        delete entry.op.data;
        delete entry.op.meta;
        delete entry.op.key;
        delete entry.op.value;
        entry.scrubbed = true;
        fresh++;
      }
      if (fresh === 0 && !this.#torn.has(id)) return 0;
      this.#torn.add(id);
      const holds = (from, to) => [...seqs].some((seq) => seq >= from && seq <= to);
      for (const segment of this.#segments) {
        if (!holds(segment.from, segment.to)) continue;
        const entries = this.#entries.filter((entry) => entry.seq >= segment.from && entry.seq <= segment.to);
        await this.#fsi.write(this.#path, segment.name, JSON.stringify({ entries }));
      }
      // An open file holds the seqs from its name up to the next file's.
      const sealedTo = this.#segments.length > 0 ? this.#segments[this.#segments.length - 1].to : this.#floor - 1;
      const starts = this.#openFiles.map((name) => Number(name.slice(0, -5))).sort((a, b) => a - b);
      for (let i = 0; i < starts.length; i++) {
        const from = starts[i];
        const to = i + 1 < starts.length ? starts[i + 1] - 1 : Infinity;
        if (!holds(from, to)) continue;
        const entries = this.#entries.filter((entry) => entry.seq > sealedTo && entry.seq >= from && entry.seq <= to);
        await this.#fsi.write(this.#openPath, `${pad(from)}.json`, JSON.stringify({ entries }));
      }
      this.#torn.delete(id);
      return fresh;
    });
  }

  /**
   * Everything after `eventId`, oldest first, or `null` when the caller
   * cannot be resumed: an id from another epoch, or one that fell below the
   * floor. No id at all resumes from the very beginning — possible only while
   * nothing has been compacted away.
   */
  since(eventId, { scopes = null, limit = Infinity } = {}) {
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
    let index = this.#lowerBound(after + 1);
    for (; index < this.#entries.length && entries.length < limit; index++) {
      const entry = this.#entries[index];
      // An op without a scope (or scoped '*') is global and reaches every
      // subscriber; a scoped one only those who asked for that scope.
      const scope = entry.op.scope ?? '*';
      if (scopes && scope !== '*' && !scopes.includes('*') && !scopes.includes(scope)) continue;
      entries.push(entry);
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
    const sealedTo = this.#segments.length > 0 ? this.#segments[this.#segments.length - 1].to : this.#floor - 1;
    return this.#entries.filter((entry) => entry.seq > sealedTo);
  }

  /** Seals what can be sealed and writes the index: a reopen after a clean close replays nothing it need not. */
  close() {
    return this.#serialize(async () => {
      await this.#roll();
      await this.#writeIndex();
    });
  }
}

module.exports = { OpLog };
