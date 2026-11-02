'use strict';

// The planner (the query plugin's): how a cursor is answered, decided once
// over the collection's declared indexes — the sorted keys the catalog keeps
// (src/catalog.js `scan`). An index serves a query by its longest left prefix
// of fields the query holds an equality on (`field: value`, `$eq`), then
// one field more for a range (`$gt`/`$gte`/`$lt`/`$lte`) or the sort; the
// scan comes sorted by the index where the order's keys are the index's
// next fields, in one direction (`sortedByIndex`) — then a window is read
// as far as `offset + limit` and no further. Without such an index the
// equalities on indexed fields narrow through the posting lists
// (`postings`), else every record of the collection is a candidate
// (`collection`); a `$text` query is the text index's ranking (`text`).
// Pure: a plan is data, what `explain()` shows. No requires: it ships to the browser.

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// The conjuncts of a query — its top level and every `$and` branch, which
// hold together: per field, one equality value (the first), the range
// bounds, and whether anything else tests it; `other` for what no index
// can serve (`$or`, `$nor`, `$not`, `$in`…).
const conjuncts = (query, out) => {
  for (const key of Object.keys(query)) {
    const value = query[key];
    if (key === '$and') {
      for (let i = 0; i < value.length; i++) conjuncts(value[i], out);
      continue;
    }
    if (key === '$text') continue;
    if (key.startsWith('$')) {
      out.other++;
      continue;
    }
    let field = out.fields.get(key);
    if (field === undefined) {
      out.fields.set(key, (field = { eq: undefined, lower: null, upper: null, more: 0, listed: false }));
    }
    if (!isObject(value)) {
      if (field.eq === undefined) field.eq = value;
      else field.more++;
      continue;
    }
    for (const op of Object.keys(value)) {
      if (op === '$eq' && field.eq === undefined) field.eq = value[op];
      else if (op === '$gt' || op === '$gte') {
        if (field.lower === null) field.lower = { value: value[op], inclusive: op === '$gte' };
        else field.more++;
      } else if (op === '$lt' || op === '$lte') {
        if (field.upper === null) field.upper = { value: value[op], inclusive: op === '$lte' };
        else field.more++;
      } else if (op === '$in') {
        field.listed = true;
        field.more++;
      } else if (op !== '$options') field.more++;
    }
  }
  return out;
};

// Whether a value may be an index key's edge: one of the three ordered kinds.
const ordered = (value) => {
  const type = typeof value;
  return type === 'number' || type === 'string' || type === 'boolean';
};

// How an index would serve the query: its prefix of equalities, a range on
// the next field, whether the sort is the index's, and a score.
const fit = (index, fields, order) => {
  const prefix = [];
  let k = 0;
  while (k < index.length) {
    const field = fields.get(index[k]);
    if (field === undefined || field.eq === undefined || !ordered(field.eq)) break;
    prefix.push(field.eq);
    k++;
  }
  let range = null;
  if (k < index.length) {
    const field = fields.get(index[k]);
    if (field !== undefined && (field.lower !== null || field.upper !== null)) {
      const okLower = field.lower === null || ordered(field.lower.value);
      const okUpper = field.upper === null || ordered(field.upper.value);
      if (okLower && okUpper) range = { field: index[k], lower: field.lower, upper: field.upper };
    }
  }
  // The sort is the index's where the order's keys are the index's fields from the prefix on, in one
  // direction; an order within the prefix alone is no order (every key is equal there). No order:
  // the index serves a whole-key match in id order, which is the result's.
  let sortedByIndex = false;
  let desc = false;
  if (order.length === 0) sortedByIndex = k === index.length;
  else {
    let i = 0;
    while (i < order.length && k + i < index.length && order[i].field === index[k + i]) {
      if (i === 0) desc = order[i].desc;
      else if (order[i].desc !== desc) break;
      i++;
    }
    sortedByIndex = i === order.length;
    if (!sortedByIndex) desc = false;
  }
  const score = k * 4 + (range !== null ? 2 : 0) + (sortedByIndex ? 1 : 0);
  const usable = k > 0 || range !== null || (sortedByIndex && order.length > 0);
  return { prefix, range, sortedByIndex, desc, score, usable };
};

/**
 * The plan of a cursor: `{ scan, index, prefix, range, desc, sortedByIndex,
 * covered, residual }` — `scan` one of `text`, `index`, `postings`,
 * `collection`; `index` the key chosen (its fields) or null; `prefix` the
 * equality values it is entered by; `range` the bounds on the field after
 * them, or null; `residual` whether the predicate still runs over what the
 * scan yields (every conjunct the index did not decide); `covered` whether
 * nothing but the catalog is read. `indexes` are the collection's declared
 * keys, `indexed` its indexed fields, `covered` decided by the cursor.
 */
const plan = ({ query, order, indexes, indexed, covered }) => {
  const made = {
    scan: 'collection',
    index: null,
    prefix: [],
    range: null,
    desc: false,
    sortedByIndex: false,
    covered,
    residual: true,
  };
  // What the query asks of its fields — an equality, a range, a sort — for an advisor to read.
  const found = conjuncts(query, { fields: new Map(), other: 0 });
  const uses = { equalities: [], ranges: [], order: [] };
  for (const [field, test] of found.fields) {
    if (test.eq !== undefined) uses.equalities.push(field);
    if (test.lower !== null || test.upper !== null) uses.ranges.push(field);
  }
  for (let i = 0; i < order.length; i++) uses.order.push(order[i].field);
  made.uses = uses;
  if (query.$text !== undefined) {
    made.scan = 'text';
    made.sortedByIndex = order.length === 0;
    return made;
  }
  let best = null;
  for (let i = 0; i < indexes.length; i++) {
    const candidate = fit(indexes[i], found.fields, order);
    if (!candidate.usable) continue;
    if (best === null || candidate.score > best.score) best = { ...candidate, index: indexes[i] };
  }
  if (best !== null) {
    made.scan = 'index';
    made.index = best.index;
    made.prefix = best.prefix;
    made.range = best.range;
    made.desc = best.desc;
    made.sortedByIndex = best.sortedByIndex;
    // Decided by the index: the prefix's equalities and the range, where nothing else tests those fields.
    let left = found.other;
    for (const [field, test] of found.fields) {
      const at = best.index.indexOf(field);
      const byPrefix =
        at >= 0 && at < best.prefix.length && test.lower === null && test.upper === null && test.more === 0;
      const byRange = best.range !== null && best.range.field === field && test.eq === undefined && test.more === 0;
      if (!byPrefix && !byRange) left++;
    }
    made.residual = left > 0;
    return made;
  }
  // An equality or an `$in` on an indexed field: the posting lists narrow (src/catalog.js candidates).
  for (const [field, test] of found.fields) {
    if (indexed.has(field) && (test.eq !== undefined || test.listed)) {
      made.scan = 'postings';
      break;
    }
  }
  if (made.scan === 'collection' && order.length === 0) made.sortedByIndex = true;
  return made;
};

module.exports = { plan };
