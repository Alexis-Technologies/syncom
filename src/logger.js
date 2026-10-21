'use strict';

// A duck-typed logger writer: a Console, a pino-shaped logger, or `false` to
// go silent. Every level is a function, so callers never guard. No requires:
// shared by both halves as it is.

const NOOP = () => {};

const createLogger = (logger) => {
  if (logger === false || logger === null) return { debug: NOOP, info: NOOP, warn: NOOP, error: NOOP };
  const target = logger ?? globalThis.console;
  const bind = (level) => (typeof target[level] === 'function' ? target[level].bind(target) : NOOP);
  return { debug: bind('debug'), info: bind('info'), warn: bind('warn'), error: bind('error') };
};

module.exports = { createLogger };
