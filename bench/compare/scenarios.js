'use strict';

/**
 * The scenarios of the cross-library comparison. Every library keeps a
 * collection of small records — the to-do of every local-first demo — and
 * is asked to do what an application does with it, the way its own
 * documentation shows (bench/compare/adapters):
 *
 * - insert:  add one record to a store of SEED records
 * - update:  change one field of an existing record
 * - get:     read one record by id, as a plain object
 * - inc:     add to a counter that converges when replicas increment it
 *            concurrently (only libraries with such a counter take part)
 * - bulk:    add BULK records in one call or transaction
 * - sync:    a replica that has nothing pulls a store of SEED records and
 *            can read every one of them; the time from the first message to
 *            the last record in place
 * - append, prepend, random: type one character into a text — at its end,
 *            at its start, anywhere (seeded) — the keystrokes of an editor;
 *            only the libraries with a text that merges by position take part
 *            (syncom's text field, Y.Text, Automerge's text, LoroText); the
 *            others show "—". On disk this is the durable line: every
 *            keystroke awaited until the library reports it stored
 * - trace:   replay the automerge-perf editing trace (bench/compare/trace.js)
 *            into one text; a round is the whole trace, the rate is
 *            keystrokes per second
 *
 * Each runs on two lines:
 *
 * - memory: nothing touches the disk — syncom over memory(), the
 *   CRDT libraries' documents, the databases' in-memory storages;
 * - disk: each library's own persistence on node:fs, every write awaited
 *   until the library reports it written (no fsync for anyone: syncom's
 *   `durable` is off by default, and so is LevelDB's `sync`) — for a text,
 *   every keystroke: y-leveldb's `storeUpdate`, Loro's update appended to a
 *   file, automerge-repo's flush, syncom's log append.
 *
 * The cold start (load the library, open a store of SEED records on disk,
 * read one) runs in bench/compare/coldstart-worker.js.
 */

const SEED = 1_000;
const BULK = 1_000;

const recordOf = (i) => ({ title: `Task ${i}`, done: false, priority: i % 5, owner: 'ada', hits: 0 });

const KINDS = [
  {
    id: 'insert',
    title: 'Insert a record',
    description: `Add one record to a store of ${SEED.toLocaleString('en-US')}.`,
    unit: 'ops/s',
    type: 'ops',
  },
  {
    id: 'update',
    title: 'Update a field',
    description: 'Change one field of an existing record.',
    unit: 'ops/s',
    type: 'ops',
  },
  {
    id: 'get',
    title: 'Read a record',
    description: 'Read one record by id, as a plain object.',
    unit: 'ops/s',
    type: 'ops',
  },
  {
    id: 'inc',
    title: 'Increment a counter',
    description: 'Add 1 to a counter that converges when replicas increment it concurrently.',
    unit: 'ops/s',
    type: 'ops',
  },
  {
    id: 'bulk',
    title: `Insert ${BULK.toLocaleString('en-US')} at once`,
    description: `Add ${BULK.toLocaleString('en-US')} records in one call or transaction.`,
    unit: 'records/s',
    type: 'rounds',
  },
  {
    id: 'sync',
    title: 'Replicate a store',
    description:
      `An empty replica pulls a store of ${SEED.toLocaleString('en-US')} records, in process, ` +
      "through the library's own sync protocol, until every record reads back.",
    unit: 'records/s',
    type: 'rounds',
  },
  {
    id: 'append',
    title: 'Type at the end of a text',
    description: 'Insert one character at the end of a text that merges by position — the common keystroke.',
    unit: 'ops/s',
    type: 'ops',
  },
  {
    id: 'prepend',
    title: 'Type at the start of a text',
    description: 'Insert one character at the start of the text — every insert anchors into the same spot.',
    unit: 'ops/s',
    type: 'ops',
  },
  {
    id: 'random',
    title: 'Type anywhere in a text',
    description: 'Insert one character at a random position of the text (seeded).',
    unit: 'ops/s',
    type: 'ops',
  },
  {
    id: 'trace',
    title: 'Replay an editing trace',
    description:
      'The automerge-perf trace: 259,778 keystrokes of a real paper (182,315 inserts, 77,463 deletes) replayed ' +
      'into one text as an editor would send them, the text read back whole at the end.',
    unit: 'ops/s',
    type: 'rounds',
    lines: ['memory'],
  },
];

const LINES = [
  { id: 'memory', title: 'In memory', description: 'Nothing touches the disk.' },
  {
    id: 'disk',
    title: 'On disk',
    description: "Each library's own persistence on node:fs, every write awaited.",
  },
];

const SCENARIOS = [];
for (const kind of KINDS) {
  for (const line of LINES) {
    if (kind.lines && !kind.lines.includes(line.id)) continue;
    SCENARIOS.push({
      id: `${kind.id}-${line.id}`,
      kind: kind.id,
      kindTitle: kind.title,
      line: line.id,
      lineTitle: line.title,
      title: `${kind.title}, ${line.title.toLowerCase()}`,
      description: `${kind.description} ${line.description}`,
      unit: kind.unit,
      type: kind.type,
    });
  }
}

const getScenario = (id) => {
  const scenario = SCENARIOS.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`unknown scenario "${id}"`);
  return scenario;
};

module.exports = { SCENARIOS, KINDS, LINES, SEED, BULK, recordOf, getScenario };
