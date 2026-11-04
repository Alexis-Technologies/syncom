'use strict';

// The facade's write helpers (src/database.js lends them its api): an entity's `methods`/`statics` checked against
// what a Document and a Collection answer to already (`checkOrm`), a delete's payload (`tombstone`), an operator
// delta run as the calls it expands to over a transaction's api (`operate`), and `modify(id, fn)` as the difference
// `fn` left (`modifyIn`). Requires document.js, collection.js, operators.js, plugin.js, shape.js, errors.js only.

const { Document } = require('./document.js');
const { Collection } = require('./collection.js');
const { expand } = require('./operators.js');
const { missing } = require('./plugin.js');
const { isPlainObject, asJson, deepEqual } = require('./shape.js');
const { SyncomError } = require('./errors.js');

// An entity's `methods` go on its Documents and its `statics` on its Collection: a name a
// Document or a Collection answers to already would shadow it, so it is refused where the
// definition is taken.
const checkOrm = (def, label) => {
  for (const name of Object.keys(def.methods ?? {})) {
    if (name in Document.prototype || name === 'id') {
      throw new TypeError(`${label}: entity ${def.name}: methods.${name} is a member of every Document already`);
    }
  }
  for (const name of Object.keys(def.statics ?? {})) {
    if (name in Collection.prototype) {
      throw new TypeError(`${label}: entity ${def.name}: statics.${name} is a member of every Collection already`);
    }
  }
};

// A delete's payload: the data the tombstone carries, when given (a plain object).
const tombstone = (data) => {
  if (data === undefined) return {};
  if (!isPlainObject(data)) throw new TypeError('delete() takes a plain object as data');
  return { data };
};

// An operator delta (src/operators.js) inside a transaction: the calls it
// expands to, decided over the record as it reads and the kind of each
// field — both current, the queue being held — run over the transaction's
// write API; a plugin's method the database was not opened with is
// PLUGIN_MISSING. `$set` and the rewrites go as one `set` op, never through
// `update()` again (a field named like an operator is a field here).
const operate = async (api, tx, id, delta, options, view) => {
  const entry = await tx.current(id);
  const calls = expand(delta, view, (field) => tx.kindOf(entry, field));
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const method = call[0];
    if (method === 'update') await tx.commit('set', id, { data: call[1] }, { actor: options.actor });
    else if (method === 'unset') await api.unset(id, call[1], options);
    else if (method === 'inc') await api.inc(id, call[1], call[2], options);
    else if (method === 'add' || method === 'remove') await api[method](id, call[1], call[2], options);
    else if (typeof api[method] !== 'function') throw missing(`${method}()`);
    else if (method === 'push') await api.push(id, call[1], call[2], options);
    else await api.splice(id, call[1], call[2], call[3], undefined, options);
  }
};

// `modify(id, fn)` inside a transaction: `fn` over a copy of the record as it
// reads, inside the queue — nothing lands between the reading and the ops —
// and what it leaves (what it returns, or the copy when it returns nothing)
// written as the ops that take the record there: a field changed is a `set`
// of a register (another kind refuses it, FIELD_KIND), a field gone an
// `unset`, `null` a delete. Resolves to the record as it reads after, or
// null; no record is NOT_FOUND.
const modifyIn = async (tx, id, fn, options) => {
  const before = await tx.get(id);
  if (before === null) throw new SyncomError('NOT_FOUND', `Record ${id} not found`, { id });
  const copy = asJson(before);
  let after = await fn(copy);
  if (after === undefined) after = copy;
  if (after === null) {
    await tx.delete(id, options);
    return null;
  }
  if (!isPlainObject(after)) throw new TypeError('modify() must return an object, null or undefined');
  const delta = {};
  let changed = 0;
  const gone = [];
  for (const key of Object.keys(after)) {
    if (Object.hasOwn(before, key) && deepEqual(before[key], after[key])) continue;
    delta[key] = after[key];
    changed++;
  }
  // The collection is not the function's to change: a `$type` left out stays.
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key) && key !== '$type') gone.push(key);
  if (gone.length > 0) await tx.unset(id, gone, options);
  if (changed > 0) await tx.update(id, delta, options);
  return changed > 0 || gone.length > 0 ? tx.get(id) : before;
};

module.exports = { checkOrm, tombstone, operate, modifyIn };
