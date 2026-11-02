'use strict';

// The files engine's medium of the op log: what src/log.js writes its groups,
// segments and index through where the database is a directory. The log
// itself — seqs, the vector, the streams, what is applied, what retention
// keeps — is `OpLog`'s and knows no file; this is every file name.
//
// Layout under `<path>` (`<db>/log`), over fsi (whole-file read/write, no rename):
//   open/<seq>-<n>.jsonl  a JOURNAL, where the backend can append: one line
//                       per GROUP of appends — every append that came while
//                       the line before it was being written — named by the
//                       first seq it holds and a token unique to this open;
//                       begun again at every roll, removed once every group
//                       in it is sealed, rewritten only by a scrub. A torn
//                       write can only damage its last line, whose group was
//                       never announced to anyone
//   open/<seq>.json     the same group as a file of its own, where the
//                       backend cannot append
//   seg-<from>.json     sealed segments: the open files rolled together once
//                       enough of them accumulate
//   corrupt/<name>      an open group file that read whole but failed its
//                       checksum: kept aside as the evidence, its entries
//                       lost from this node (`droppedTs`, `corrupt`)
//   index.json          { epoch, floor, next, vector, heads, droppedHeld,
//                       latestTs, droppedTs } — a summary; the files are the
//                       source of truth and anything the index lacks is
//                       rebuilt from a directory listing
//
// The contract a log medium keeps (what a native engine's log store keeps
// in rows instead of files): `load()` → the index, every retained entry
// sorted and unique, the open groups with the seqs a segment does not hold
// yet, the floor, and what the open could not read; `append(entries,
// headers, { first, last, sealedTo, onFail })` one durable group; `seal`,
// `sealed`, `segments`, `drop` for the roll and the compaction; `saveIndex`;
// `scrub` for a purge; `sealedTo`, `open`, `health`, `corrupt`. Requires
// crc32.js, header.js and errors.js only.

const { crc32 } = require('../crc32.js');
const { SyncomError } = require('../errors.js');
const { payloadOf, headerText, restOf, opOf } = require('../header.js');

const OPEN = 'open';
const CORRUPT = 'corrupt';
const JOURNAL = '.jsonl';
const INDEX = 'index.json';

const pad = (n) => String(n).padStart(10, '0');
const segmentName = (from) => `seg-${pad(from)}.json`;

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// An entry as a log file holds it: `[seq, fp, header, payload, rest,
// flags]` — the op's header as src/header.js writes it (the text its
// fingerprint hashed: handed in where the writer has it, made here where it
// has not), its payload, the rest of the op (a signature, a nonce) and the
// entry's flags (`skipped`, `held`, `scrubbed`), the last two left out when
// there is nothing in them. An absent fingerprint is null.
const entryText = (entry, header) => {
  const { op } = entry;
  const payload = payloadOf(op);
  const rest = restOf(op);
  let flags = null;
  if (entry.skipped === true) (flags ??= {}).skipped = true;
  if (entry.held !== undefined) (flags ??= {}).held = entry.held;
  if (entry.scrubbed === true) (flags ??= {}).scrubbed = true;
  const fp = entry.fp === undefined ? 'null' : JSON.stringify(entry.fp);
  let text = `[${entry.seq},${fp},${header ?? headerText(op)},${payload === null ? 'null' : JSON.stringify(payload)}`;
  if (rest !== null || flags !== null) text += `,${rest === null ? 'null' : JSON.stringify(rest)}`;
  if (flags !== null) text += `,${JSON.stringify(flags)}`;
  return `${text}]`;
};

// An entry read back, or null for a value of another shape.
const entryOf = (value) => {
  if (!Array.isArray(value) || value.length < 4 || value.length > 6 || !Number.isSafeInteger(value[0])) return null;
  const op = opOf(value[2], value[3], value[4] ?? null);
  if (op === null) return null;
  const entry = { seq: value[0], op };
  if (typeof value[1] === 'string') entry.fp = value[1];
  const flags = value[5];
  if (flags !== undefined && flags !== null) {
    if (flags.skipped === true) entry.skipped = true;
    if (flags.held !== undefined) entry.held = flags.held;
    if (flags.scrubbed === true) entry.scrubbed = true;
  }
  return entry;
};

