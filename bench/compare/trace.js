'use strict';

/**
 * The editing trace of automerge-perf (CC-BY-4.0): 259,778 keystrokes of a
 * real LaTeX paper — 182,315 inserts and 77,463 deletes, a final text of
 * 104,852 characters — the B4 benchmark every CRDT library publishes. The
 * `trace` scenario replays it into one text. The trace is not redistributed:
 * it is downloaded on first use into bench/compare/.cache/ (git-ignored) and
 * read as DATA — the file is a JS module of two literals, `edits` and
 * `finalText`, which JSON.parse reads; nothing downloaded is executed.
 */

const fs = require('node:fs');
const path = require('node:path');

const URL = 'https://raw.githubusercontent.com/automerge/automerge-perf/master/edit-by-index/editing-trace.js';
const CACHE = path.join(__dirname, '.cache');
const FILE = path.join(CACHE, 'editing-trace.js');

const download = async () => {
  const response = await fetch(URL);
  if (!response.ok) throw new Error(`editing trace: ${response.status} ${response.statusText} from ${URL}`);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(FILE, await response.text());
};

// `const edits = [...];` then `const finalText = "...";` then the export line.
const parse = (source) => {
  const edits = source.match(/const edits = (\[[\s\S]*?\n\]);/);
  const finalText = source.match(/const finalText = ("[\s\S]*?");\s*\n\s*if \(typeof module/);
  if (!edits || !finalText) throw new Error('editing trace: not the file shape this reader knows');
  return { edits: JSON.parse(edits[1]), finalText: JSON.parse(finalText[1]) };
};

let cached = null;

/** `{ edits: [[index, deleted, ...inserted], …], finalText }`, downloaded once. */
const loadTrace = async () => {
  if (cached === null) {
    if (!fs.existsSync(FILE)) await download();
    cached = parse(fs.readFileSync(FILE, 'utf8'));
  }
  return cached;
};

module.exports = { loadTrace, URL, FILE };
