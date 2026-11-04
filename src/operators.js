'use strict';

// The update operators (`update(id, { $set, $unset, $inc, $addToSet, $pull,
// $push, $pop, $min, $max, $rename })`), each laid onto the write API by the
// kind of the field it names — the op model has a method per kind, and an
// operator is only ever a name for one of them: `$inc` is `inc()` on a
// counter (a register refuses it, FIELD_KIND), `$addToSet`/`$pull` are
// `add()`/`remove()` on a set and a last-writer-wins rewrite of an array
// held by a register, `$push`/`$pop` a `push()`/`splice()` on a list and
// a rewrite of a register's array, `$min`/`$max` a `set` only where the
// comparison holds, `$rename` an `unset` and a `set`. A delta is written in
// operators or in fields, never both. `expand` is pure: the calls, decided
// over the record as it reads (`view`) and the kind of each field
// (`kindAt`); the caller runs them inside the queue, where both are
// current. Requires args.js, shape.js and paths.js only: it ships to the browser.

const { fieldName, fieldNames, jsonValue } = require('./args.js');
const { isPlainObject, canonical } = require('./shape.js');
const { valueAt } = require('./paths.js');

const OPERATORS = new Set(['$set', '$unset', '$inc', '$addToSet', '$pull', '$push', '$pop', '$min', '$max', '$rename']);

/**
 * Whether `delta` is written in operators: every key one of them. A delta
 * that mixes operators and fields is a TypeError; one with no key is neither.
 */
const isOperators = (delta) => {
  const keys = Object.keys(delta);
  let operators = 0;
  for (let i = 0; i < keys.length; i++) if (OPERATORS.has(keys[i])) operators++;
  if (operators === 0) return false;
  if (operators !== keys.length) throw new TypeError('update() takes operators ($set, $inc…) or fields, not both');
  return true;
};

const object = (op, value) => {
  if (!isPlainObject(value)) throw new TypeError(`update(): ${op} takes an object of fields`);
  return value;
};

// The elements an operator names: one value, or `{ $each: [...] }` (`$in` for `$pull`).
const elementsOf = (op, value, many) => {
  if (isPlainObject(value) && Object.hasOwn(value, many)) {
    if (!Array.isArray(value[many])) throw new TypeError(`update(): ${op} ${many} takes an array`);
    const out = [];
    for (let i = 0; i < value[many].length; i++) out.push(jsonValue('update', value[many][i]));
    return out;
  }
  return [jsonValue('update', value)];
};

// The elements of an array as a set of their canonical texts (object keys sorted at every depth): what `deepEqual`
// would hold equal, tested in O(1) each.
const textOf = (value) => JSON.stringify(canonical(value));
const setOf = (array) => {
  const out = new Set();
  for (let i = 0; i < array.length; i++) out.add(textOf(array[i]));
  return out;
};

// The kinds `$min`/`$max` compare: a number, a string, a boolean — each with its own.
const comparable = (value) => {
  if (typeof value === 'number') return 1;
  if (typeof value === 'string') return 2;
  if (typeof value === 'boolean') return 3;
  return 0;
};

// Whether `$min`/`$max` writes `value` over `current`: nothing there, or the
// same kind and on the right side of it.
const better = (op, current, value) => {
  if (current === undefined || current === null) return true;
  const kind = comparable(value);
  if (kind === 0 || kind !== comparable(current)) {
    throw new TypeError(`update(): ${op} compares a number, a string or a boolean with a value of the same type`);
  }
  return op === '$min' ? value < current : value > current;
};

/**
 * The calls an operator delta means over a record: `[method, ...args]` each,
 * for the write API less the id — `['update', fields]`, `['unset', names]`,
 * `['inc', field, n]`, `['add' | 'remove', field, elements]`, `['push',
 * field, content]`, `['splice', field, index, count]` — in the order the
 * operators were given, `$set` and the rewrites folded into one `update`
 * last where nothing else touches the field. `view` is the record as it
 * reads (null for none), `kindAt(field)` the kind the field holds
 * (undefined for none). One operator per field: a field two operators name
 * — `$push` and `$pull` of one array, `$set` and `$inc` of one number — is
 * refused, as MongoDB refuses a conflicting update, never two writes whose
 * order decides.
 */
const expand = (delta, view, kindAt) => {
  const calls = [];
  const sets = {};
  let setting = 0;
  const named = new Map();
  const ctx = {
    calls,
    kindAt,
    current: (field) => valueAt(view, field),
    set: (field, value) => {
      sets[field] = value;
      setting++;
    },
    claim: (op, field) => {
      const by = named.get(field);
      if (by !== undefined && by !== op) {
        throw new TypeError(`update(): ${by} and ${op} both name ${field}: one operator per field`);
      }
      named.set(field, op);
    },
  };
  for (const op of Object.keys(delta)) {
    if (!Object.hasOwn(HANDLERS, op)) throw new TypeError(`update(): unknown operator ${op}`);
    HANDLERS[op](ctx, delta[op]);
  }
  if (setting > 0) calls.push(['update', sets]);
  return calls;
};

