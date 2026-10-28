'use strict';

// The structural check on an injected link — the whole contract the sync
// engine dials through. In its own file so the `@alexify/syncom/wrpc`
// adapter can share it without pulling the engine into a browser bundle.
// `stream` is optional (a binary-capable transport), and so is `send(event,
// data)` — a fire-and-forget event to the host, what presence travels as;
// the host's events reach the engine through `on('syncom/<name>', fn)`.
const isSyncLink = (link) =>
  Boolean(link) &&
  typeof link.call === 'function' &&
  typeof link.subscribe === 'function' &&
  typeof link.on === 'function' &&
  typeof link.off === 'function' &&
  typeof link.close === 'function';

module.exports = { isSyncLink };
