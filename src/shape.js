'use strict';

// The shapes checked where something enters a storage — a caller's object, a
// record id, an origin or a scope, a peer's op — and the JSON copy taken at
// that boundary. No requires: this file ships to the browser as it is.

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// Data crosses the boundary as JSON — what the disk, the log and the peers
// hold. A copy on the way in (a caller mutating its object after `set()`)
// and on the way out (a caller mutating what `get()` returned) keeps the
// cache, the log entries and the next op's base to themselves.
const asJson = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// A record id is a file name on three platforms, a key in every peer's
// catalog and a line in every peer's log: letters, digits, `.`, `_`, `-`,
// `@`, not starting with a dot, 128 characters at most. Checked where an id
// enters — the local write path, a peer's op, a snapshot record — so
// nothing below has to.
const RECORD_ID = /^[A-Za-z0-9_@-][A-Za-z0-9._@-]{0,127}$/;
const isRecordId = (id) => typeof id === 'string' && RECORD_ID.test(id);
const invalidId = (id) => {
  const shown = typeof id === 'string' ? JSON.stringify(id) : typeof id;
  const error = new TypeError(
    `Invalid record id ${shown}: letters, digits, . _ - @, not starting with a dot, 128 at most`,
  );
  error.code = 'INVALID_ID';
  return error;
};

// An origin or a scope ends up a vector key (`origin@scope`) and a room
// name: a non-empty string without `@` or control characters.
const hasControl = (value) => {
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 32) return true;
  return false;
};
const isStreamName = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('@') && !hasControl(value);

const OP_TYPES = new Set(['write', 'set', 'inc', 'delete', 'merge', 'advance', 'purge']);

// The ops an entity's validator sees: the ones that leave a record for the
// application to read. A `merge` joins a peer's state as it is, a `delete`
// leaves nothing to validate.
const VALIDATED = new Set(['write', 'set', 'inc']);

// The fields the engine indexes a peer's op by, checked before anything here
// reads them. Payloads (`data`, `meta`, `key`, `value`, `vector`) are the
// business of applyOp and normalizeMeta, which take garbage as a no-op;
// `actor` and `from` are claims, carried as they are.
const wellFormed = (op) =>
  isPlainObject(op) &&
  isStreamName(op.origin) &&
  Number.isSafeInteger(op.seq) &&
  op.seq > 0 &&
  Number.isSafeInteger(op.ts) &&
  op.ts > 0 &&
  OP_TYPES.has(op.type) &&
  (op.scope === undefined || isStreamName(op.scope)) &&
  (op.v === undefined || (Number.isInteger(op.v) && op.v >= 1)) &&
  (op.type === 'advance' ? isPlainObject(op.vector) : isRecordId(op.id));

module.exports = { isPlainObject, asJson, isRecordId, invalidId, isStreamName, VALIDATED, wellFormed };
