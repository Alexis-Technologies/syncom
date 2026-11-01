'use strict';

// A write set as the engine contract shapes it (src/engine.js): every
// namespace, key, tag and piece's name a key, every id one `isId` admits,
// every value a text, a record an object — refused with the member's name.
// What the files engine checks before a key becomes a file name, and a
// served engine (src/engines/remote.js) before a value becomes a filter.
// Requires engine.js only.

const { isKvKey, checkKvKey } = require('./engine.js');

const checkWriteSet = (batch, isId, label) => {
  const fail = (what) => {
    throw new TypeError(`${label}: ${what}`);
  };
  if (batch === null || typeof batch !== 'object') fail('a write set is an object');
  const puts = batch.kv?.put;
  if (puts !== undefined) {
    if (!Array.isArray(puts)) fail('kv.put is a list');
    for (let i = 0; i < puts.length; i++) {
      const put = puts[i];
      if (!Array.isArray(put)) fail('a kv put is [ns, key, value, options]');
      checkKvKey(put[0], put[1], label);
      if (typeof put[2] !== 'string') fail(`kv ${put[0]}/${put[1]}: the value is a text`);
      if (put[3] !== undefined && (put[3] === null || typeof put[3] !== 'object')) fail('kv put options');
    }
  }
  const removals = batch.kv?.remove;
  if (removals !== undefined) {
    if (!Array.isArray(removals)) fail('kv.remove is a list');
    for (let i = 0; i < removals.length; i++) {
      if (!Array.isArray(removals[i])) fail('a kv removal is [ns, key]');
      checkKvKey(removals[i][0], removals[i][1], label);
    }
  }
  const rows = batch.records;
  if (rows !== undefined) {
    if (!Array.isArray(rows)) fail('records is a list');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row === null || typeof row !== 'object') fail('a record row is an object');
      if (!isId(row.id)) fail(`${JSON.stringify(row.id)} is not a record id`);
      const asObject = row.stored !== undefined;
      const asText = row.text !== undefined;
      if (asObject === asText) fail(`record ${row.id}: stored or text, one of them`);
      if (asObject && (row.stored === null || typeof row.stored !== 'object' || Array.isArray(row.stored))) {
        fail(`record ${row.id}: stored is an object`);
      }
      if (asText && typeof row.text !== 'string') fail(`record ${row.id}: text is a text`);
      const pieces = row.pieces;
      if (pieces === undefined) continue;
      if (pieces === null || typeof pieces !== 'object') fail(`record ${row.id}: pieces`);
      const made = pieces.put;
      if (made !== undefined) {
        if (!Array.isArray(made)) fail(`record ${row.id}: pieces.put is a list`);
        for (let k = 0; k < made.length; k++) {
          if (!Array.isArray(made[k]) || !isKvKey(made[k][0]) || typeof made[k][1] !== 'string') {
            fail(`record ${row.id}: a piece is [name, text]`);
          }
        }
      }
      const dropped = pieces.remove;
      if (dropped !== undefined) {
        if (!Array.isArray(dropped)) fail(`record ${row.id}: pieces.remove is a list`);
        for (let k = 0; k < dropped.length; k++) if (!isKvKey(dropped[k])) fail(`record ${row.id}: a piece's name`);
      }
    }
  }
  const removed = batch.remove;
  if (removed !== undefined) {
    if (!Array.isArray(removed)) fail('remove is a list');
    for (let i = 0; i < removed.length; i++) {
      if (!isId(removed[i])) fail(`${JSON.stringify(removed[i])} is not a record id`);
    }
  }
  const copied = batch.copies?.put;
  if (copied !== undefined) {
    if (!Array.isArray(copied)) fail('copies.put is a list');
    for (let i = 0; i < copied.length; i++) {
      const copy = copied[i];
      if (!Array.isArray(copy) || !isKvKey(copy[0]) || !isId(copy[1]) || typeof copy[2] !== 'string') {
        fail('a copy is [tag, id, text]');
      }
    }
  }
  const uncopied = batch.copies?.remove;
  if (uncopied !== undefined) {
    if (!Array.isArray(uncopied)) fail('copies.remove is a list');
    for (let i = 0; i < uncopied.length; i++) {
      if (!Array.isArray(uncopied[i]) || !isKvKey(uncopied[i][0]) || !isId(uncopied[i][1])) fail('a copy is [tag, id]');
    }
  }
  return batch;
};

module.exports = { checkWriteSet };