// A log file — a journal line, an open group's file, a segment — is its
// entries and the CRC-32 of their text: `{"e":[…],"c":"<8 hex>"}`, the
// checksum last, at a place known from the end, so it is checked BEFORE the
// entries are parsed. A torn or altered file is told from a whole one at
// open; a file without its checksum is not whole. `headers` (beside
// `entries`) are the header texts a writer made already.
const fileOf = (entries, headers = null) => {
  let text = '[';
  for (let i = 0; i < entries.length; i++) {
    if (i > 0) text += ',';
    text += entryText(entries[i], headers === null ? undefined : headers[i]);
  }
  text += ']';
  return `{"e":${text},"c":"${crc32(text)}"}`;
};
const FILE_HEAD = '{"e":';
// `,"c":"` + 8 hex digits + `"}`.
const FILE_TAIL = 16;
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

// index.json as `saveIndex` writes it, or null: an index with a field
// missing or of another shape is no index of this log's.
const indexOf = (index) => {
  if (index === null || typeof index !== 'object' || Array.isArray(index)) return null;
  if (typeof index.epoch !== 'string' || !Number.isSafeInteger(index.floor) || index.floor < 1) return null;
  if (!isMap(index.vector) || !isMap(index.heads)) return null;
  if (!Number.isSafeInteger(index.droppedHeld) || index.droppedHeld < 0) return null;
  if (typeof index.latestTs !== 'number' || typeof index.droppedTs !== 'number') return null;
  return index;
};
const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const MALFORMED = Object.freeze({ entries: null, reason: 'malformed' });
const ALTERED = Object.freeze({ entries: null, reason: 'checksum' });
// A text that is not a whole file: altered when it is shaped like one — a
// JSON object, braces at both ends (a file without its checksum is not whole)
// — torn on the way down otherwise. Told by the shape alone: nothing of a
// text that failed its check is parsed.
const unwhole = (text) =>
  typeof text === 'string' && text.length > 1 && text[0] === '{' && text[text.length - 1] === '}' ? ALTERED : MALFORMED;
// A segment's trailer is `{"lines":<n>,"to":<seq>,"c":"<8 hex>"}`: short. A last line longer is no trailer.
const TRAILER_MAX = 96;
const readFile = (text) => {
  if (typeof text !== 'string' || text.length < FILE_HEAD.length + FILE_TAIL || !text.startsWith(FILE_HEAD)) {
    return unwhole(text);
  }
  const tail = text.length - FILE_TAIL;
  if (!text.startsWith(',"c":"', tail) || !text.endsWith('"}')) return unwhole(text);
  const body = text.slice(FILE_HEAD.length, tail);
  if (crc32(body) !== text.slice(tail + 6, tail + 14)) return ALTERED;
  const parsed = parseJson(body);
  if (!Array.isArray(parsed)) return MALFORMED;
  const entries = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = entryOf(parsed[i]);
    if (entry === null) return MALFORMED;
    entries.push(entry);
  }
  return { entries, reason: null };
};

// A log file's checksum, read from its text: the eight hex digits before `"}`.
const checksumOf = (line) => line.slice(line.length - 10, line.length - 2);

// A sealed segment: the lines of the groups it seals, as they were journaled
// — each a log file of its own, checked on its own — and a trailer
// `{"lines":<n>,"to":<last seq>,"c":"<crc32 of the lines' checksums>"}`, so a
// line gone, added, moved or cut short is told as well as one altered. Whole
// or nothing: a line or the trailer that fails makes the segment unreadable.
const segmentOf = (lines, to) => {
  let text = '';
  let sums = '';
  for (let i = 0; i < lines.length; i++) {
    text += `${lines[i]}\n`;
    sums += checksumOf(lines[i]);
  }
  return `${text}{"lines":${lines.length},"to":${to},"c":"${crc32(sums)}"}`;
};

