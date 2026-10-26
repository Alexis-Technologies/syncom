'use strict';

// Plugins: what `open({ plugins })` registers on ONE storage — never on the
// process. The core keeps records with registers, counters and sets, the log,
// the three write paths and the sync of ops; everything else is a plugin
// module that the core calls through this registry. Two kinds of module,
// both frozen plain objects, like an `fsi` or a `TextIndex`:
//
//   - a KIND module brings field kinds — the sequence engine behind `list`
//     and `text` (@alexify/syncom/text), the movable tree (`/tree`). It
//     names its kinds with their rank in the kinds' precedence, the block
//     codes it reads under `meta.blocks[field].k`, the op types it applies
//     (each one of the protocol's OP_TYPES: the codes on the wire are the
//     core's, so a node without the module still admits, logs and relays the
//     op), the patch actions it realizes, and the functions the core calls:
//       takes(type, payload)                → the kinds the op may land on
//       kindOfOp(op)                        → the op's kind, from the op alone, null if malformed
//       normalize(raw, base, limits)        → a peer's block, bounded, or null
//       apply(entry, field, held, op, stamp, limits)
//                                           → { block, changed, reason?, detail?, count?, max?, hint? }
//       join(a, b)                          → two blocks of one code, joined
//       prune(block, base)                  → the block above a reset, or null
//       render(entry, field, block, hint)   → what data[field] reads as
//       resolve(core, id, type, payload, current)
//                                           → the op's value, inside the queue (null: nothing to write)
//       diff(field, kind, from, to, context)
//                                           → the patches from one reading to another (`context.from`/`.to`:
//                                             the entries, or what a commit event carries, when known)
//       recreate(field, kind, value, context)
//                                           → the patches that make the field from nothing
//       realize(action, patch, method)      → [type, payload] for one of its patch actions
//       migrate(kind, key, value)           → [[type, payload]…] that lay the field again
//       compact(entry, field, kind)         → the patches a compaction lays after recreate
//       values(entry, field)                → what the field holds beside its reading (a text's embed
//                                             markers by index), for the commit event; optional
//       methods                             → { name: (core, id, …args) }, the storage's methods
//       hints                               → { kind: 'a text; use …' }, for FIELD_KIND
//     A block is immutable once it is in an entry and carries `ts`, the
//     newest stamp it holds — what latestClock and isAlive read without
//     knowing the kind.
//   - an API module brings methods and hooks over the core: `open(core)` is
//     called once the core is lent and hands back `{ methods, properties,
//     hooks }` — versions and tags, the sync manager, the schema, queries…
//     `requires` names the modules it needs registered first.
//
// A method of a module this storage was not opened with is a stub on the
// facade that throws PLUGIN_MISSING naming the subpath (`missing`); a
// peer's op of a kind the node lacks is refused as `reason: 'kind'`, logged
// and relayed — a dirk, never a gap. No requires beyond the protocol's op
// types and the error helpers: the registry ships to every entry.

const { OP_TYPES, isPlainObject } = require('./shape.js');
const { typed } = require('./errors.js');

// Pending work — runs waiting for their anchor, cuts and extensions waiting
// for their run, registers and switched-off marks for elements and marks not
// here — is bounded per field (`sync.pendingMax`); the sequence engine reads
// the bound from the limits every apply receives.
const PENDING_MAX = 4096;

// The kinds the core keeps, in order of precedence; a module's ranks start
// after them. The rule reads the ranks alone, which is what makes a clash
// between two kinds commute (src/ops.js yieldTo).
const CORE_RANK = Object.freeze({ register: 0, counter: 1, set: 2 });

// Where an op type, a storage method or a patch action lives: the subpath a
// PLUGIN_MISSING names.
const HOME = Object.freeze({
  splice: 'text',
  assign: 'text',
  move: 'text',
  mark: 'text',
  tree: 'tree',
  push: 'text',
  updateText: 'text',
  unmark: 'text',
  unmarkById: 'text',
  spans: 'text',
  cursor: 'text',
  index: 'text',
  setAt: 'text',
  elementAt: 'text',
  elements: 'text',
  insertEmbed: 'text',
  splitBlock: 'text',
  joinBlock: 'text',
  updateBlock: 'text',
  block: 'text',
  blocks: 'text',
  position: 'text',
  positions: 'text',
  toDelta: 'text',
  applyDelta: 'text',
  treeMove: 'tree',
  treeRemove: 'tree',
  select: 'query',
  count: 'query',
  watch: 'query',
  diff: 'versions',
  restore: 'versions',
  tag: 'versions',
  untag: 'versions',
  tags: 'versions',
  at: 'versions',
  atVersion: 'versions',
  history: 'versions',
  editorOf: 'text',
});

/** The refusal of a call, an op type or a patch action whose plugin is not registered here. */
const missing = (what, home = HOME[what.endsWith('()') ? what.slice(0, -2) : what] ?? null) => {
  const where =
    home === null ? 'a plugin' : `the ${home} plugin: open({ plugins: [${home}] }) from '@alexify/syncom/${home}'`;
  return typed('PLUGIN_MISSING', `${what} needs ${where}`);
};

