'use strict';

// The planner (the query plugin's): how a cursor is answered, decided once
// over the collection's declared indexes — the sorted keys the catalog keeps
// (src/catalog.js `scan`). An index serves a query by its longest left prefix
// of fields the query holds an equality on (`field: value`, `$eq`), then a
// `$in` of a few ordered values on the next field (one sub-scan per value),
// then one field more for a range (`$gt`/`$gte`/`$lt`/`$lte`) or the sort;
// the scan comes sorted by the index where the order's keys are the index's
// next fields, in one direction, reaching its end (`sortedByIndex`) — then a
// window is read as far as `offset + limit` and no further. Of several
// indexes the one expected to read the fewest records wins: its scan's
// estimate (the entries between its edges), the smallest posting list of the
// indexed equalities it does not decide (those `narrow` the scan before a
// record is read), the window where sorted; a tie goes to the sorted one,
// then the longer prefix, then the order declared. An index that serves the
// sort alone is taken only for a finite window and where no indexed equality
// could narrow instead. Without a usable index the equalities on indexed
// fields narrow through the posting lists (`postings`), else every record of
// the collection is a candidate (`collection`); a `$text` query is the text
// index's ranking (`text`). Pure: a plan is data, what `explain()` shows; the
// catalog's counts come in as functions. No requires: it ships to the browser.

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// How many values a `$in` may hold for the index to scan it value by value.
const MAX_IN = 16;

// The conjuncts of a query — its top level and every `$and` branch, which
// hold together: per field, one equality value (the first), one `$in` list,
// the range bounds, and whether anything else tests it; `other` for what no
// index can serve (`$or`, `$nor`, `$not`…).
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
      out.fields.set(key, (field = { eq: undefined, in: null, lower: null, upper: null, more: 0 }));
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
        if (field.in === null && Array.isArray(value[op])) field.in = value[op];
        else field.more++;
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

const allOrdered = (values) => {
  for (let i = 0; i < values.length; i++) if (!ordered(values[i])) return false;
  return true;
};

// How an index would serve the query: its prefix of equalities, a `$in` on
// the next field, a range on the one after, whether the sort is the index's.
const fit = (index, fields, order) => {
  const prefix = [];
  let k = 0;
  while (k < index.length) {
    const field = fields.get(index[k]);
    if (field === undefined || field.eq === undefined || !ordered(field.eq)) break;
    prefix.push(field.eq);
    k++;
  }
  // A `$in` of a few ordered values on the next field: one sub-scan per value, in key order.
  let listed = null;
  if (k < index.length) {
    const field = fields.get(index[k]);
    const few = field !== undefined && field.eq === undefined && field.in !== null && field.in.length <= MAX_IN;
    if (few && field.in.length > 0 && allOrdered(field.in)) listed = { field: index[k], values: field.in };
  }
  // The field a range may bound: the one after the prefix, or after the `$in`.
  const at = listed === null ? k : k + 1;
  let range = null;
  if (at < index.length) {
    const field = fields.get(index[at]);
    if (field !== undefined && (field.lower !== null || field.upper !== null)) {
      const okLower = field.lower === null || ordered(field.lower.value);
      const okUpper = field.upper === null || ordered(field.upper.value);
      if (okLower && okUpper) range = { field: index[at], lower: field.lower, upper: field.upper };
    }
  }
  // The sort is the index's where the order's keys are the index's fields from the prefix on (the `$in`
  // field first, where listed), in one direction, AND reach the index's end — a key beyond them would
  // order equal keys by itself, not by id, which is the result's order within equal keys; an order within
  // the prefix alone is no order (every key is equal there). No order: the index serves a whole-key match
  // in id order, which is the result's — not a `$in`, whose sub-scans come value by value.
  let sortedByIndex = false;
  let desc = false;
  if (order.length === 0) sortedByIndex = k === index.length && listed === null;
  else {
    let i = 0;
    while (i < order.length && k + i < index.length && order[i].field === index[k + i]) {
      if (i === 0) desc = order[i].desc;
      else if (order[i].desc !== desc) break;
      i++;
    }
    sortedByIndex = i === order.length && k + i === index.length;
    if (!sortedByIndex) desc = false;
  }
  const usable = k > 0 || listed !== null || range !== null || (sortedByIndex && order.length > 0);
  return { prefix, in: listed, range, sortedByIndex, desc, k, usable };
};

// The smallest of the posting lists named: how many records a narrowing would leave at most.
const smallest = (narrowing, cardinality) => {
  let least = Infinity;
  for (let i = 0; i < narrowing.length; i++) {
    const count = cardinality(narrowing[i].field, narrowing[i].values);
    if (count < least) least = count;
  }
  return least;
};

/**
 * The plan of a cursor: `{ scan, index, prefix, in, range, desc,
 * sortedByIndex, covered, residual, narrow, estimate, uses }` — `scan` one of
 * `text`, `index`, `postings`, `collection`; `index` the key chosen (its
 * fields) or null; `prefix` the equality values it is entered by; `in` the
 * `$in` scanned value by value on the field after them, or null; `range` the
 * bounds on the field after, or null; `residual` whether the predicate still
 * runs over what the scan yields (every conjunct neither the index nor the
 * narrowing decided); `narrow` the indexed equalities the index did not
 * decide, whose posting lists the cursor tests before it reads a record;
 * `estimate` how many records the plan expects to read before the predicate
 * (null where nothing says); `covered` whether nothing but the catalog is
 * read. `indexes` are the collection's declared keys, `indexed` its indexed
 * fields, `covered` decided by the cursor, `wanted` the window
 * (`offset + limit`), and `estimate(made)`, `cardinality(field, values)` and
 * `size()` the catalog's counts (null where there is no catalog to ask).
 */
