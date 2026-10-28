'use strict';

// Every error syncom raises on purpose carries a `code`: a short constant a
// caller can switch on without parsing the message. No requires: this file
// is reached from the browser bundle and by every module that throws.
//
// Three kinds, told apart by class:
//   - a SyncomError is operational — it can happen to correct calling code,
//     given the data, the files or the peers: `NOT_FOUND`, `CLOSED`,
//     `LOCKED`, `CORRUPT`, `OP_REFUSED`… Its `code` is one of the constants
//     documented in docs/reference/api.md; extra fields (`op`, `cursor`,
//     `rejected`…) ride on the error, and `cause` is the underlying one.
//     HookError and ValidationError are SyncomErrors with their own fields.
//   - a TypeError is a bug in the calling code — a wrong argument, option
//     or hook result — and carries no code, except where the value is data
//     (`INVALID_ID`, `TYPE_IMMUTABLE`) or configuration (`NO_CHAIN`).
//   - a wire refusal (src/sync/hosting.js) is a plain Error with the numeric
//     `code` wrpc transports (400–429) and a `reason` constant beside it.

class SyncomError extends Error {
  constructor(code, message, { cause, ...fields } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SyncomError';
    this.code = code;
    Object.assign(this, fields);
    Error.captureStackTrace?.(this, this.constructor);
  }
}

// A TypeError about a value that came from data rather than from the code
// that called — the one kind of TypeError that carries a code.
const typed = (code, message) => Object.assign(new TypeError(message), { code });

const describe = (entity, issues) => {
  const subject = entity === null ? 'Record' : entity;
  const [first] = issues;
  if (!first) return `${subject} failed validation`;
  const where = first.path.length > 0 ? ` at ${first.path.join('.')}` : '';
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : '';
  return `${subject} failed validation${where}: ${first.message}${more}`;
};

// What a write rejects with when the record would not pass its entity's
// validator, or holds a unique key another record has: `entity` names the
// collection, `issues` are `{ path, message, code? }`. Thrown by the write
// path and by the schema plugin's validator adapters, one class for both.
class ValidationError extends SyncomError {
  constructor(entity, issues) {
    super('VALIDATION_FAILED', describe(entity, issues), { entity, issues });
    this.name = 'ValidationError';
  }
}

module.exports = { SyncomError, ValidationError, typed };