/** A plugin module: a frozen object with a name, and either kinds (a kind module) or an open() (an API module). */
const isPlugin = (value) =>
  isPlainObject(value) &&
  typeof value.name === 'string' &&
  value.name.length > 0 &&
  (isPlainObject(value.kinds) || typeof value.open === 'function' || typeof value.setup === 'function');

const refuse = (where, message) => {
  throw new TypeError(`${where}: ${message}`);
};

/**
 * The registry of one storage: the modules as given, their kinds by rank,
 * the blocks by code, the op types and patch actions by module, every
 * method by name. Frozen; a TypeError names what a module got wrong.
 */
const createPlugins = (modules, where = 'open({ plugins })') => {
  if (!Array.isArray(modules)) refuse(where, 'plugins must be an array of plugin modules');
  const rank = { ...CORE_RANK };
  const byName = {};
  const byCode = {};
  const byType = {};
  const byAction = {};
  const methods = {};
  const hints = {};
  const names = [];
  const named = new Set();
  const taken = new Set();
  for (const kind of Object.keys(rank)) taken.add(rank[kind]);
  const kinds = [];
  const apis = [];
  for (const mod of modules) {
    if (!isPlugin(mod)) refuse(where, 'not a plugin module (a name, and kinds or open())');
    if (named.has(mod.name)) refuse(where, `plugin '${mod.name}' given twice`);
    for (const need of mod.requires ?? []) {
      if (!named.has(need)) refuse(where, `plugin '${mod.name}' needs '${need}' registered before it`);
    }
    names.push(mod.name);
    named.add(mod.name);
    if (isPlainObject(mod.kinds)) {
      for (const kind of Object.keys(mod.kinds)) {
        const r = mod.kinds[kind];
        if (!Number.isInteger(r) || r < 3) {
          refuse(where, `plugin '${mod.name}': kind ${kind} needs an integer rank of 3 or more`);
        }
        if (Object.hasOwn(rank, kind)) refuse(where, `plugin '${mod.name}': kind ${kind} is already registered`);
        if (taken.has(r)) refuse(where, `plugin '${mod.name}': rank ${r} of ${kind} is taken`);
        rank[kind] = r;
        taken.add(r);
        byName[kind] = mod;
      }
      if (!isPlainObject(mod.codes)) refuse(where, `plugin '${mod.name}' names no block codes`);
      for (const code of Object.keys(mod.codes)) {
        if (Object.hasOwn(byCode, code)) refuse(where, `plugin '${mod.name}': block code '${code}' is taken`);
        if (!Object.hasOwn(mod.kinds, mod.codes[code])) {
          refuse(where, `plugin '${mod.name}': code '${code}' names no kind of its own`);
        }
        byCode[code] = mod;
      }
      if (!Array.isArray(mod.types)) refuse(where, `plugin '${mod.name}' names no op types`);
      for (const type of mod.types) {
        if (!OP_TYPES.has(type)) refuse(where, `plugin '${mod.name}': '${type}' is not an op type of the protocol`);
        if (Object.hasOwn(byType, type)) refuse(where, `plugin '${mod.name}': op type '${type}' is claimed twice`);
        byType[type] = mod;
      }
      for (const action of mod.actions ?? []) {
        if (Object.hasOwn(byAction, action)) {
          refuse(where, `plugin '${mod.name}': patch action '${action}' is claimed twice`);
        }
        byAction[action] = mod;
      }
      for (const kind of Object.keys(mod.hints ?? {})) hints[kind] = mod.hints[kind];
      kinds.push(mod);
    } else {
      apis.push(mod);
    }
    for (const name of Object.keys(mod.methods ?? {})) {
      if (Object.hasOwn(methods, name)) refuse(where, `plugin '${mod.name}': method ${name}() is claimed twice`);
      methods[name] = mod.methods[name];
    }
  }
  return Object.freeze({
    modules: Object.freeze([...modules]),
    names: Object.freeze(names),
    rank: Object.freeze(rank),
    byName: Object.freeze(byName),
    byCode: Object.freeze(byCode),
    byType: Object.freeze(byType),
    byAction: Object.freeze(byAction),
    methods: Object.freeze(methods),
    hints: Object.freeze(hints),
    kinds: Object.freeze(kinds),
    apis: Object.freeze(apis),
  });
};

/** A registry with nothing in it: the core's kinds alone. */
const EMPTY = createPlugins([]);

/** The limits every applyOp receives, defaulted: the pending bound and the registry. */
const limitsOf = (limits) => ({
  pendingMax: limits?.pendingMax ?? PENDING_MAX,
  plugins: limits?.plugins ?? EMPTY,
});

module.exports = { PENDING_MAX, CORE_RANK, HOME, createPlugins, isPlugin, missing, limitsOf, EMPTY };
