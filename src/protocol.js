'use strict';

// What both halves of the sync protocol agree on: the version hello carries,
// the page size a host serves and a dialer pushes by, and the shape of a
// peer's schema in hello. The dialing side is src/sync/manager.js, the hosting side
// src/sync/hosting.js. No requires.

// PROTOCOL 2 is the wire as of the first publication: every op type (`/`,
// `=`, `^`, `*`, `~` among them) and every packOps slot added before it is
// pre-release. 2 is the per-stream hash chain — `prev` in slot 19, in the
// signed header under version 2 — which a node of 1 would relay unchecked
// and could not verify. After publication a new type, or a slot an older
// reader cannot take as null, bumps this number (see src/CLAUDE.md, "packOps
// is 19 positional slots").
const PROTOCOL = 2;
const DEFAULT_PAGE_SIZE = 500;

// The kind plugins a peer runs with, as hello carries them — names — or
// null for a peer that said nothing (a hello from before plugins).
const kindsOf = (value) => {
  if (!Array.isArray(value)) return null;
  const names = [];
  for (let i = 0; i < value.length; i++) {
    const name = value[i];
    if (typeof name === 'string' && name !== '__proto__') names.push(name);
  }
  return names;
};

// A peer's schema as hello carries it — `{ version, hash }` — or null for
// a peer without one (or one speaking a shape this node does not read).
const schemaOf = (value) => {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.version)) return null;
  return { version: value.version, hash: typeof value.hash === 'string' ? value.hash : null };
};

module.exports = { PROTOCOL, DEFAULT_PAGE_SIZE, schemaOf, kindsOf };
