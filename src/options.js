'use strict';

// `open(options)`, checked and defaulted before a Storage is built: the plain
// values — the backend, the schema and the hooks are normalized by their own
// modules. Every message names the option the way the caller wrote it.

const { isPlainObject } = require('./shape.js');
const { PENDING_MAX, createPlugins } = require('./plugin.js');

const DEFAULT_CACHE = 5000;
const DEFAULT_FLUSH_EVERY = 64;
// A peer's stamp this far ahead of this node's wall clock is a broken clock,
// not a concurrent write: observing it would move every later stamp here —
// and, through replication, everywhere — into the future for good.
const DEFAULT_MAX_SKEW = 86_400_000;

const LOCK_KEYS = ['staleAfter', 'poll', 'timeout'];
const LOCK_KNOWN = new Set(LOCK_KEYS);

// `open({ lock })`: `'fail'` (the default), `'wait'`, `false`, or an object
// `{ mode, staleAfter, poll, timeout }` for the lockfile's knobs. `null`
// here means no lock at all.
const normalizeLock = (lock) => {
  if (lock === false) return null;
  if (lock === undefined || lock === 'fail' || lock === 'wait') return { mode: lock ?? 'fail' };
  if (!isPlainObject(lock)) throw new TypeError("open({ lock }): lock must be 'fail', 'wait', false or an object");
  const { mode = 'fail', ...rest } = lock;
  if (mode !== 'fail' && mode !== 'wait') throw new TypeError("open({ lock }): lock.mode must be 'fail' or 'wait'");
  const options = { mode };
  for (const key of LOCK_KEYS) {
    const value = rest[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !(value > 0)) {
      throw new TypeError(`open({ lock }): lock.${key} must be a positive number`);
    }
    options[key] = value;
  }
  for (const key of Object.keys(rest)) {
    if (!LOCK_KNOWN.has(key)) throw new TypeError(`open({ lock }): unknown key '${key}'`);
  }
  return options;
};

const positiveInteger = (value, message) => {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(message);
  return value;
};

// How long a record file may lag the log by default: one frame.
const DEFAULT_DEFER = 16;

const normalizeStorageOptions = (options) => {
  // `open('./path')` would otherwise open the default directory in silence.
  if (options === null || typeof options !== 'object') {
    throw new TypeError('open() takes an options object: open({ path, ... })');
  }
  const { maxListeners } = options;
  if (maxListeners !== undefined && !(Number.isInteger(maxListeners) && maxListeners > 0)) {
    throw new TypeError('open({ maxListeners }): maxListeners must be a positive integer');
  }
  const lock = normalizeLock(options.lock);
  // The cache keeps the last `cache.max` entries read or written (a live
  // Record pins its own); `integrity: 'lazy'` trusts a record file on the
  // cold read instead of re-verifying it against its block.
  const max = options.cache?.max;
  const cacheMax =
    max === undefined ? DEFAULT_CACHE : positiveInteger(max, 'open({ cache }): cache.max must be a positive integer');
  const { integrity = 'verify' } = options;
  if (integrity !== 'verify' && integrity !== 'lazy') {
    throw new TypeError("open({ integrity }): integrity must be 'verify' or 'lazy'");
  }
  // `chain: false` keeps no hash-linked log of what this node applied —
  // a hub that only replicates has nothing to audit and saves two file
  // writes per record; with no block to check against, reads are lazy.
  if (options.chain !== undefined && typeof options.chain !== 'boolean') {
    throw new TypeError('open({ chain }): chain must be a boolean');
  }
  const chained = options.chain !== false;
  const every = options.catalog?.flushEvery;
  const flushEvery =
    every === undefined
      ? DEFAULT_FLUSH_EVERY
      : positiveInteger(every, 'open({ catalog }): catalog.flushEvery must be a positive integer');
  if (options.getId !== undefined && typeof options.getId !== 'function') {
    throw new TypeError('open({ getId }): getId must be a function');
  }
  // Who writes: a string, or a function asked per write (the signed-in
  // user). It rides on the op as a claim — see Storage#actorOf.
  if (options.actor !== undefined && typeof options.actor !== 'string' && typeof options.actor !== 'function') {
    throw new TypeError('open({ actor }): actor must be a string or a function');
  }
  // The text index behind `$text`: a function asked once per searchable
  // entity — `createSearch()` from @alexify/syncom/search, or your own.
  if (options.search !== undefined && typeof options.search !== 'function') {
    throw new TypeError(
      'open({ search }): search must be a function (entity) => TextIndex — createSearch() from @alexify/syncom/search',
    );
  }
  const scope = options.sync?.scope;
  // How far ahead of this node's clock a peer's stamp may be before the op
  // is refused as malformed rather than observed — see src/apply.js.
  const maxSkew = options.sync?.maxSkew;
  if (maxSkew !== undefined && !(typeof maxSkew === 'number' && maxSkew > 0)) {
    throw new TypeError('open({ sync }): maxSkew must be a positive number of milliseconds (Infinity to disable)');
  }
  // How much pending work a list or text field takes from ops that ran ahead
  // of what they depend on before an op is refused — see src/sequence.js.
  const pendingMax = options.sync?.pendingMax;
  if (pendingMax !== undefined && !((Number.isInteger(pendingMax) && pendingMax > 0) || pendingMax === Infinity)) {
    throw new TypeError('open({ sync }): pendingMax must be a positive integer (Infinity to disable)');
  }
  // Record files may lag the log by this many ms (0: never; 16 by default,
  // a frame): the log is durable at once and a crash replays the batch, so
  // the writes of one record within the window coalesce into one file and
  // one block — see Storage#deferWrite.
  const defer = options.defer;
  if (defer !== undefined && !(Number.isInteger(defer) && defer >= 0)) {
    throw new TypeError('open({ defer }): defer must be a non-negative integer of milliseconds');
  }
  // Signed ops: 'verify' signs this node's and checks a peer's when it
  // carries a signature; 'require' refuses unsigned ones too; false does
  // neither. The node id is the signing key in every mode — see src/apply.js.
  const signatures = options.sync?.signatures;
  if (signatures !== undefined && signatures !== 'verify' && signatures !== 'require' && signatures !== false) {
    throw new TypeError("open({ sync }): signatures must be 'verify', 'require' or false");
  }
  // The plugins this storage runs with — the kinds beyond registers,
  // counters and sets, and the API modules — as one registry per instance
  // (src/plugin.js); nothing is registered process-wide.
  const plugins = createPlugins(options.plugins ?? []);
  return {
    path: options.path || options.name || 'syncom',
    maxListeners,
    durable: options.durable === true,
    lock,
    cacheMax,
    chained,
    verify: chained && integrity === 'verify',
    flushEvery,
    getId: options.getId ?? null,
    actor: options.actor ?? null,
    search: options.search ?? null,
    // Encrypt every record at rest by default; a per-call `{ encrypted }`
    // still overrides. Encrypted records are local — see Storage#saveData.
    encrypted: options.encrypted === true,
    scope: typeof scope === 'function' ? scope : null,
    maxSkew: maxSkew ?? DEFAULT_MAX_SKEW,
    pendingMax: pendingMax ?? PENDING_MAX,
    defer: defer ?? DEFAULT_DEFER,
    signatures: signatures ?? 'verify',
    plugins,
  };
};

module.exports = { normalizeStorageOptions, DEFAULT_DEFER };