const plan = ({
  query,
  order,
  indexes,
  indexed,
  covered,
  wanted = Infinity,
  estimate = null,
  cardinality = null,
  size = null,
}) => {
  const made = {
    scan: 'collection',
    index: null,
    prefix: [],
    in: null,
    range: null,
    desc: false,
    sortedByIndex: false,
    covered,
    residual: true,
    narrow: [],
    estimate: null,
  };
  // What the query asks of its fields — an equality, a range, a sort — for an advisor to read.
  const found = conjuncts(query, { fields: new Map(), other: 0 });
  const uses = { equalities: [], ranges: [], order: [] };
  // The indexed fields the query holds an equality or a `$in` on: what narrows a scan, or the posting lists.
  const narrowing = [];
  for (const [field, test] of found.fields) {
    if (test.eq !== undefined || test.in !== null) uses.equalities.push(field);
    if (test.lower !== null || test.upper !== null) uses.ranges.push(field);
    if (indexed.has(field) && (test.eq !== undefined || test.in !== null)) {
      narrowing.push({ field, values: test.eq !== undefined ? [test.eq] : test.in });
    }
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
    // The sort alone: only for a finite window, and where no indexed equality could narrow instead.
    const sortOnly = candidate.k === 0 && candidate.in === null && candidate.range === null;
    if (sortOnly && (wanted === Infinity || narrowing.length > 0)) continue;
    candidate.index = indexes[i];
    // The equalities this index leaves to the posting lists.
    const rest = [];
    for (let n = 0; n < narrowing.length; n++) {
      const field = narrowing[n].field;
      const at = indexes[i].indexOf(field);
      const decided = (at >= 0 && at < candidate.k) || (candidate.in !== null && candidate.in.field === field);
      if (!decided) rest.push(narrowing[n]);
    }
    candidate.narrow = rest;
    // The records read before the predicate: the scan's entries, no more than the narrowest posting list,
    // no more than the window where the rows come sorted. Equal there, the scan that walks fewer entries wins
    // (a narrowing still walks the whole scan), then the sorted one, then the longer prefix, then the order declared.
    const walked =
      estimate === null
        ? Infinity
        : estimate({
            index: indexes[i],
            prefix: candidate.prefix,
            in: candidate.in,
            range: candidate.range,
            desc: false,
          });
    let cost = walked;
    if (rest.length > 0 && cardinality !== null) cost = Math.min(cost, smallest(rest, cardinality));
    if (candidate.sortedByIndex && wanted !== Infinity) cost = Math.min(cost, wanted);
    candidate.cost = cost;
    candidate.walked = walked;
    if (best === null || cost < best.cost) best = candidate;
    else if (cost === best.cost) {
      if (walked < best.walked) best = candidate;
      else if (walked === best.walked) {
        if (candidate.sortedByIndex && !best.sortedByIndex) best = candidate;
        else if (candidate.sortedByIndex === best.sortedByIndex && candidate.k > best.k) best = candidate;
      }
    }
  }
  if (best !== null) {
    made.scan = 'index';
    made.index = best.index;
    made.prefix = best.prefix;
    made.in = best.in;
    made.range = best.range;
    made.desc = best.desc;
    made.sortedByIndex = best.sortedByIndex;
    made.narrow = best.narrow;
    made.estimate = best.cost === Infinity ? null : best.cost;
    // Decided by the index or the narrowing: the prefix's equalities, the `$in`, the range and the narrowed
    // equalities, where nothing else tests those fields; the rest is the predicate's.
    let left = found.other;
    const narrowed = new Set();
    for (let n = 0; n < best.narrow.length; n++) narrowed.add(best.narrow[n].field);
    for (const [field, test] of found.fields) {
      const at = best.index.indexOf(field);
      const plain = test.lower === null && test.upper === null && test.more === 0;
      const byPrefix = at >= 0 && at < best.prefix.length && test.in === null && plain;
      const byIn = best.in !== null && best.in.field === field && test.eq === undefined && plain;
      const byRange =
        best.range !== null &&
        best.range.field === field &&
        test.eq === undefined &&
        test.in === null &&
        test.more === 0;
      const byNarrow = narrowed.has(field) && plain && (test.eq === undefined) !== (test.in === null);
      if (!byPrefix && !byIn && !byRange && !byNarrow) left++;
    }
    made.residual = left > 0;
    return made;
  }
  // An equality or a `$in` on an indexed field: the posting lists narrow (src/catalog.js candidates).
  if (narrowing.length > 0) {
    made.scan = 'postings';
    if (cardinality !== null) made.estimate = smallest(narrowing, cardinality);
  } else if (size !== null) made.estimate = size();
  if (made.scan === 'collection' && order.length === 0) made.sortedByIndex = true;
  return made;
};

module.exports = { plan };
