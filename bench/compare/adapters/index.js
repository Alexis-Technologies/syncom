'use strict';

/** Every library in the comparison, in the order the tables list them. */
const syncom = require('./syncom.js');
const yjs = require('./yjs.js');
const loro = require('./loro.js');

const ADAPTERS = [
  syncom.pure,
  syncom.secure,
  yjs.plain,
  // Yjs and Loro with every change encoded, as their persistence and sync
  // encode it: the same work syncom's memory line does for each write.
  yjs.encoded,
  require('./automerge.js'),
  loro.plain,
  loro.encoded,
  require('./tinybase.js'),
  require('./pouchdb.js'),
  require('./rxdb.js'),
  require('./fireproof.js'),
  require('./gun.js'),
  require('./orbitdb.js'),
];

const getAdapter = (id) => {
  const adapter = ADAPTERS.find((candidate) => candidate.id === id);
  if (adapter) return adapter;
  const known = ADAPTERS.map((candidate) => candidate.id).join(', ');
  throw new Error(`unknown adapter "${id}" (known: ${known})`);
};

module.exports = { ADAPTERS, getAdapter };
