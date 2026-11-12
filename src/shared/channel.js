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
// the leader's, not a follower's to read (wire-error.js's packError/unpackError). Requires errors.js and wire-error.js only.

const { SyncomError } = require('../errors.js');
const { packError, unpackError } = require('../wire-error.js');

const isChannel = (value) => value !== null && typeof value === 'object' && typeof value.call === 'function';

/** An error as JSON carries it: `{ name, message, code?, fields }` — wire-error.js's `packError`, the fields a data error's alone. */
const describe = packError;
/** The error `describe` saw, made again — wire-error.js's `unpackError`. */
const revive = (described) => unpackError(described, 'The leader refused');

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