const readSegment = (text) => {
  if (typeof text !== 'string') return MALFORMED;
  const cut = text.lastIndexOf('\n');
  // One line alone is no segment (told by its shape); a last line too long to be a trailer is a segment
  // whose trailer is gone — altered. Nothing of either is parsed.
  if (cut === -1) return unwhole(text);
  if (text.length - cut - 1 > TRAILER_MAX) return ALTERED;
  const trailer = parseJson(text.slice(cut + 1));
  if (trailer === null) return MALFORMED;
  const { lines: count, to, c } = trailer;
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(to) || typeof c !== 'string') return ALTERED;
  const lines = text.slice(0, cut).split('\n');
  if (lines.length !== count) return ALTERED;
  let sums = '';
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const read = readFile(lines[i]);
    if (read.entries === null) return ALTERED;
    sums += checksumOf(lines[i]);
    for (let k = 0; k < read.entries.length; k++) entries.push(read.entries[k]);
  }
  if (crc32(sums) !== c || entries.length === 0 || entries[entries.length - 1].seq !== to) return ALTERED;
  return { entries, reason: null };
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

const byFirst = (a, b) => a.first - b.first;

/**
 * The log's medium over an fsi, rooted at `path` (`<db>/log`). One per
 * `OpLog`; a database's files engine makes it as `db.log`.
 */
