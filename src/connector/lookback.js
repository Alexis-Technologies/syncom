'use strict';

// A lookback for a pull whose cursor is a timestamp — what the Supabase, MongoDB, Firestore and Appwrite adapters
// share. A pull that resumes after a stamp never sees a document that became visible later with an older one: a
// transaction that committed late, a replica that lagged, a writer whose clock runs behind. Under `lookback` ms a
// pull run starts that far BEFORE its checkpoint instead, and reads on from there:
//
//   - The checkpoint is the adapter's position — the newest stamp pulled through, with its id — and never moves
//     back. While a run is under way it carries `from`, the position the next page reads on after: a page inside
//     the window moves the checkpoint (so the connector's "full pages at one position" guard is never met), a run
//     cut short goes on from there, and the page that comes short carries none — the next run rewinds again.
//   - The page says how many of its documents, the first ones, are at or behind the checkpoint (`reread`): the
//     connector passes over the ones whose state it knows — nothing landed, nothing counted — and judges the rest, a
//     late arrival among them, as any pulled document. The adapter remembers nothing: a run after a restart reads
//     as every other.
//
// The adapter's doors: `parse(checkpoint)` → its position (the cursor's own fields, never `from`) or null,
// `millis(position)` → the stamp in ms (NaN where it does not read: such a cursor is the plain one), `since(ms)` →
// the position after which everything stamped later than `ms` comes, `read(position, limit)` → the rows after it
// in the cursor's order (null: from the start), `positionOf(row)` → its position or null, `documentOf(row)` → the
// document, or null for a row to leave out. Requires argument-errors.js only.

const { ArgumentError } = require('../argument-errors.js');

/** `lookback` as an adapter takes it: a non-negative number of milliseconds (0: none). */
const checkLookback = (adapter, value) => {
  if (!Number.isFinite(value) || value < 0) {
    throw new ArgumentError(`${adapter}(): lookback must be a non-negative number of milliseconds`);
  }
  return value;
};

/** The pull handler of an adapter under a lookback of `lookback` ms. */
const lookbackPull =
  ({ lookback, parse, millis, since, read, positionOf, documentOf }) =>
  async (checkpoint, batchSize) => {
    const mark = parse(checkpoint);
    const markMs = mark === null ? NaN : millis(mark);
    // The run under way reads on; a new one starts `lookback` before the checkpoint.
    let after = mark === null ? null : parse(checkpoint.from);
    if (after === null && mark !== null) after = Number.isNaN(markMs) ? mark : since(markMs - lookback);
    const rows = await read(after, batchSize);
    const documents = [];
    let next = mark;
    let last = null;
    let reread = 0;
    for (let i = 0; i < rows.length; i++) {
      const document = documentOf(rows[i]);
      if (document === null) continue;
      documents.push(document);
      const position = positionOf(rows[i]);
      if (position === null) continue;
      last = position;
      // At or behind the checkpoint: read again. Past it: the checkpoint moves.
      if (millis(position) <= markMs) reread = documents.length;
      else next = position;
    }
    const more = rows.length >= batchSize && last !== null;
    return { documents, checkpoint: more ? { ...next, from: last } : next, reread };
  };

module.exports = { checkLookback, lookbackPull };
