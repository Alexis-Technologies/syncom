'use strict';

// Every error syncom raises on purpose carries a `code`: a constant a caller
// can switch on without parsing the message, prefixed `ALX_ERR_` as every
// Alexis library's is. Requires argument-errors.js only: this file is reached
// from the browser bundle and by every module that throws; a module that throws
// only the TypeError family requires argument-errors.js alone, which keeps a
// small subpath small.
//
// Four kinds, told apart by class:
//   - a SyncomError is operational — it can happen to correct calling code,
//     given the data, the files or the peers: `ALX_ERR_NOT_FOUND`,
//     `ALX_ERR_CLOSED`, `ALX_ERR_LOCKED`, `ALX_ERR_OP_REFUSED`… Its `code` is
//     one of the constants documented in docs/reference/api.md; extra fields
//     (`op`, `cursor`, `rejected`…) ride on the error, and `cause` is the
//     underlying one. HookError and ValidationError are SyncomErrors with
//     their own fields.
//   - an ArgumentError (a TypeError) is a bug in the calling code — a wrong
//     argument, option, definition or hook result: `ALX_ERR_INVALID_ARGUMENT`.
//     An ArgumentRangeError is the same failure where a RangeError was always
//     thrown (an argument past the range it may take).
//   - a DataError (a TypeError too) is about a value that came from data or
//     configuration rather than from the code that called: an id, a `$type`, a
//     version, a blob past the cap, the chain or a plugin missing. Its code is
//     one of `DataErrorCode`, its `details` what the code documents.
//   - a wire refusal (src/sync/hosting.js) is a plain Error with the numeric
//     `code` wrpc transports (400–429) and a `reason` constant beside it: the
//     protocol's, not an error code of this package.

const { ArgumentError, ArgumentRangeError, DataError } = require('./argument-errors.js');

// What a field riding on an error may never be: the error's own (`name`, `message`, `code`, `stack`) or `__proto__`,
// which would swap its prototype — a field named `name` once renamed a SyncomError to its data.
const RESERVED = new Set(['name', 'message', 'stack', 'cause', 'code', '__proto__']);

// A medium that is full, as the platforms say it: node:fs's ENOSPC, the browser's QuotaExceededError (a DOMException,
// code 22), SQLite's SQLITE_FULL (better-sqlite3's code; node:sqlite's ERR_SQLITE_ERROR with errcode 13) — on the error
// or on a `cause` under it, CAUSE_DEPTH deep. What the log turns into `ALX_ERR_QUOTA` and a landing into
// `ALX_ERR_UNPERSISTED { quota: true }`.
const CAUSE_DEPTH = 8;
const isFull = (e) =>
  e.code === 'ENOSPC' ||
  e.code === 'SQLITE_FULL' ||
  e.name === 'QuotaExceededError' ||
  (e.name === 'DOMException' && e.code === 22) ||
  (e.code === 'ERR_SQLITE_ERROR' && e.errcode === 13);
const isQuotaError = (error) => {
  for (let depth = 0; depth <= CAUSE_DEPTH; depth++) {
    if (error === null || typeof error !== 'object') return false;
    if (isFull(error)) return true;
    error = error.cause;
  }
  return false;
};

const describe = (entity, issues) => {
  const subject = entity === null ? 'Record' : entity;
  const first = issues[0];
  if (!first) return `${subject} failed validation`;
  const where = first.path.length > 0 ? ` at ${first.path.join('.')}` : '';
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : '';
  return `${subject} failed validation${where}: ${first.message}${more}`;
};

class SyncomError extends Error {
  constructor(code, message, { cause, ...fields } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SyncomError';
    this.code = code;
    for (const key of Object.keys(fields)) {
      if (!RESERVED.has(key)) this[key] = fields[key];
    }
    Error.captureStackTrace?.(this, this.constructor);
  }
}

// What a write rejects with when the record would not pass its entity's
// validator, or holds a unique key another record has: `entity` names the
// collection, `issues` are `{ path, message, code? }`. Thrown by the write
// path and by the schema plugin's validator adapters, one class for both.
class ValidationError extends SyncomError {
  constructor(entity, issues) {
    super('ALX_ERR_VALIDATION_FAILED', describe(entity, issues), { entity, issues });
    this.name = 'ValidationError';
  }
}

module.exports = { isQuotaError, SyncomError, ArgumentError, ArgumentRangeError, DataError, ValidationError };
