'use strict';

const { SyncomError } = require('./errors.js');
// Hooks and the contained event path. No requires beyond ./errors.js: this
// file is reached from the browser bundle, and scripts/size.js fails on any
// import that is not a relative file.
//
// A hook is one function per name, configured up front (`open({ hooks })`)
// and awaited INSIDE the operation it belongs to: it can alter the operation
// or abort it by throwing. An event is what `on()` subscribes to from the
// outside: many listeners, none of which can affect the operation — a
// listener that throws is logged and forgotten.

class HookError extends SyncomError {
  constructor(hook, cause) {
    super('HOOK_FAILED', `The ${hook} hook failed: ${cause?.message ?? cause}`, { cause, hook });
    this.name = 'HookError';
  }
}

// Unknown names throw: a hook with a typo that silently never runs is a
// validation that silently never runs. One function per name — a return
// value (a replacement, a verdict) could not be chained across a list.
const normalizeHooks = (hooks, allowed, label) => {
  const result = {};
  for (const name of allowed) result[name] = null;
  if (hooks === undefined || hooks === null) return result;
  if (typeof hooks !== 'object' || Array.isArray(hooks)) throw new TypeError(`${label}: hooks must be an object`);
  for (const key of Object.keys(hooks)) {
    if (!allowed.includes(key)) throw new TypeError(`${label}: unknown hook '${key}'`);
    const fn = hooks[key];
    if (fn === undefined || fn === null) continue;
    if (typeof fn !== 'function') throw new TypeError(`${label}: hooks.${key} must be a function`);
    result[key] = fn;
  }
  return result;
};

// Returns what the hook returns; a throw becomes a HookError naming the hook,
// with the original as `cause`. An absent hook is a no-op.
const runHook = async (hooks, name, ...args) => {
  const fn = hooks[name];
  if (!fn) return undefined;
  try {
    return await fn(...args);
  } catch (error) {
    throw new HookError(name, error);
  }
};

// The one way an event leaves the engine. Listeners run at once (the
// Emitter invokes them synchronously) but are never awaited, so a slow
// listener does not hold the mutation queue and one that writes back to the
// storage queues behind the write it heard about instead of deadlocking it.
// A rejection is contained: logged as a warning (it is the application's
// bug, and the application should see it), never surfaced to the caller.
// The count check is what keeps an unhandled `error` from throwing.
const notify = (emitter, logger, event, ...args) => {
  if (emitter.listenerCount(event) === 0) return;
  emitter.emit(event, ...args).catch((err) => {
    logger.warn({ event: 'listener.error', name: event, err });
  });
};

module.exports = { HookError, normalizeHooks, runHook, notify };