const createJournalStore = (fsi, path, { logger = null } = {}) => {
  const openPath = `${path}/${OPEN}`;
  const corruptPath = `${path}/${CORRUPT}`;
  const journaled = typeof fsi.append === 'function';
  // Where the backend can append, the groups go as lines of a journal: the
  // one being written, this open's token for its names, how many it began.
  let journal = null;
  const session = Date.now().toString(36);
  let journals = 0;
  // The groups the open files hold, in seq order: `{ first, last, file, line }`
  // — each with the line it was journaled as, until sealed.
  let groups = [];
  // The sealed segments, in seq order: `{ name, from, to, count }`.
  const segments = [];
  // Files whose checksum did not match at open: altered or torn on disk.
  let corrupt = 0;
  let lost = false;
  // Journal lines left out at open as torn (their append never answered).
  let tornLines = 0;

  // The newest seq a segment holds, or null when none does.
  const sealedTo = () => (segments.length > 0 ? segments[segments.length - 1].to : null);

  // A journal's name: the first seq it holds, then this open's token and how
  // many journals it has begun — never a name a failed group's line is in.
  const journalName = (first) => `${pad(first)}-${session}${(++journals).toString(36).padStart(4, '0')}${JOURNAL}`;

  // The entries at `seqs` as they are now — a scrub took their payloads — by
  // seq: what a store is handed for certain. The log answers a whole range
  // where it holds one; a proxy (src/engines/remote.js) sends the scrubbed
  // entries alone, so a file is never rebuilt from less than it held.
  const replacementsOf = (seqs, entriesBetween) => {
    const bySeq = new Map();
    for (let i = 0; i < seqs.length; i++) {
      const held = entriesBetween(seqs[i], seqs[i]);
      if (held.length === 1) bySeq.set(seqs[i], held[0]);
    }
    return bySeq;
  };
  const NOTHING = new Map();

  // A group's line written again — what a scrub or a rewritten journal
  // holds of it — and kept as the group's: the line a segment seals is never
  // one a purge took a payload out of. A group a segment holds in part keeps
  // no line (its segment is made from the entries). The entries come from the
  // log where it answers the whole range, else from the line itself with
  // the scrubbed ones swapped; null where neither is whole — nothing of the
  // group is written then.
  const lineOf = (group, sealed, entriesBetween, replacements) => {
    const from = Math.max(group.first, sealed + 1);
    const expected = group.last - from + 1;
    const full = entriesBetween(from, group.last);
    if (full.length === expected) {
      const line = fileOf(full);
      group.line = from === group.first ? line : null;
      return line;
    }
    if (group.line === null) return null;
    const read = readFile(group.line);
    if (read.entries === null) return null;
    const kept = [];
    let touched = false;
    for (let i = 0; i < read.entries.length; i++) {
      const entry = read.entries[i];
      if (entry.seq < from) continue;
      const next = replacements.get(entry.seq);
      if (next !== undefined) touched = true;
      kept.push(next ?? entry);
    }
    if (kept.length !== expected) return null;
    const line = !touched && from === group.first ? group.line : fileOf(kept);
    group.line = from === group.first ? line : null;
    return line;
  };

  // A journal written again under a new name with the groups of it still
  // open, then removed: never rewritten in place (see `scrub`). A group
  // whose line cannot be made whole keeps the journal as it is, said out loud.
  const rewriteJournal = async (file, sealed, entriesBetween, replacements = NOTHING) => {
    const held = [];
    for (let i = 0; i < groups.length; i++) if (groups[i].file === file) held.push(groups[i]);
    if (held.length > 0) {
      let content = '';
      for (let i = 0; i < held.length; i++) {
        const line = lineOf(held[i], sealed, entriesBetween, replacements);
        if (line === null) {
          logger?.warn?.({ event: 'log.journal.unrewritten', file, first: held[i].first, reason: 'partial' });
          return false;
        }
        content += `${line}\n`;
      }
      const copy = journalName(held[0].first);
      await fsi.write(openPath, copy, content);
      for (let i = 0; i < held.length; i++) held[i].file = copy;
      if (journal === file) journal = null;
    }
    await fsi.remove(openPath, file);
    return true;
  };

  // The lines a segment of `entries` (seqs `from`..`to`) is made of: the
  // open groups' lines as they were journaled, nothing stringified again —
  // or the entries as one line where a group's line is not there whole (one
  // read back across a roll a crash cut short) or the groups do not cover
  // every entry.
  const linesOf = (entries, from, to) => {
    const lines = [];
    let covered = 0;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (group.last < from || group.first > to) continue;
      if (group.line === null || group.first < from || group.last > to) return [fileOf(entries)];
      lines.push(group.line);
      covered += group.last - group.first + 1;
    }
    return covered === entries.length ? lines : [fileOf(entries)];
  };

  // ---- the open: segments, then the open files, newest first -----------

  // What a load gathers: the entries merged in, deduplicated by seq (a crash
  // mid-roll leaves the same batch both sealed and open; a group whose
  // append failed may have left its line, shadowed by the group that took
  // its seqs), the floor as the index or the first entry says, the seq
  // sealed up to.
  const gathering = (indexed, floor) => {
    const state = { indexed, floor, sealed: 0, entries: [], seen: new Set(), adopt: null };
    state.adopt = (read) => {
      for (let i = 0; i < read.length; i++) {
        const entry = read[i];
        if (!entry || !Number.isInteger(entry.seq) || state.seen.has(entry.seq)) continue;
        state.seen.add(entry.seq);
        state.entries.push(entry);
      }
    };
    return state;
  };

  // The sealed segments are what the directory lists (`seg-<from>.json`),
  // each read whole: the index names none of them. A segment's start not
  // meeting the floor or the end of the one before is a file this log
  // should hold and does not (`log.segment.missing`); one wholly below the
  // floor was compacted, its removal cut short.
  const loadSegments = async (state) => {
    const { indexed, adopt } = state;
    const listed = [];
    const names = await fsi.list(path);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (!name.startsWith('seg-')) continue;
      const from = Number(name.slice(4, -5));
      if (Number.isInteger(from)) listed.push({ name, from, to: from, count: 0 });
    }
    listed.sort((a, b) => a.from - b.from);
    // Where the next segment should start: unknown past one that did not read.
    let next = indexed ? state.floor : null;
    for (let i = 0; i < listed.length; i++) {
      const segment = listed[i];
      const text = await readOrNull(fsi, path, segment.name);
      const read = readSegment(text);
      if (read.entries === null) {
        // Not read whole, whichever way — a checksum that did not match, a file cut short: counted as corrupt.
        logger?.error?.({ event: 'log.segment.unreadable', segment: segment.name, reason: read.reason });
        lost = true;
        corrupt++;
        segments.push(segment);
        next = null;
        continue;
      }
      if (read.entries.length > 0) {
        segment.to = read.entries[read.entries.length - 1].seq;
        segment.count = read.entries.length;
      }
      if (indexed && segment.to < state.floor) {
        await fsi.remove(path, segment.name);
        continue;
      }
      if (next !== null && segment.from > next) {
        logger?.error?.({ event: 'log.segment.missing', from: next, to: segment.from - 1 });
        lost = true;
      }
      next = segment.to + 1;
      adopt(read.entries);
      segments.push(segment);
    }
  };

  // The open files, newest first: a group whose write failed may have left
  // its line at the end of a journal, and the group that took its seqs back
  // went to a newer file — `adopt` keeps the first copy of a seq it sees.
  // Answers the journals a newer one shadows a line of.
  const loadOpen = async (state) => {
    const { seen, adopt } = state;
    // A group read back from an open file: adopted and kept with its file;
    // the seqs a segment does not have yet are the owner's to hold until its
    // records are written.
    const opened = (file, read, line) => {
      adopt(read);
      let first = Infinity;
      let last = -Infinity;
      const unsealed = [];
      for (let i = 0; i < read.length; i++) {
        const seq = read[i].seq;
        if (!Number.isInteger(seq)) continue;
        if (seq > state.sealed) unsealed.push(seq);
        if (seq < first) first = seq;
        if (seq > last) last = seq;
      }
      if (first === Infinity) return;
      // Its line, for the segment that seals it — where the line is the group's
      // and none of it is sealed already (a roll a crash cut short).
      const whole = first > state.sealed && last - first + 1 === read.length;
      groups.push({ first, last, file, line: whole ? line : null, unsealed });
    };
    // Whether a group read from a journal has a seq past the segments that a
    // newer journal gave already (a seq a segment holds is a roll cut short,
    // not a shadow).
    const shadowed = (read) => {
      for (let i = 0; i < read.length; i++) {
        const seq = read[i]?.seq;
        if (Number.isInteger(seq) && seq > state.sealed && seen.has(seq)) return true;
      }
      return false;
    };
    // A journal read back, line by line. Its last line may be torn — its group
    // was never acknowledged, and its seqs were handed out again — and is left
    // out; a line before it that does not read was acknowledged once and is
    // lost now. A line is a group, whole or not at all: one with a seq a
    // newer journal holds already is shadowed and none of it comes back.
    const loadJournal = (name, text) => {
      const lines = text.split('\n');
      let end = lines.length;
      while (end > 0 && lines[end - 1] === '') end--;
      let stale = false;
      for (let i = 0; i < end; i++) {
        if (lines[i] === '') continue;
        const read = readFile(lines[i]);
        if (read.entries !== null) {
          if (shadowed(read.entries)) stale = true;
          else opened(name, read.entries, lines[i]);
          continue;
        }
        // A last line cut short is a write a crash cut: torn, expected, left out. A line altered (its checksum
        // does not match) or one cut short inside is a loss: corrupt, said out loud.
        if (read.reason === 'malformed' && i === end - 1) {
          logger?.info?.({ event: 'log.open.torn', file: name, reason: read.reason });
          tornLines++;
        } else {
          logger?.error?.({ event: 'log.open.unreadable', file: name, reason: read.reason });
          lost = true;
          corrupt++;
        }
      }
      return stale;
    };

    const open = await fsi.list(openPath);
    open.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    const stale = new Set();
    for (let i = 0; i < open.length; i++) {
      const name = open[i];
      const text = await readOrNull(fsi, openPath, name);
      // Gone since the listing: nothing to read.
      if (text === null) continue;
      if (name.endsWith(JOURNAL)) {
        if (loadJournal(name, text)) stale.add(name);
        continue;
      }
      const read = readFile(text);
      if (read.entries === null) {
        if (read.reason === 'checksum') {
          // Whole once — its hash is there — and changed since: answered
          // entries, lost here. Kept aside as the evidence, never deleted.
          logger?.error?.({
            event: 'log.open.unreadable',
            file: name,
            reason: read.reason,
            kept: `${CORRUPT}/${name}`,
          });
          corrupt++;
          lost = true;
          await fsi.write(corruptPath, name, text);
        } else {
          // Torn on the way down: its write never finished, so its batch was
          // never announced — dropped.
          logger?.info?.({ event: 'log.open.torn', file: name, reason: read.reason });
          tornLines++;
        }
        await fsi.remove(openPath, name);
        continue;
      }
      opened(name, read.entries, text);
    }
    return stale;
  };

  // A shadowed line is a copy left behind — by a scrub or a group's failed
  // append cut short — and may hold a payload a scrub took away: its journal
  // goes, rewritten with the groups it still holds, from the entries loaded.
  const rewriteStale = async (state, stale) => {
    const { entries } = state;
    const entriesBetween = (from, to) => {
      const slice = [];
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].seq < from) continue;
        if (entries[i].seq > to) break;
        slice.push(entries[i]);
      }
      return slice;
    };
    for (const name of stale) await rewriteJournal(name, state.sealed, entriesBetween);
  };

  const load = async () => {
    const hasIndex = await fsi.exists(path, INDEX);
    const index = hasIndex ? indexOf(parseJson(await fsi.read(path, INDEX))) : null;
    const indexed = index !== null;
    const state = gathering(indexed, indexed ? index.floor : 1);
    await loadSegments(state);
    // The floor is durable in the index; without one that reads (none, or
    // one that is not this log's) everything on disk is retained from its
    // first entry.
    state.entries.sort((a, b) => a.seq - b.seq);
    if (!indexed && state.entries.length > 0) state.floor = state.entries[0].seq;
    state.sealed = sealedTo() ?? state.floor - 1;
    const stale = await loadOpen(state);
    // The groups in seq order, like the appends that made them; the entries too.
    groups.sort(byFirst);
    state.entries.sort((a, b) => a.seq - b.seq);
    if (stale.size > 0) await rewriteStale(state, stale);
    const held = [];
    for (let i = 0; i < groups.length; i++) {
      held.push({ first: groups[i].first, last: groups[i].last, unsealed: groups[i].unsealed });
    }
    return { index, hasIndex, entries: state.entries, groups: held, floor: state.floor, lost };
  };

  return Object.freeze({
    journaled,
    load,
    /** The newest seq a segment holds, or null when none does. */
    get sealedTo() {
      return sealedTo();
    },
    /** How many groups the open files hold. */
    get open() {
      return groups.length;
    },
    /** The sealed segments, oldest first: `{ from, to, count }` — what compaction drops whole. */
    get segments() {
      return segments;
    },
    get corrupt() {
      return corrupt;
    },
    /** What the open files are: whether the backend appends, how many groups are open, the lines left out as torn, whether an open lost entries. */
    get health() {
      return { journaled, open: groups.length, torn: tornLines, lost };
    },
    /**
     * One group, durable: a line of the journal where the backend appends, a
     * file of its own otherwise. Answers whether it landed. A group that did
     * not: `onFail(error)` is told at once — before anything else is awaited —
     * and what the failed append left of its line (the whole line, where the
     * write went down and the sync did not) is taken out of its journal
     * (written again without it, under a new name), so a reopen with nothing
     * after it never brings the group back; where the rewrite fails too, a
     * later group's line shadows it.
     */
    async append(entries, headers, { first, last, sealedTo: sealed, onFail, entriesBetween }) {
      let file;
      let line;
      try {
        line = fileOf(entries, headers);
        if (journaled) {
          file = journal ??= journalName(first);
          await fsi.append(openPath, file, `${line}\n`);
        } else {
          file = `${pad(first)}.json`;
          await fsi.write(openPath, file, line);
        }
      } catch (error) {
        // Its seqs go to the next group, which begins a new journal that a reopen reads first.
        journal = null;
        onFail(error);
        if (journaled && file !== undefined) {
          try {
            await rewriteJournal(file, sealed, entriesBetween);
          } catch (thrown) {
            logger?.warn?.({ event: 'log.journal.unrewritten', file, err: thrown });
          }
        }
        return false;
      }
      // The line stays with the group: the segment that seals it is these lines.
      groups.push({ first, last, file, line, unsealed: null });
      return true;
    },
    /** The segment of `entries` (seqs `from`..`to`), whole or not at all; the open files stay until `sealed(to)`. */
    async seal(entries, from, to) {
      const name = segmentName(from);
      await fsi.write(path, name, segmentOf(linesOf(entries, from, to), to), ATOMIC);
      segments.push({ name, from, to, count: entries.length });
    },
    /**
     * The open files whose groups a segment up to `to` holds, removed. A
     * group is applied whole, so the cut never falls inside one: a group is
     * sealed with the segment or kept, and a file goes once every group it
     * holds is sealed. A journal is begun again at every roll, so it stays
     * finite and does go.
     */
    async sealed(to) {
      const kept = [];
      const done = new Set();
      const keptFiles = new Set();
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        if (group.last <= to) done.add(group.file);
        else {
          kept.push(group);
          keptFiles.add(group.file);
        }
      }
      groups = kept;
      journal = null;
      for (const file of done) if (!keptFiles.has(file)) await fsi.remove(openPath, file);
    },
    /** The oldest segment — the first of `segments` — removed, compacted away. */
    async drop(segment) {
      if (segments[0] !== segment) throw new TypeError('drop(segment): the oldest segment goes first');
      segments.shift();
      await fsi.remove(path, segment.name);
    },
    saveIndex: (index) => fsi.write(path, INDEX, JSON.stringify(index), ATOMIC),
    /**
     * The files holding the entries at `seqs` (ascending) written again as
     * they are now — a scrub took their payloads: the segments whole, an open
     * file whole (a journal a line per group it holds, never in place: the
     * copy goes under a new name, which a reopen reads first, and the old
     * journal is removed after it), and the evidence copies under corrupt/
     * that name `id` removed whole — a purge outranks evidence.
     */
    async scrub(seqs, { id, ids = id === null || id === undefined ? [] : [id], sealedTo: sealed, entriesBetween }) {
      const replacements = replacementsOf(seqs, entriesBetween);
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        if (!anyWithin(seqs, segment.from, segment.to)) continue;
        let entries = entriesBetween(segment.from, segment.to);
        if (entries.length !== segment.count) {
          // Handed the scrubbed entries alone: the segment's own, read back, with those swapped.
          const read = readSegment(await readOrNull(fsi, path, segment.name));
          if (read.entries === null) {
            logger?.warn?.({ event: 'log.segment.unscrubbed', file: segment.name, id, reason: read.reason });
            continue;
          }
          entries = [];
          for (let k = 0; k < read.entries.length; k++) {
            entries.push(replacements.get(read.entries[k].seq) ?? read.entries[k]);
          }
        }
        await fsi.write(path, segment.name, segmentOf([fileOf(entries)], segment.to), ATOMIC);
      }
      const byFile = new Map();
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        let held = byFile.get(group.file);
        if (held === undefined) byFile.set(group.file, (held = []));
        held.push(group);
      }
      for (const [file, held] of byFile) {
        let touched = false;
        for (let i = 0; !touched && i < held.length; i++) touched = anyWithin(seqs, held[i].first, held[i].last);
        if (!touched) continue;
        if (file.endsWith(JOURNAL)) {
          await rewriteJournal(file, sealed, entriesBetween, replacements);
          continue;
        }
        const text = lineOf(held[0], sealed, entriesBetween, replacements);
        if (text === null) {
          logger?.warn?.({ event: 'log.journal.unrewritten', file, first: held[0].first, reason: 'partial' });
          continue;
        }
        await fsi.write(openPath, file, text);
      }
      let kept = null;
      try {
        kept = await fsi.list(corruptPath);
      } catch {
        kept = null;
      }
      if (kept !== null && ids.length > 0) {
        const needles = [];
        for (let i = 0; i < ids.length; i++) needles.push(`"${ids[i]}"`);
        for (let i = 0; i < kept.length; i++) {
          const name = kept[i];
          const text = await readOrNull(fsi, corruptPath, name);
          if (typeof text !== 'string') continue;
          let named = null;
          for (let k = 0; named === null && k < needles.length; k++) if (text.includes(needles[k])) named = ids[k];
          if (named === null) continue;
          await fsi.remove(corruptPath, name);
          logger?.info?.({ event: 'log.corrupt.scrubbed', file: name, id: named });
        }
      }
    },
  });
};

module.exports = { createJournalStore, fileOf, readFile, segmentOf, readSegment, indexOf, pad, isAbsent };
