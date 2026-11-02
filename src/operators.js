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
 * (undefined for none).
 */
const expand = (delta, view, kindAt) => {
  const calls = [];
  const sets = {};
  let setting = 0;
  const set = (field, value) => {
    sets[field] = value;
    setting++;
  };
  const current = (field) => valueAt(view, field);
  for (const op of Object.keys(delta)) {
    const given = delta[op];
    if (op === '$set') {
      const fields = object(op, given);
      for (const field of Object.keys(fields)) {
        fieldName('update', field);
        set(field, jsonValue('update', fields[field]));
      }
    } else if (op === '$unset') {
      const names = Array.isArray(given) || typeof given === 'string' ? given : Object.keys(object(op, given));
      calls.push(['unset', fieldNames('update', names)]);
    } else if (op === '$inc') {
      const fields = object(op, given);
      for (const field of Object.keys(fields)) {
        fieldName('update', field);
        if (!Number.isFinite(fields[field])) throw new TypeError('update(): $inc takes finite numbers');
        calls.push(['inc', field, fields[field]]);
      }
    } else if (op === '$addToSet' || op === '$pull') {
      const fields = object(op, given);
      for (const field of Object.keys(fields)) {
        fieldName('update', field);
        const elements = elementsOf(op, fields[field], op === '$pull' ? '$in' : '$each');
        const array = current(field);
        if (kindAt(field) === 'register' && Array.isArray(array)) {
          // A register's array: rewritten whole, last writer wins.
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
          if (next.length !== array.length) set(field, next);
        } else calls.push([op === '$pull' ? 'remove' : 'add', field, elements]);
      }
    } else if (op === '$push') {
      const fields = object(op, given);
      for (const field of Object.keys(fields)) {
        fieldName('update', field);
        const kind = kindAt(field);
        const value = fields[field];
        if (kind === 'text') calls.push(['push', field, jsonValue('update', value)]);
        else {
          const elements = elementsOf(op, value, '$each');
          if (kind === 'list') calls.push(['push', field, elements]);
          else if (kind === 'register' || kind === undefined) {
            const array = current(field);
            const next = Array.isArray(array) ? array.slice() : [];
            for (let i = 0; i < elements.length; i++) next.push(elements[i]);
            set(field, next);
          } else calls.push(['push', field, elements]);
        }
      }
    } else if (op === '$pop') {
      const fields = object(op, given);
      for (const field of Object.keys(fields)) {
        fieldName('update', field);
        const side = fields[field];
        if (side !== 1 && side !== -1) throw new TypeError('update(): $pop takes 1 (the last) or -1 (the first)');
        const array = current(field);
        if (!Array.isArray(array) || array.length === 0) continue;
        if (kindAt(field) === 'list') calls.push(['splice', field, side === 1 ? array.length - 1 : 0, 1]);
        else set(field, side === 1 ? array.slice(0, -1) : array.slice(1));
      }
    } else if (op === '$min' || op === '$max') {
      const fields = object(op, given);
      for (const field of Object.keys(fields)) {
        fieldName('update', field);
        const value = jsonValue('update', fields[field]);
        if (better(op, current(field), value)) set(field, value);
      }
    } else if (op === '$rename') {
      const fields = object(op, given);
      const names = [];
      for (const field of Object.keys(fields)) {
        fieldName('update', field);
        const to = fields[field];
        fieldName('update', to);
        const value = current(field);
        if (value === undefined) continue;
        names.push(field);
        set(to, value);
      }
      if (names.length > 0) calls.push(['unset', names]);
    } else throw new TypeError(`update(): unknown operator ${op}`);
  }
  if (setting > 0) calls.push(['update', sets]);
  return calls;
};

module.exports = { OPERATORS, isOperators, expand };
