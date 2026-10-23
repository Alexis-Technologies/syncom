'use strict';

// `open(options)`, checked and defaulted before a Storage is built: the plain
// values — the backend, the schema and the hooks are normalized by their own
// modules. Every message names the option the way the caller wrote it.

const { isPlainObject } = require('./shape.js');

const DEFAULT_CACHE = 5000;
const DEFAULT_FLUSH_EVERY = 64;
// A peer's stamp this far ahead of this node's wall clock is a broken clock,
// not a concurrent write: observing it would move every later stamp here —
// and, through replication, everywhere — into the future for good.
const DEFAULT_MAX_SKEW = 86_400_000;

const LOCK_KEYS = ['staleAfter', 'poll', 'timeout'];

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
    if (!LOCK_KEYS.includes(key)) throw new TypeError(`open({ lock }): unknown key '${key}'`);
  }
  return options;
};

const positiveInteger = (value, message) => {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(message);
  return value;
};

const normalizeStorageOptions = (options) => {
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
  // Signed ops: 'verify' signs this node's and checks a peer's when it
  // carries a signature; 'require' refuses unsigned ones too; false does
  // neither. The node id is the signing key in every mode — see src/apply.js.
  const signatures = options.sync?.signatures;
  if (signatures !== undefined && signatures !== 'verify' && signatures !== 'require' && signatures !== false) {
    throw new TypeError("open({ sync }): signatures must be 'verify', 'require' or false");
  }
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
    signatures: signatures ?? 'verify',
  };
};

module.exports = { normalizeStorageOptions };
