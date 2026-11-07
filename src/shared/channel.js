'use strict';

// The channel between a follower and its leader: `{ call(method, args) }`,
// anything that carries JSON both ways — a wrpc client over a worker port
// (`createSharedChannel` of the wrpc subpath), an in-process pair in tests.
// The leader answers every call as a value, never a transport error:
// `{ ok: true, value }` or `{ ok: false, error: { name, code, message,
// fields } }` (`answerOf`), and the follower makes the error again as it was
// thrown (`revive`: a SyncomError with its code and fields, a TypeError, an
// Error) — so a refusal round-trips over any wire, whatever the wire does
// with a thrown error. A data error's own fields cross (a SyncomError's, a
// ValidationError's, a HookError's); any other error crosses as its name,
// message and code alone — a file system's `path`, `syscall` or `errno` is
// the leader's, not a follower's to read. Requires errors.js only.

const { SyncomError } = require('../errors.js');

const SKIP = new Set(['name', 'message', 'stack', 'cause', 'code']);
// What `revive` never lays on an error: a described field that would swap its prototype or its constructor.
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const DATA_ERRORS = new Set(['SyncomError', 'HookError', 'ValidationError']);

const isChannel = (value) => value !== null && typeof value === 'object' && typeof value.call === 'function';

/** An error as JSON carries it: `{ name, message, code?, fields }` — the fields a data error's alone. */
const describe = (error) => {
  if (error === null || typeof error !== 'object') return { name: 'Error', message: String(error), fields: {} };
  const out = {
    name: typeof error.name === 'string' ? error.name : 'Error',
    message: String(error.message),
    fields: {},
  };
  if (typeof error.code === 'string' || typeof error.code === 'number') out.code = error.code;
  if (DATA_ERRORS.has(out.name)) {
    for (const key of Object.keys(error)) if (!SKIP.has(key) && !UNSAFE.has(key)) out.fields[key] = error[key];
  }
  return out;
};

// The described fields laid on an error: own keys, never one that reaches the prototype or the error's own.
const lay = (target, fields) => {
  for (const key of Object.keys(fields)) if (!UNSAFE.has(key) && !SKIP.has(key)) target[key] = fields[key];
  return target;
};

/** The error `describe` saw, made again. */
const revive = (described) => {
  const fields = described?.fields !== null && typeof described?.fields === 'object' ? described.fields : {};
  const message = String(described?.message ?? 'The leader refused');
  const name = described?.name;
  if (DATA_ERRORS.has(name) && typeof described.code === 'string') {
    return lay(new SyncomError(described.code, message), fields);
  }
  const error = name === 'TypeError' ? new TypeError(message) : new Error(message);
  if (described?.code !== undefined) error.code = described.code;
  return lay(error, fields);
};

/** Runs `fn` and answers what it gave or threw, as a value. */
const answerOf = async (fn) => {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
};

/** The leader's answer opened: its value, or what it threw, thrown again; an answer that is not one is `LEADER_LOST`. */
const unwrap = (answer, method) => {
  if (answer === null || typeof answer !== 'object' || typeof answer.ok !== 'boolean') {
    throw new SyncomError('LEADER_LOST', `The leader answered ${method} with nothing readable`, { method });
  }
  if (answer.ok) return answer.value;
  throw revive(answer.error);
};

/** Calls the leader and gives its value back, or throws what it threw. */
const callLeader = async (channel, method, args) => unwrap(await channel.call(method, args), method);

module.exports = { isChannel, describe, revive, answerOf, unwrap, callLeader };