// `$addToSet`/`$pull`: `add()`/`remove()` on a set or an absent field; a register's array rewritten whole, last
// writer wins, membership by canonical text.
const setOp = (ctx, op, given) => {
  const fields = object(op, given);
  for (const field of Object.keys(fields)) {
    fieldName('update', field);
    ctx.claim(op, field);
    const elements = elementsOf(op, fields[field], op === '$pull' ? '$in' : '$each');
    const array = ctx.current(field);
    if (ctx.kindAt(field) === 'register' && Array.isArray(array)) {
      const next = [];
      if (op === '$pull') {
        const pulled = setOf(elements);
        for (let i = 0; i < array.length; i++) if (!pulled.has(textOf(array[i]))) next.push(array[i]);
      } else {
        const held = setOf(array);
        for (let i = 0; i < array.length; i++) next.push(array[i]);
        for (let i = 0; i < elements.length; i++) {
          const text = textOf(elements[i]);
          if (held.has(text)) continue;
          held.add(text);
          next.push(elements[i]);
        }
      }
      if (next.length !== array.length) ctx.set(field, next);
    } else ctx.calls.push([op === '$pull' ? 'remove' : 'add', field, elements]);
  }
};

// `$min`/`$max`: a set only where the comparison holds.
const minMax = (ctx, op, given) => {
  const fields = object(op, given);
  for (const field of Object.keys(fields)) {
    fieldName('update', field);
    ctx.claim(op, field);
    const value = jsonValue('update', fields[field]);
    if (better(op, ctx.current(field), value)) ctx.set(field, value);
  }
};

// Each operator as a function over the expansion's context — `{ calls, kindAt, current, set, claim }` — and what the
// delta gives it, in the order the delta names them.
const HANDLERS = {
  $set(ctx, given) {
    const fields = object('$set', given);
    for (const field of Object.keys(fields)) {
      fieldName('update', field);
      ctx.claim('$set', field);
      ctx.set(field, jsonValue('update', fields[field]));
    }
  },
  $unset(ctx, given) {
    const names = Array.isArray(given) || typeof given === 'string' ? given : Object.keys(object('$unset', given));
    const unset = fieldNames('update', names);
    for (let i = 0; i < unset.length; i++) ctx.claim('$unset', unset[i]);
    ctx.calls.push(['unset', unset]);
  },
  $inc(ctx, given) {
    const fields = object('$inc', given);
    for (const field of Object.keys(fields)) {
      fieldName('update', field);
      ctx.claim('$inc', field);
      if (!Number.isFinite(fields[field])) throw new TypeError('update(): $inc takes finite numbers');
      ctx.calls.push(['inc', field, fields[field]]);
    }
  },
  $addToSet(ctx, given) {
    setOp(ctx, '$addToSet', given);
  },
  $pull(ctx, given) {
    setOp(ctx, '$pull', given);
  },
  // `$push`: `push()` on a list or a text (a string); a register's array, or an absent field, rewritten as an array.
  $push(ctx, given) {
    const fields = object('$push', given);
    for (const field of Object.keys(fields)) {
      fieldName('update', field);
      ctx.claim('$push', field);
      const kind = ctx.kindAt(field);
      const value = fields[field];
      if (kind === 'text') ctx.calls.push(['push', field, jsonValue('update', value)]);
      else {
        const elements = elementsOf('$push', value, '$each');
        if (kind === 'list') ctx.calls.push(['push', field, elements]);
        else if (kind === 'register' || kind === undefined) {
          const array = ctx.current(field);
          const next = Array.isArray(array) ? array.slice() : [];
          for (let i = 0; i < elements.length; i++) next.push(elements[i]);
          ctx.set(field, next);
        } else ctx.calls.push(['push', field, elements]);
      }
    }
  },
  // `$pop`: a `splice()` of a list's end, a register's array rewritten without it.
  $pop(ctx, given) {
    const fields = object('$pop', given);
    for (const field of Object.keys(fields)) {
      fieldName('update', field);
      ctx.claim('$pop', field);
      const side = fields[field];
      if (side !== 1 && side !== -1) throw new TypeError('update(): $pop takes 1 (the last) or -1 (the first)');
      const array = ctx.current(field);
      if (!Array.isArray(array) || array.length === 0) continue;
      if (ctx.kindAt(field) === 'list') ctx.calls.push(['splice', field, side === 1 ? array.length - 1 : 0, 1]);
      else ctx.set(field, side === 1 ? array.slice(0, -1) : array.slice(1));
    }
  },
  $min(ctx, given) {
    minMax(ctx, '$min', given);
  },
  $max(ctx, given) {
    minMax(ctx, '$max', given);
  },
  // `$rename`: an unset and a set, of a register alone (a counter, a set, a list, a text or a tree is not a register
  // renamed: what `to` would hold is the reading, not the field); a field that is not there renames nothing.
  $rename(ctx, given) {
    const fields = object('$rename', given);
    const names = [];
    for (const field of Object.keys(fields)) {
      fieldName('update', field);
      ctx.claim('$rename', field);
      const to = fields[field];
      fieldName('update', to);
      ctx.claim('$rename', to);
      const kind = ctx.kindAt(field);
      if (kind !== undefined && kind !== 'register') {
        throw new TypeError(`update(): $rename takes a register (${field} holds a ${kind})`);
      }
      const value = ctx.current(field);
      if (value === undefined) continue;
      names.push(field);
      ctx.set(to, value);
    }
    if (names.length > 0) ctx.calls.push(['unset', names]);
  },
};

module.exports = { isOperators, expand };
