'use strict';

// An error as JSON carries it between two sides of this package — a follower and its leader (src/shared/channel.js),
// the remote engine and the side that serves it (src/engines/remote.js): `{ name, message, code?, fields }`, the fields
// a data error's own (a SyncomError's, a ValidationError's, a HookError's) and nothing of any other error — a file
// system's `path`, `syscall` or `errno` stays where it was thrown. `unpackError` makes the error again as it was
// thrown: a SyncomError with its code and fields, a TypeError, an Error — never a field that is the error's own or
// would swap its prototype. Requires errors.js only.

const { SyncomError } = require('./errors.js');

const RESERVED = new Set(['name', 'message', 'stack', 'cause', 'code']);
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const DATA_ERRORS = new Set(['SyncomError', 'HookError', 'ValidationError']);

const lay = (target, fields) => {
  for (const key of Object.keys(fields)) if (!RESERVED.has(key) && !UNSAFE.has(key)) target[key] = fields[key];
  return target;
};

/** An error as JSON carries it: `{ name, message, code?, fields }`, the fields a data error's alone. */
const packError = (error) => {
  if (error === null || typeof error !== 'object') return { name: 'Error', message: String(error), fields: {} };
  const out = {
    name: typeof error.name === 'string' ? error.name : 'Error',
    message: String(error.message),
    fields: {},
  };
  if (typeof error.code === 'string' || typeof error.code === 'number') out.code = error.code;
  if (DATA_ERRORS.has(out.name)) {
    for (const key of Object.keys(error)) if (!RESERVED.has(key) && !UNSAFE.has(key)) out.fields[key] = error[key];
  }
  return out;
};

/** The error `packError` saw, made again; `fallback` the message where the packed error has none. */
const unpackError = (packed, fallback = 'The other side answered an error') => {
  const fields = packed?.fields !== null && typeof packed?.fields === 'object' ? packed.fields : {};
  const message = String(packed?.message ?? fallback);
  const name = packed?.name;
  if (DATA_ERRORS.has(name) && typeof packed.code === 'string') {
    return lay(new SyncomError(packed.code, message), fields);
  }
  const error = name === 'TypeError' ? new TypeError(message) : new Error(message);
  if (packed?.code !== undefined) error.code = packed.code;
  return lay(error, fields);
};

module.exports = { packError, unpackError };
